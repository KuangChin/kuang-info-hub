import type { FeedItem } from "@/lib/types";

/**
 * 重複與類似新聞的處理分兩步：
 * 1. deduplicateFeedItems：只移除「同一個網址」的完全重複（同一篇文章出現在多個來源）。
 * 2. groupSimilarStories：把報導同一事件的新聞歸成同一組，
 *    等評分完成後由 collapseSimilarStories 每組只留最高分的一則。
 *    分組依據：伺服器 AI 判斷的 storyId，加上標題幾乎相同的規則比對。
 */

const DAY = 24 * 60 * 60 * 1000;

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

function diceSimilarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  a.forEach((gram) => {
    if (b.has(gram)) overlap += 1;
  });
  return (2 * overlap) / (a.size + b.size);
}

/** 只移除同一網址的重複文章，保留最新的一筆。 */
export function deduplicateFeedItems(items: FeedItem[]) {
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
    .filter((item) => {
      const key = canonicalUrl(item.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** 標題幾乎相同（含一方包含另一方）且發布時間相近，視為同一則報導。 */
function similarTitles(left: { title: string; grams: Set<string>; time: number }, right: { title: string; grams: Set<string>; time: number }) {
  if (Number.isFinite(left.time) && Number.isFinite(right.time) && Math.abs(left.time - right.time) > 7 * DAY) return false;
  if (!left.title || !right.title) return false;
  if (left.title === right.title) return true;
  const shorter = left.title.length <= right.title.length ? left.title : right.title;
  const longer = shorter === left.title ? right.title : left.title;
  if (shorter.length >= 14 && longer.includes(shorter)) return true;
  return shorter.length >= 12 && diceSimilarity(left.grams, right.grams) >= 0.78;
}

/**
 * 回傳每篇新聞所屬的組別代號；同組代表報導同一事件。
 * 沒有類似新聞的文章，組別就是自己的 id。
 */
export function groupSimilarStories(items: FeedItem[]) {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // 路徑壓縮，讓之後的查詢更快。
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node) as string;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  items.forEach((item) => parent.set(item.id, item.id));

  // AI 判斷的同一事件
  const byStory = new Map<string, string>();
  items.forEach((item) => {
    if (!item.storyId) return;
    const first = byStory.get(item.storyId);
    if (first) union(first, item.id);
    else byStory.set(item.storyId, item.id);
  });

  // 標題幾乎相同的規則比對（自訂來源也適用）
  const prepared = items.map((item) => {
    const title = normalizedTitle(item.title);
    return { id: item.id, title, grams: bigrams(title), time: +new Date(item.publishedAt) };
  });
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      if (similarTitles(prepared[i], prepared[j])) union(prepared[i].id, prepared[j].id);
    }
  }

  return new Map(items.map((item) => [item.id, find(item.id)]));
}

export type ScoredItem = { item: FeedItem; score: number };

/**
 * 每組只保留分數最高的一則（同分取較新的），
 * 並在保留的那則記下另外幾則類似報導的數量與來源。
 */
export function collapseSimilarStories(scored: ScoredItem[], groups: Map<string, string>) {
  const best = new Map<string, ScoredItem>();
  const members = new Map<string, ScoredItem[]>();
  scored.forEach((entry) => {
    const key = groups.get(entry.item.id) || entry.item.id;
    members.set(key, [...(members.get(key) || []), entry]);
    const current = best.get(key);
    const newer = current && +new Date(entry.item.publishedAt) > +new Date(current.item.publishedAt);
    if (!current || entry.score > current.score || (entry.score === current.score && newer)) best.set(key, entry);
  });

  return [...best].map(([key, winner]) => {
    const others = (members.get(key) || []).filter((entry) => entry !== winner);
    if (!others.length) return winner;
    const sources = [...new Set(others.map((entry) => entry.item.source))].filter((source) => source !== winner.item.source);
    return {
      score: winner.score,
      item: { ...winner.item, similarCount: others.length, similarSources: sources }
    };
  });
}
