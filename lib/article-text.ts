import { fetchPublicHtml, originalArticleUrl } from "@/lib/article-date";

/**
 * 從文章網頁取出正文，讓 AI 摘要不只依靠 RSS 標題。
 * 依序嘗試：JSON-LD 的 articleBody → <article> 內的段落 → 整頁段落；
 * 都太短時退回 og:description／description。
 */

const maxText = 6000;

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–").replace(/&hellip;/gi, "…")
    .replace(/&[lr]squo;/gi, "'").replace(/&[lr]dquo;/gi, "\"")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

const toText = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function metaContent(html: string, key: string) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((match) => [match[1].toLowerCase(), match[3]])
    );
    const name = (attributes.property || attributes.name || "").toLowerCase();
    if (name === key && attributes.content) return toText(attributes.content);
  }
  return "";
}

function jsonLdBody(html: string) {
  for (const match of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const stack: unknown[] = [JSON.parse(match[1])];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) stack.push(...node);
        else if (node && typeof node === "object") {
          const record = node as Record<string, unknown>;
          if (typeof record.articleBody === "string" && record.articleBody.length > 200) return toText(record.articleBody);
          stack.push(...Object.values(record));
        }
      }
    } catch {
      // 格式錯誤的 JSON-LD 直接略過。
    }
  }
  return "";
}

function paragraphs(html: string) {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => toText(match[1]))
    // 過濾按鈕文字、版權宣告這類過短的段落。
    .filter((text) => text.length >= 40 && !/^(copyright|©|all rights reserved|subscribe|sign up|cookie)/i.test(text))
    .join("\n");
}

export function extractArticleText(rawHtml: string) {
  const html = rawHtml
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|noscript|svg|nav|footer|header|form|aside)\b[\s\S]*?<\/\1>/gi, " ");

  const fromJsonLd = jsonLdBody(rawHtml);
  if (fromJsonLd.length >= 300) return fromJsonLd.slice(0, maxText);

  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  const articles = [...withoutScripts.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((match) => paragraphs(match[1]));
  const fromArticle = articles.sort((left, right) => right.length - left.length)[0] || "";
  if (fromArticle.length >= 300) return fromArticle.slice(0, maxText);

  const fromPage = paragraphs(withoutScripts);
  if (fromPage.length >= 300) return fromPage.slice(0, maxText);

  const description = metaContent(rawHtml, "og:description") || metaContent(rawHtml, "description");
  return [fromPage, description].sort((left, right) => right.length - left.length)[0].slice(0, maxText);
}

/** 抓取文章正文；失敗或被網站擋下時回傳空字串，呼叫端改用 RSS 內容。 */
export async function fetchArticleText(url: string) {
  try {
    const original = await originalArticleUrl(url);
    if (!original) return "";
    return extractArticleText(await fetchPublicHtml(original, 6000));
  } catch {
    return "";
  }
}
