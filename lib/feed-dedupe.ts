import type { FeedItem } from "@/lib/types";

function normalizedTitle(title: string) {
  return title
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+[-–—|｜]\s+[^-–—|｜]+$/u, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function canonicalUrl(value: string) {
  try {
    const url = new URL(value);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]
      .forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function bigrams(value: string) {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const a = bigrams(left);
  const b = bigrams(right);
  let overlap = 0;
  a.forEach((gram) => {
    if (b.has(gram)) overlap += 1;
  });
  return (2 * overlap) / (a.size + b.size);
}

function isSameStory(candidate: FeedItem, kept: FeedItem) {
  if (canonicalUrl(candidate.url) === canonicalUrl(kept.url)) return true;
  const left = normalizedTitle(candidate.title);
  const right = normalizedTitle(kept.title);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 14 && longer.includes(shorter)) return true;
  return Math.min(left.length, right.length) >= 12 && diceSimilarity(left, right) >= 0.78;
}

export function deduplicateFeedItems(items: FeedItem[]) {
  const sorted = [...items].sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt));
  return sorted.filter((candidate, index, all) => {
    const candidateTime = +new Date(candidate.publishedAt);
    return !all.slice(0, index).some((kept) => {
      const keptTime = +new Date(kept.publishedAt);
      const withinSevenDays = !Number.isFinite(candidateTime) || !Number.isFinite(keptTime) ||
        Math.abs(candidateTime - keptTime) <= 7 * 24 * 60 * 60 * 1000;
      return withinSevenDays && isSameStory(candidate, kept);
    });
  });
}
