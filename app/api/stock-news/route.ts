import { after, NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { attachStoryGroups } from "@/lib/ai-cluster";
import { claudeEnabled } from "@/lib/claude";
import { collapseSimilarStories, deduplicateFeedItems, groupSimilarStories } from "@/lib/feed-dedupe";
import type { FeedItem } from "@/lib/types";

export const revalidate = 600;
export const maxDuration = 30;

/**
 * 個股相關新聞：只接受市場快照支援的代號，避免被拿來做任意搜尋。
 * 台股用公司名稱搜尋（代號單獨搜容易混入無關結果），美股中英文名稱都搜。
 */
const stockQueries: Record<string, { label: string; query: string }> = {
  TAIEX: { label: "台灣加權指數", query: "台股 (加權指數 OR 大盤)" },
  "2330": { label: "台積電", query: "台積電" },
  "2454": { label: "聯發科", query: "聯發科" },
  "2303": { label: "聯電", query: "聯電 (股價 OR 營收 OR 晶圓)" },
  "2317": { label: "鴻海", query: "鴻海" },
  "2327": { label: "國巨", query: "國巨" },
  "2382": { label: "廣達", query: "廣達 (股價 OR 營收 OR AI 伺服器)" },
  "3231": { label: "緯創", query: "緯創" },
  NVDA: { label: "NVIDIA", query: "(輝達 OR NVIDIA)" },
  AAPL: { label: "Apple", query: "(蘋果 OR Apple) (股價 OR iPhone OR 財報 OR 庫克)" },
  MSFT: { label: "Microsoft", query: "(微軟 OR Microsoft)" }
};

const parser = new XMLParser({ ignoreAttributes: false });
const maxItems = 15;

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

function searchUrl(query: string) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
}

export async function GET(request: NextRequest) {
  const symbol = (request.nextUrl.searchParams.get("symbol") || "").toUpperCase();
  const stock = stockQueries[symbol];
  if (!stock) return NextResponse.json({ error: "不支援的股票代號" }, { status: 400 });

  const url = searchUrl(stock.query);
  try {
    const response = await fetch(url, {
      next: { revalidate: 600 },
      headers: { "User-Agent": "KuangInfoHub/0.1 (+personal news dashboard)" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`Google 新聞回應 ${response.status}`);
    const parsed = parser.parse(await response.text());
    const raw = arrayOf<Record<string, unknown>>(parsed?.rss?.channel?.item).slice(0, 40);

    const items: FeedItem[] = raw.map((item, index) => {
      const link = textOf(item.link);
      const publisher = textOf(item.source);
      const title = textOf(item.title).replace(/\s+-\s+[^-]+$/, "").trim() || "未命名新聞";
      const date = new Date(textOf(item.pubDate) || Date.now());
      return {
        id: `stock-${symbol}-${createHash("sha256").update(link || `${url}#${index}`).digest("base64url").slice(0, 20)}`,
        category: symbol === "NVDA" || symbol === "AAPL" || symbol === "MSFT" ? "finance" : "market",
        source: publisher || "Google 新聞",
        title,
        summary: "",
        url: link || "#",
        publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
        tags: [stock.label],
        // Google 新聞搜尋結果依相關度排序，越前面越相關。
        relevance: Math.max(1, 100 - index * 2)
      };
    });

    // 同一事件的多則報導只留最相關的一則：先用 AI 分組（限時），再加標題比對。
    const unique = deduplicateFeedItems(items);
    const clustered = claudeEnabled() && unique.length > 1 ? await attachStoryGroups(unique, 3000) : null;
    if (clustered?.pending) {
      const pending = clustered.pending;
      after(() => pending.catch(() => undefined));
    }
    const grouped = clustered?.items ?? unique;
    const groups = groupSimilarStories(grouped);
    const collapsed = collapseSimilarStories(grouped.map((item) => ({ item, score: item.relevance })), groups)
      .map(({ item }) => item)
      .sort((left, right) => +new Date(right.publishedAt) - +new Date(left.publishedAt))
      .slice(0, maxItems);

    return NextResponse.json({
      symbol,
      label: stock.label,
      items: collapsed,
      merged: items.length - new Set(groups.values()).size,
      moreUrl: `https://news.google.com/search?q=${encodeURIComponent(stock.query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json({
      symbol,
      label: stock.label,
      items: [],
      error: error instanceof Error ? error.message : "無法取得相關新聞"
    }, { status: 502 });
  }
}
