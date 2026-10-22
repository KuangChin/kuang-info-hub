import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { CustomSource, FeedCategory, FeedItem } from "@/lib/types";

const parser = new XMLParser({ ignoreAttributes: false });
const categories = new Set<FeedCategory>(["market", "finance", "world", "nba", "gaming", "social"]);

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isPrivateIp(address: string) {
  if (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支援 HTTP 或 HTTPS 網址");
  if (url.username || url.password) throw new Error("來源網址不可包含帳號密碼");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("不允許本機或內網來源");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) throw new Error("不允許本機或內網來源");
  return url;
}

async function fetchPublicFeed(initialUrl: string) {
  let current = await validatePublicUrl(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": "KuangInfoHub/0.1 (+personal RSS reader)" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("來源重新導向次數過多");
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`來源回應 ${response.status}`);
    return response.text();
  }
  throw new Error("無法讀取來源");
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return text(object["#text"] ?? object.__cdata ?? "");
  }
  return "";
}

function stripHtml(value: string) {
  return value.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function atomLink(value: unknown) {
  const links = arrayOf(value as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const preferred = links.find((link) => !link["@_rel"] || link["@_rel"] === "alternate") ?? links[0];
  return text(preferred?.["@_href"] ?? preferred);
}

function normalize(source: CustomSource, xml: string): FeedItem[] {
  const parsed = parser.parse(xml);
  const rssItems = arrayOf<Record<string, unknown>>(parsed?.rss?.channel?.item);
  const atomItems = arrayOf<Record<string, unknown>>(parsed?.feed?.entry);
  const items = rssItems.length ? rssItems : atomItems;
  if (!items.length) throw new Error("找不到 RSS 或 Atom 文章");

  return items.slice(0, 8).map((item, index) => {
    const link = rssItems.length ? text(item.link) : atomLink(item.link);
    const title = stripHtml(text(item.title)) || "未命名情報";
    const description = stripHtml(text(item.description ?? item.summary ?? item.content));
    const identity = link || `${source.url}#${index}`;
    const hash = createHash("sha256").update(identity).digest("base64url").slice(0, 24);
    const rawDate = text(item.pubDate ?? item.published ?? item.updated);
    const date = new Date(rawDate || Date.now());
    return {
      id: `custom-${hash}`,
      customSourceId: source.id,
      category: source.category,
      source: source.name,
      title,
      summary: description.slice(0, 180) || `來自 ${source.name} 的最新內容。`,
      url: link || source.url,
      publishedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
      tags: [source.name, "自訂來源"],
      relevance: Math.max(60, 90 - index * 4),
      reason: `來自你新增的「${source.name}」`
    } satisfies FeedItem;
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<CustomSource>;
    const source: CustomSource = {
      id: typeof body.id === "string" && body.id ? body.id : crypto.randomUUID(),
      name: typeof body.name === "string" ? body.name.trim().slice(0, 60) : "",
      url: typeof body.url === "string" ? body.url.trim() : "",
      category: body.category as FeedCategory
    };
    if (!source.name || !source.url || !categories.has(source.category)) {
      return NextResponse.json({ error: "請填寫來源名稱、網址與分類" }, { status: 400 });
    }
    await validatePublicUrl(source.url);
    const xml = await fetchPublicFeed(source.url);
    return NextResponse.json({ source, items: normalize(source, xml) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "無法讀取此來源";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
