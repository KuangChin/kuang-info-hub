import { NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { demoFeed } from "@/lib/demo-data";
import { deduplicateFeedItems } from "@/lib/feed-dedupe";
import type { FeedCategory, FeedItem } from "@/lib/types";

export const revalidate = 600;

type Source = { name: string; category: FeedCategory; url: string; tags: string[] };

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
  { name: "迷因趨勢", category: "social", url: "https://news.google.com/rss/search?q=%E7%A4%BE%E7%BE%A4%20%E7%86%B1%E9%96%80%20%E8%BF%B7%E5%9B%A0&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", tags: ["社群", "迷因"] }
];

const parser = new XMLParser({ ignoreAttributes: false });

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanTitle(value: string) {
  return value.replace(/\s+-\s+[^-]+$/, "").trim();
}

function createItemId(source: Source, link: string, index: number) {
  const identity = link || `${source.url}#${index}`;
  const hash = createHash("sha256").update(identity).digest("base64url").slice(0, 24);
  return `${source.category}-${hash}`;
}

async function collect(source: Source): Promise<FeedItem[]> {
  const response = await fetch(source.url, {
    next: { revalidate: 600 },
    headers: { "User-Agent": "KuangInfoHub/0.1 (+personal news dashboard)" },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error(`${source.name}: ${response.status}`);
  const parsed = parser.parse(await response.text());
  const items = arrayOf<Record<string, string>>(parsed?.rss?.channel?.item).slice(0, 8);
  return items.map((item, index) => ({
    id: createItemId(source, item.link || "", index),
    category: source.category,
    source: source.name,
    title: cleanTitle(item.title || "未命名情報"),
    summary: `來自${source.name}的最新內容，點擊前往原始來源閱讀全文。`,
    url: item.link || "#",
    publishedAt: new Date(item.pubDate || Date.now()).toISOString(),
    tags: source.tags,
    relevance: Math.max(58, 92 - index * 4),
    reason: `符合你追蹤的「${source.tags[0]}」主題`
  }));
}

export async function GET(request: NextRequest) {
  const category = request.nextUrl.searchParams.get("category");
  const selected = category && category !== "all" ? sources.filter((s) => s.category === category) : sources;
  const settled = await Promise.allSettled(selected.map(collect));
  const live = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const fallback = category && category !== "all" ? demoFeed.filter((item) => item.category === category) : demoFeed;
  const rawItems = live.length ? live : fallback;
  const items = deduplicateFeedItems(rawItems);

  return NextResponse.json({
    items,
    mode: live.length ? "live" : "demo",
    updatedAt: new Date().toISOString(),
    sourceCount: settled.filter((result) => result.status === "fulfilled").length,
    duplicateCount: rawItems.length - items.length
  });
}
