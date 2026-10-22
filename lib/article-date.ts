import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GoogleDecoder, type DecodeResult } from "google-news-url-decoder";

const decoder = new GoogleDecoder();
const dateCache = new Map<string, { value?: string; expiresAt: number }>();
const SUCCESS_TTL = 6 * 60 * 60 * 1000;
const FAILURE_TTL = 30 * 60 * 1000;

function isPrivateIp(address: string) {
  if (address === "::1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Invalid public article URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Private article URL");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Private article URL");
  }
  return url;
}

async function fetchPublicHtml(initialUrl: string) {
  let current = await validatePublicUrl(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KuangInfoHub/0.1; personal news reader)" },
      signal: AbortSignal.timeout(5000)
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("Too many article redirects");
      current = await validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Article responded ${response.status}`);
    return (await response.text()).slice(0, 2_000_000);
  }
  throw new Error("Unable to read article");
}

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/gi, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&");
}

function validDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(decodeHtml(value.trim()));
  const time = date.getTime();
  const newest = Date.now() + 60 * 60 * 1000;
  if (Number.isNaN(time) || time < Date.UTC(2000, 0, 1) || time > newest) return undefined;
  return date.toISOString();
}

function metadataValues(html: string, key: string) {
  const values: string[] = [];
  const jsonPattern = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, "gi");
  for (const match of html.matchAll(jsonPattern)) values.push(match[1]);

  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)]
        .map((match) => [match[1].toLowerCase(), match[3]])
    );
    const name = (attributes.property || attributes.name || attributes.itemprop || "").toLowerCase();
    if (name === key.toLowerCase() && attributes.content) values.push(attributes.content);
  }
  return values;
}

export function extractArticleDate(html: string) {
  const keys = [
    "dateModified",
    "article:modified_time",
    "datePublished",
    "article:published_time",
    "dateCreated"
  ];
  for (const key of keys) {
    for (const value of metadataValues(html, key)) {
      const date = validDate(value);
      if (date) return date;
    }
  }
  for (const match of html.matchAll(/<time\b[^>]*\bdatetime\s*=\s*(["'])(.*?)\1/gi)) {
    const date = validDate(match[2]);
    if (date) return date;
  }
  return undefined;
}

async function originalArticleDate(url: string) {
  const cached = dateCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = extractArticleDate(await fetchPublicHtml(url));
    dateCache.set(url, { value, expiresAt: Date.now() + (value ? SUCCESS_TTL : FAILURE_TTL) });
    return value;
  } catch {
    dateCache.set(url, { expiresAt: Date.now() + FAILURE_TTL });
    return undefined;
  }
}

export async function resolveGoogleNewsDates(urls: string[]) {
  const result = new Map<string, string>();
  const googleUrls = urls.filter((value) => {
    try {
      return new URL(value).hostname === "news.google.com";
    } catch {
      return false;
    }
  });
  if (!googleUrls.length) return result;

  const decoded = await Promise.all(googleUrls.map(async (url) => {
    try {
      return await Promise.race([
        decoder.decode(url),
        new Promise<DecodeResult>((resolve) => setTimeout(() => resolve({ status: false }), 7000))
      ]);
    } catch {
      return { status: false } satisfies DecodeResult;
    }
  }));
  await Promise.all(decoded.map(async (entry, index) => {
    if (!entry.status || !entry.decoded_url) return;
    const date = await originalArticleDate(entry.decoded_url);
    if (date) result.set(googleUrls[index], date);
  }));
  return result;
}
