import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import type { FeedItem } from "@/lib/types";

/**
 * 英文 AI 新聞的中文摘要。
 *
 * - 只在伺服器端呼叫 Claude，API Key 不會送到瀏覽器。
 * - 每篇新聞依「網址 + 標題 + 內文」產生快取鍵，同一篇只摘要一次。
 * - 只處理伺服器自己抓到的新聞，外部無法藉此網站任意呼叫 Claude。
 */

const model = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const promptVersion = "v1";
const maxExcerpt = 2400;

export type SummaryInput = Pick<FeedItem, "id" | "title" | "url" | "source"> & { excerpt: string };
export type AiSummary = { titleZh: string; summary: string; model: string };

export function aiSummaryEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

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
  description: "記錄這篇新聞的繁體中文標題與摘要。",
  input_schema: {
    type: "object",
    properties: {
      title_zh: { type: "string", description: "自然、精簡的繁體中文標題，保留專有名詞與模型名稱原文。" },
      summary: { type: "string", description: "2 到 3 句繁體中文摘要，約 60 到 120 字。" }
    },
    required: ["title_zh", "summary"]
  }
} as const;

const systemPrompt = [
  "你是台灣使用者的 AI 產業新聞編輯，負責把英文新聞整理成繁體中文（台灣用語）。",
  "只根據提供的標題與內文撰寫，不要補充內文沒有的事實、數字或推測。",
  "摘要要說清楚：發生了什麼、誰發布的、為什麼值得注意。",
  "公司、產品、模型與論文名稱保留英文原文。",
  "如果內文很少，只寫內容能支持的部分，寧可簡短。"
].join("\n");

async function requestSummary(input: SummaryInput): Promise<AiSummary> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY 未設定");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: systemPrompt,
      tools: [summaryTool],
      tool_choice: { type: "tool", name: summaryTool.name },
      messages: [{
        role: "user",
        content: `來源：${input.source}\n標題：${input.title}\n\n內文：\n${input.excerpt || "（來源只提供標題）"}`
      }]
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Claude API ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = await response.json() as { content?: Array<{ type: string; input?: { title_zh?: unknown; summary?: unknown } }> };
  const result = data.content?.find((block) => block.type === "tool_use")?.input;
  const titleZh = typeof result?.title_zh === "string" ? result.title_zh.trim() : "";
  const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
  // 拋出錯誤而不是回傳空值，避免把失敗結果寫進快取。
  if (!titleZh || !summary) throw new Error("Claude 回應缺少摘要內容");
  return { titleZh, summary, model };
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

export async function summarize(input: SummaryInput): Promise<AiSummary> {
  const trimmed = { ...input, excerpt: input.excerpt.slice(0, maxExcerpt) };
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
  const settle = Promise.allSettled([...jobs].map(async ([id, job]) => {
    try {
      done.set(id, await job);
    } catch (error) {
      failed.add(id);
      console.warn("[ai-summary]", id, error instanceof Error ? error.message : error);
    }
  }));
  await Promise.race([settle, new Promise((resolve) => setTimeout(resolve, budgetMs))]);

  const pending = [...jobs].filter(([id]) => !done.has(id) && !failed.has(id)).map(([, job]) => job);
  const enriched = items.map((item) => {
    const summary = done.get(item.id);
    return summary ? { ...item, titleZh: summary.titleZh, summary: summary.summary, aiSummary: true } : item;
  });
  return { items: enriched, summarized: done.size, pending, failed: failed.size };
}
