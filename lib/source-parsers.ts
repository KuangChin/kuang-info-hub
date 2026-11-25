import { XMLParser } from "fast-xml-parser";

/** 各種來源整理成同一種格式，方便後續處理。 */
export type SourceEntry = { title: string; link: string; date?: string; excerpt: string };

const parser = new XMLParser({ ignoreAttributes: false });

function arrayOf<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return textOf(object["#text"] ?? object.__cdata ?? "");
  }
  return "";
}

function atomLink(value: unknown) {
  const links = arrayOf(value as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const preferred = links.find((link) => !link["@_rel"] || link["@_rel"] === "alternate") ?? links[0];
  return textOf(preferred?.["@_href"] ?? preferred);
}

/** RSS 2.0 與 Atom（例如 GitHub Releases）都可解析。 */
export function parseFeedEntries(xml: string): SourceEntry[] {
  const parsed = parser.parse(xml);
  const rss = arrayOf<Record<string, unknown>>(parsed?.rss?.channel?.item);
  if (rss.length) {
    return rss.map((item) => ({
      title: textOf(item.title),
      link: textOf(item.link),
      date: textOf(item.pubDate) || undefined,
      excerpt: textOf(item.description ?? item["content:encoded"])
    }));
  }
  return arrayOf<Record<string, unknown>>(parsed?.feed?.entry).map((entry) => ({
    title: textOf(entry.title),
    link: atomLink(entry.link),
    date: textOf(entry.published ?? entry.updated) || undefined,
    excerpt: textOf(entry.content ?? entry.summary)
  }));
}

const months = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December";
const datePattern = new RegExp(`\\b(?:${months})\\.? \\d{1,2}, \\d{4}\\b`);

function plainText(html: string) {
  return html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * 解析 claude.com/resources/articles 文章列表（官網沒有提供 RSS）。
 * 不依賴特定 class 名稱：找出每個文章連結，取連結到下一個連結之間的文字當標題與日期。
 */
export function parseClaudeArticles(html: string, baseUrl: string): SourceEntry[] {
  const anchor = /<a\b[^>]*href=["']((?:https:\/\/(?:www\.)?claude\.com)?\/resources\/articles\/([a-z0-9][a-z0-9-]*))["'][^>]*>/gi;
  const matches = [...html.matchAll(anchor)];
  const seen = new Map<string, SourceEntry>();
  matches.forEach((match, index) => {
    const slug = match[2];
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? Math.min(html.length, start + 4000);
    const segment = html.slice(start, Math.min(end, start + 4000));
    const lines = plainText(segment);
    const date = lines.map((line) => line.match(datePattern)?.[0]).find(Boolean);
    // 標題：段落中第一段夠長、不是日期或按鈕字樣的文字。
    const title = lines.find((line) =>
      line.length >= 12 && !datePattern.test(line) && !/^(article|read more|learn more|view all|see all)$/i.test(line)
    );
    const link = new URL(match[1], baseUrl).toString();
    const current = seen.get(slug);
    // 同一篇可能出現多次（精選＋列表），保留資訊最完整的那次。
    if (!current || (!current.date && date) || (!current.title && title)) {
      seen.set(slug, { title: title || current?.title || "", link, date: date || current?.date, excerpt: "" });
    }
  });
  return [...seen.values()].filter((entry) => entry.title);
}
