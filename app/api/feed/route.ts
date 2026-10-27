import { after, NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { demoFeed } from "@/lib/demo-data";
import { resolveGoogleNewsDates } from "@/lib/article-date";
import { deduplicateFeedItems } from "@/lib/feed-dedupe";
import { attachStoryGroups } from "@/lib/ai-cluster";
import { filterTrendingSocial } from "@/lib/ai-social";
import { signFeedItems } from "@/lib/ai-rank";
import { aiSummaryEnabled, attachSummaries, isMostlyEnglish, stripHtml, type SummaryInput } from "@/lib/ai-summary";
import type { FeedCategory, FeedItem } from "@/lib/types";

export const revalidate = 600;
// 留時間給背景摘要（after）完成並寫入快取。
export const maxDuration = 60;

/** 等待 AI 摘要的最長時間；來不及的會在背景完成，下次載入就看得到。 */
const summaryBudgetMs = 3500;

// limit：每個來源取幾篇；trendingFilter：由 AI 只留下社群上正在爆紅／熱議的內容。
type Source = { name: string; category: FeedCategory; url: string; tags: string[]; limit?: number; trendingFilter?: boolean };
type CollectedItem = FeedItem & { excerpt: string };

const sources: Source[] = [
  { name: "台股新聞", category: "market", url: "https://news.google.com/rss/search?q=%E5%8F%B0%E8%82%A1%20%E7%9B%A4%E5%8B%A2&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["台股", "盤勢"] },
  { name: "全球財經", category: "finance", url: "https://news.google.com/rss/search?q=%E5%85%A8%E7%90%83%20%E8%B2%A1%E7%B6%93&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["財經", "市場"] },
  { name: "NBA", category: "nba", url: "https://news.google.com/rss/search?q=NBA&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["NBA", "籃球"] },
  { name: "MMORPG", category: "gaming", url: "https://news.google.com/rss/search?q=MMORPG&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["MMORPG", "遊戲"] },
  { name: "全球 AI", category: "world", url: "https://news.google.com/rss/search?q=%E5%85%A8%E7%90%83%20AI%20%E4%BA%BA%E5%B7%A5%E6%99%BA%E6%85%A7%20when%3A7d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["AI", "國際", "人工智慧"] },
  { name: "Anthropic 動態", category: "world", url: "https://news.google.com/rss/search?q=Anthropic%20(Claude%20OR%20AI)%20when%3A7d&hl=en-US&gl=US&ceid=US:en", tags: ["AI 技術", "Anthropic", "Claude"] },
  { name: "Hugging Face", category: "world", url: "https://huggingface.co/blog/feed.xml", tags: ["AI 技術", "開源模型", "Hugging Face"] },
  { name: "Google DeepMind", category: "world", url: "https://deepmind.google/blog/rss.xml", tags: ["AI 研究", "前沿技術", "DeepMind"] },
  { name: "OpenAI", category: "world", url: "https://openai.com/news/rss.xml", tags: ["AI 技術", "模型更新", "OpenAI"] },
  { name: "arXiv AI", category: "world", url: "https://export.arxiv.org/rss/cs.AI", tags: ["AI 論文", "研究", "arXiv"] },
  { name: "arXiv Machine Learning", category: "world", url: "https://export.arxiv.org/rss/cs.LG", tags: ["機器學習", "論文", "arXiv"] },
  // Threads／IG 官方 API 無法直接取得熱門貼文，改抓媒體對兩個平台爆紅話題的報導，再由 AI 篩選。
  { name: "Threads 熱議", category: "social", url: "https://news.google.com/rss/search?q=%28Threads%20OR%20%E8%84%86%E5%8F%8B%20OR%20%E8%84%86%E4%B8%8A%29%20%28%E7%B6%B2%E5%8F%8B%20OR%20%E7%86%B1%E8%AD%B0%20OR%20%E7%88%86%E7%B4%85%20OR%20%E7%98%8B%E5%82%B3%20OR%20%E7%AC%91%E7%BF%BB%20OR%20%E6%B4%97%E7%89%88%29%20-Meta%20-%E7%A5%96%E5%85%8B%E6%9F%8F%20when%3A2d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["Threads", "社群"], limit: 12, trendingFilter: true },
  { name: "IG 熱門", category: "social", url: "https://news.google.com/rss/search?q=%28IG%20OR%20Instagram%29%20%28%E7%B6%B2%E5%8F%8B%20OR%20%E7%88%86%E7%B4%85%20OR%20%E7%98%8B%E5%82%B3%20OR%20%E7%AC%91%E7%BF%BB%20OR%20%E6%B4%97%E7%89%88%20OR%20%E6%9B%AC%29%20-Meta%20-%E7%A5%96%E5%85%8B%E6%9F%8F%20when%3A2d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["Instagram", "社群"], limit: 12, trendingFilter: true }
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
    .slice(0, source.limit ?? 8);
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
  // 摘要與「同一事件」分組同時進行，共用同一段等待時間；來不及的在背景完成。
  const clusterEnabled = aiSummaryEnabled() && live.length > 1;
  // 社群來源由 AI 篩選，只留下正在爆紅／熱議的內容。
  const trendingSources = new Set(selected.filter((source) => source.trendingFilter).map((source) => source.name));
  const socialIds = new Set(aiSummaryEnabled() && live.length ? unique.filter((item) => trendingSources.has(item.source)).map((item) => item.id) : []);
  const [summarized, clustered, social] = await Promise.all([
    inputs.size ? attachSummaries(unique, inputs, summaryBudgetMs) : Promise.resolve(null),
    clusterEnabled ? attachStoryGroups(unique, summaryBudgetMs) : Promise.resolve(null),
    socialIds.size ? filterTrendingSocial(unique, socialIds, summaryBudgetMs) : Promise.resolve(null)
  ]);
  const background = [
    ...(summarized?.pending ?? []),
    ...(clustered?.pending ? [clustered.pending] : []),
    ...(social?.pending ? [social.pending] : [])
  ];
  if (background.length) after(() => Promise.allSettled(background));
  const storyIds = new Map((clustered?.items ?? []).flatMap((item) => item.storyId ? [[item.id, item.storyId] as const] : []));
  const keptIds = social ? new Set(social.items.map((item) => item.id)) : null;
  const items = (summarized?.items ?? unique)
    .filter((item) => !keptIds || keptIds.has(item.id))
    .map((item) => storyIds.has(item.id) ? { ...item, storyId: storyIds.get(item.id) } : item);

  return NextResponse.json({
    items: signFeedItems(items),
    mode: live.length ? "live" : "demo",
    updatedAt: new Date().toISOString(),
    sourceCount: settled.filter((result) => result.status === "fulfilled").length,
    duplicateCount: rawItems.length - unique.length,
    aiSummary: {
      enabled: aiSummaryEnabled(),
      eligible: inputs.size,
      summarized: summarized?.summarized ?? 0,
      pending: summarized?.pending.length ?? 0,
      failed: summarized?.failed ?? 0,
      error: summarized?.error || undefined
    },
    aiCluster: {
      enabled: clusterEnabled,
      groups: clustered?.groups ?? 0,
      pending: Boolean(clustered?.pending),
      error: clustered?.error || undefined
    },
    aiSocial: {
      enabled: socialIds.size > 0,
      candidates: socialIds.size,
      kept: social?.kept ?? 0,
      dropped: social?.dropped ?? 0,
      pending: Boolean(social?.pending),
      error: social?.error || undefined
    }
  });
}
