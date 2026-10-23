import { after, NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { demoFeed } from "@/lib/demo-data";
import { resolveGoogleNewsDates } from "@/lib/article-date";
import { deduplicateFeedItems } from "@/lib/feed-dedupe";
import { aiSummaryEnabled, attachSummaries, isMostlyEnglish, stripHtml, type SummaryInput } from "@/lib/ai-summary";
import type { FeedCategory, FeedItem } from "@/lib/types";

export const revalidate = 600;
// 留時間給背景摘要（after）完成並寫入快取。
export const maxDuration = 60;

/** 等待 AI 摘要的最長時間；來不及的會在背景完成，下次載入就看得到。 */
const summaryBudgetMs = 3500;

type Source = { name: string; category: FeedCategory; url: string; tags: string[] };
type CollectedItem = FeedItem & { excerpt: string };

const sources: Source[] = [
  { name: "台股新聞", category: "market", url: "https://news.google.com/rss/search?q=%E5%8F%B0%E8%82%A1%20%E7%9B%A4%E5%8B%A2&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["台股", "盤勢"] },
  { name: "全球財經", category: "finance", url: "https://news.google.com/rss/search?q=%E5%85%A8%E7%90%83%20%E8%B2%A1%E7%B6%93&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["財經", "市場"] },
  { name: "NBA", category: "nba", url: "https://news.google.com/rss/search?q=NBA&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["NBA", "籃球"] },
  { name: "MMORPG", category: "gaming", url: "https://news.google.com/rss/search?q=MMORPG&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["MMORPG", "遊戲"] },
  { name: "全球 AI", category: "world", url: "https://news.google.com/rss/search?q=%E5%85%A8%E7%90%83%20AI%20%E4%BA%BA%E5%B7%A5%E6%99%BA%E6%85%A7%20when%3A7d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["AI", "國際", "人工智慧"] },
  { name: "Hugging Face", category: "world", url: "https://huggingface.co/blog/feed.xml", tags: ["AI 技術", "開源模型", "Hugging Face"] },
  { name: "Google DeepMind", category: "world", url: "https://deepmind.google/blog/rss.xml", tags: ["AI 研究", "前沿技術", "DeepMind"] },
  { name: "OpenAI", category: "world", url: "https://openai.com/news/rss.xml", tags: ["AI 技術", "模型更新", "OpenAI"] },
  { name: "arXiv AI", category: "world", url: "https://export.arxiv.org/rss/cs.AI", tags: ["AI 論文", "研究", "arXiv"] },
  { name: "arXiv Machine Learning", category: "world", url: "https://export.arxiv.org/rss/cs.LG", tags: ["機器學習", "論文", "arXiv"] },
  { name: "迷因趨勢", category: "social", url: "https://news.google.com/rss/search?q=%28%22%E7%A4%BE%E7%BE%A4%E7%82%B8%E9%8D%8B%22+OR+%22%E7%B6%B2%E8%B7%AF%E7%86%B1%E8%AD%B0%22+OR+%22%E8%BF%B7%E5%9B%A0%22%29+when%3A3d&hl=zh-TW&gl=TW&ceid=TW%3Azh-Hant", tags: ["社群", "迷因"] }
];

const parser = new XMLParser({ ignoreAttributes: false });

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return textOf(object["#text"] ?? object.__cdata ?? "");
  }
  return "";
}

function cleanTitle(value: string) {
  return value.replace(/\s+-\s+[^-]+$/, "").trim();
}

function createItemId(source: Source, link: string, index: number) {
  const identity = link || `${source.url}#${index}`;
  const hash = createHash("sha256").update(identity).digest("base64url").slice(0, 24);
  return `${source.category}-${hash}`;
}

function arxivId(value: string) {
  try {
    const match = new URL(value).pathname.match(/\/abs\/([^/]+)/);
    return match?.[1]?.replace(/v\d+$/, "");
  } catch {
    return undefined;
  }
}

async function resolveArxivDates(items: Array<Record<string, string>>, forceRefresh: boolean) {
  const ids = items.map((item) => arxivId(item.link || "")).filter((id): id is string => !!id);
  const dates = new Map<string, string>();
  if (!ids.length) return dates;

  try {
    const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ids.join(","))}`, {
      ...(forceRefresh ? { cache: "no-store" as const } : { next: { revalidate: 600 } }),
      headers: { "User-Agent": "KuangInfoHub/0.1 (+personal news dashboard)" },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) return dates;
    const parsed = parser.parse(await response.text());
    const entries = arrayOf<Record<string, string>>(parsed?.feed?.entry);
    entries.forEach((entry) => {
      const id = arxivId(entry.id || "");
      const published = new Date(entry.published || "");
      if (id && !Number.isNaN(published.getTime())) dates.set(id, published.toISOString());
    });
  } catch {
    // arXiv API 暫時無法讀取時，保留 RSS 的公告日期。
  }
  return dates;
}

async function collect(source: Source, forceRefresh = false): Promise<CollectedItem[]> {
  const response = await fetch(source.url, {
    ...(forceRefresh ? { cache: "no-store" as const } : { next: { revalidate: 600 } }),
    headers: { "User-Agent": "KuangInfoHub/0.1 (+personal news dashboard)" },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`${source.name}: ${response.status}`);
  const parsed = parser.parse(await response.text());
  const items = arrayOf<Record<string, string>>(parsed?.rss?.channel?.item)
    .sort((left, right) => +new Date(right.pubDate || 0) - +new Date(left.pubDate || 0))
    .slice(0, 8);
  const [originalDates, arxivDates] = await Promise.all([
    resolveGoogleNewsDates(items.map((item) => item.link || "")),
    resolveArxivDates(items, forceRefresh)
  ]);
  return items.map((item, index) => ({
    id: createItemId(source, item.link || "", index),
    category: source.category,
    source: source.name,
    title: cleanTitle(item.title || "未命名情報"),
    summary: `來自${source.name}的最新內容，點擊前往原始來源閱讀全文。`,
    url: item.link || "#",
    publishedAt: originalDates.get(item.link || "") ||
      arxivDates.get(arxivId(item.link || "") || "") ||
      new Date(item.pubDate || Date.now()).toISOString(),
    tags: source.tags,
    relevance: Math.max(58, 92 - index * 4),
    reason: `符合你追蹤的「${source.tags[0]}」主題`,
    excerpt: stripHtml(textOf(item.description ?? item["content:encoded"] ?? ""))
  }));
}

export async function GET(request: NextRequest) {
  const category = request.nextUrl.searchParams.get("category");
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const selected = category && category !== "all" ? sources.filter((s) => s.category === category) : sources;
  const settled = await Promise.allSettled(selected.map((source) => collect(source, forceRefresh)));
  const collected = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const excerpts = new Map(collected.map((item) => [item.id, item.excerpt]));
  const live: FeedItem[] = collected.map((item) => {
    const { excerpt, ...rest } = item;
    void excerpt;
    return rest;
  });
  const fallback = category && category !== "all" ? demoFeed.filter((item) => item.category === category) : demoFeed;
  const rawItems = live.length ? live : fallback;
  const unique = deduplicateFeedItems(rawItems);

  // 英文的 AI 新聞交給 Claude 產生繁中標題與摘要。
  const inputs = new Map<string, SummaryInput>();
  if (aiSummaryEnabled() && live.length) {
    unique.forEach((item) => {
      const excerpt = excerpts.get(item.id) || "";
      if (item.category === "world" && isMostlyEnglish(item.title, excerpt)) {
        inputs.set(item.id, { id: item.id, title: item.title, url: item.url, source: item.source, excerpt });
      }
    });
  }
  const summarized = inputs.size ? await attachSummaries(unique, inputs, summaryBudgetMs) : null;
  if (summarized?.pending.length) after(() => Promise.allSettled(summarized.pending));
  const items = summarized?.items ?? unique;

  return NextResponse.json({
    items,
    mode: live.length ? "live" : "demo",
    updatedAt: new Date().toISOString(),
    sourceCount: settled.filter((result) => result.status === "fulfilled").length,
    duplicateCount: rawItems.length - items.length,
    aiSummary: {
      enabled: aiSummaryEnabled(),
      eligible: inputs.size,
      summarized: summarized?.summarized ?? 0,
      pending: summarized?.pending.length ?? 0,
      failed: summarized?.failed ?? 0,
      error: summarized?.error || undefined
    }
  });
}
