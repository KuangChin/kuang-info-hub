import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { fetchArticleText } from "@/lib/article-text";
import { callClaudeTool, claudeEnabled, claudeModel } from "@/lib/claude";
import type { FeedItem } from "@/lib/types";

/**
 * 英文 AI 新聞的中文摘要。
 *
 * - 只在伺服器端呼叫 Claude，API Key 不會送到瀏覽器。
 * - 每篇新聞依「網址 + 標題 + 內文」產生快取鍵，同一篇只摘要一次。
 * - 只處理伺服器自己抓到的新聞，外部無法藉此網站任意呼叫 Claude。
 */

const model = claudeModel;
const promptVersion = "v3";
const maxExcerpt = 8000;
/** RSS 內容少於這個長度時，改抓原文網頁的正文。 */
const fullTextThreshold = 400;

export type SummaryInput = Pick<FeedItem, "id" | "title" | "url" | "source"> & { excerpt: string };
/** basis：full＝讀過正文；title＝只有標題或簡短介紹可用 */
export type TechConcept = { term: string; explanation: string };
export type AiSummary = {
  titleZh: string;
  summary: string;
  /** 重點條列：具體的事實、數字、時間與影響 */
  keyPoints: string[];
  /** 技術核心概念：用白話解釋文章中的關鍵技術 */
  techConcepts: TechConcept[];
  /** 為什麼值得注意 */
  whyItMatters: string;
  model: string;
  basis: "full" | "title";
};

export const aiSummaryEnabled = claudeEnabled;

export function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** 標題與內文以英文為主（幾乎沒有中日韓文字）才需要摘要。 */
export function isMostlyEnglish(...texts: string[]) {
  const value = texts.join(" ");
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const cjk = (value.match(/[぀-ヿ㐀-鿿豈-﫿]/g) || []).length;
  return latin >= 15 && cjk / (latin + cjk) < 0.05;
}

const summaryTool = {
  name: "record_summary",
  description: "記錄這篇新聞的繁體中文標題、摘要與重點整理。",
  input_schema: {
    type: "object",
    properties: {
      title_zh: { type: "string", description: "自然、精簡的繁體中文標題，保留專有名詞與模型名稱原文。" },
      summary: { type: "string", description: "2 到 3 句繁體中文摘要，約 60 到 120 字，讓人一眼知道發生什麼事。" },
      key_points: {
        type: "array",
        description: "3 到 5 個重點，每點一句，寫具體內容：誰、做了什麼、關鍵數字（效能、價格、規模、日期）、適用範圍或限制。內文只有標題時給空陣列。",
        items: { type: "string" }
      },
      tech_concepts: {
        type: "array",
        description: "文章涉及的 1 到 3 個技術核心概念（例如模型架構、訓練方法、演算法、硬體或協定）。沒有技術內容時給空陣列。",
        items: {
          type: "object",
          properties: {
            term: { type: "string", description: "概念名稱，保留英文原名，可附中文，例如「Mixture of Experts（混合專家）」" },
            explanation: { type: "string", description: "用 2 到 3 句白話說明它是什麼、怎麼運作，以及在這則新聞中扮演什麼角色" }
          },
          required: ["term", "explanation"]
        }
      },
      why_it_matters: { type: "string", description: "一句話說明為什麼值得注意：對產業、開發者或使用者的影響。資訊不足時給空字串。" }
    },
    required: ["title_zh", "summary", "key_points", "tech_concepts", "why_it_matters"]
  }
};

const systemPrompt = [
  "你是台灣使用者的 AI 產業新聞編輯，負責把英文新聞整理成繁體中文（台灣用語）。",
  "只根據提供的標題與內文撰寫，不要補充內文沒有的事實、數字或推測。",
  "摘要要說清楚：發生了什麼、誰發布的、為什麼值得注意。",
  "重點要具體，優先整理數字、規格、比較基準、時程與限制，不要重複摘要的句子。",
  "技術核心概念要讓有基本科技常識、但不是該領域專家的讀者看懂：先說它是什麼，再說怎麼運作，最後連回這則新聞。",
  "解釋技術概念時可以用一般知識說明概念本身，但關於這則新聞的事實只能來自內文。",
  "公司、產品、模型與論文名稱保留英文原文。",
  "如果只有標題或很短的介紹，就根據標題寫 1 句簡短說明。",
  "不要提到內文缺漏、無法閱讀全文或資訊不足，直接寫能確定的內容。"
].join("\n");

async function requestSummary(input: SummaryInput): Promise<AiSummary> {
  const result = await callClaudeTool({
    system: systemPrompt,
    tool: summaryTool,
    maxTokens: 1800,
    user: `來源：${input.source}\n標題：${input.title}\n\n內文：\n${input.excerpt || "（無）"}`
  });
  const titleZh = typeof result.title_zh === "string" ? result.title_zh.trim() : "";
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  // 拋出錯誤而不是回傳空值，避免把失敗結果寫進快取。
  if (!titleZh || !summary) throw new Error("Claude 回應缺少摘要內容");
  const basis = input.excerpt.length >= 300 ? "full" : "title";
  const strings = (value: unknown, max: number) => (Array.isArray(value) ? value : [])
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, max);
  const techConcepts = (Array.isArray(result.tech_concepts) ? result.tech_concepts : [])
    .flatMap((entry) => {
      const { term, explanation } = (entry ?? {}) as { term?: unknown; explanation?: unknown };
      return typeof term === "string" && typeof explanation === "string" && term.trim() && explanation.trim()
        ? [{ term: term.trim(), explanation: explanation.trim() }]
        : [];
    })
    .slice(0, 3);
  return {
    titleZh,
    summary,
    // 只有標題可用時不顯示重點與技術概念，避免模型憑標題猜測內容。
    keyPoints: basis === "full" ? strings(result.key_points, 5) : [],
    techConcepts: basis === "full" ? techConcepts : [],
    whyItMatters: basis === "full" && typeof result.why_it_matters === "string" ? result.why_it_matters.trim() : "",
    model,
    basis
  };
}

// 同一個伺服器實例內也記住結果，減少重複讀取快取。
const memory = new Map<string, AiSummary>();

export function summaryKey(input: SummaryInput) {
  return createHash("sha256")
    .update([promptVersion, model, input.url, input.title, input.excerpt].join("\n"))
    .digest("base64url")
    .slice(0, 32);
}

const cachedSummary = unstable_cache(
  async (_key: string, input: SummaryInput) => requestSummary(input),
  ["ai-summary", promptVersion],
  { revalidate: false, tags: ["ai-summary"] }
);

// 原文正文快取 6 小時；暫時抓不到的文章之後會再試，抓到後會產生新的摘要。
const cachedArticleText = unstable_cache(
  async (url: string) => fetchArticleText(url),
  ["article-text", "v1"],
  { revalidate: 60 * 60 * 6, tags: ["article-text"] }
);

async function bestExcerpt(input: SummaryInput) {
  if (input.excerpt.length >= fullTextThreshold) return input.excerpt;
  const article = await cachedArticleText(input.url).catch(() => "");
  return article.length > input.excerpt.length ? article : input.excerpt;
}

export async function summarize(input: SummaryInput): Promise<AiSummary> {
  const trimmed = { ...input, excerpt: (await bestExcerpt(input)).slice(0, maxExcerpt) };
  const key = summaryKey(trimmed);
  const hit = memory.get(key);
  if (hit) return hit;
  const result = await cachedSummary(key, trimmed);
  memory.set(key, result);
  return result;
}

/**
 * 在時間預算內盡量附上摘要；來不及完成的會回傳 pending，
 * 呼叫端可交給 after() 在回應送出後繼續完成並寫入快取。
 */
export async function attachSummaries(items: FeedItem[], inputs: Map<string, SummaryInput>, budgetMs: number) {
  const jobs = new Map<string, Promise<AiSummary>>();
  inputs.forEach((input, id) => {
    const job = summarize(input);
    job.catch(() => undefined);
    jobs.set(id, job);
  });

  const done = new Map<string, AiSummary>();
  const failed = new Set<string>();
  let lastError = "";
  const settle = Promise.allSettled([...jobs].map(async ([id, job]) => {
    try {
      done.set(id, await job);
    } catch (error) {
      failed.add(id);
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("[ai-summary]", id, lastError);
    }
  }));
  await Promise.race([settle, new Promise((resolve) => setTimeout(resolve, budgetMs))]);

  const pending = [...jobs].filter(([id]) => !done.has(id) && !failed.has(id)).map(([, job]) => job);
  const enriched = items.map((item) => {
    const summary = done.get(item.id);
    return summary ? {
      ...item,
      titleZh: summary.titleZh,
      summary: summary.summary,
      aiSummary: true,
      summaryBasis: summary.basis,
      keyPoints: summary.keyPoints.length ? summary.keyPoints : undefined,
      techConcepts: summary.techConcepts.length ? summary.techConcepts : undefined,
      whyItMatters: summary.whyItMatters || undefined
    } : item;
  });
  return { items: enriched, summarized: done.size, pending, failed: failed.size, error: lastError };
}
