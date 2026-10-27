import type { FeedCategory, FeedItem } from "@/lib/types";

export type FeedbackValue = 1 | -1;

export type FeedFeedbackEntry = {
  value: FeedbackValue;
  source: string;
  category: FeedCategory;
  tags: string[];
  terms: string[];
  updatedAt: string;
  /** 文章標題（供 AI 理解喜好；舊紀錄可能沒有） */
  title?: string;
};

export type FeedFeedback = Record<string, FeedFeedbackEntry>;

const ignoredTerms = new Set([
  "about", "after", "again", "also", "been", "being", "from", "have", "into",
  "latest", "more", "news", "over", "that", "their", "this", "using", "with"
]);

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("zh-TW");
}

function titleTerms(title: string) {
  const terms = title.toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/g) || [];
  return [...new Set(terms.filter((term) => !ignoredTerms.has(term)))].slice(0, 10);
}

export function createFeedbackEntry(item: FeedItem, value: FeedbackValue): FeedFeedbackEntry {
  return {
    value,
    source: item.source,
    category: item.category,
    tags: item.tags,
    terms: titleTerms(item.title),
    updatedAt: new Date().toISOString(),
    title: (item.titleZh || item.title).slice(0, 160)
  };
}

export function isFeedFeedback(value: unknown): value is FeedFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const candidate = entry as Partial<FeedFeedbackEntry>;
    return (candidate.value === 1 || candidate.value === -1) &&
      typeof candidate.source === "string" &&
      typeof candidate.category === "string" &&
      Array.isArray(candidate.tags) && candidate.tags.every((tag) => typeof tag === "string") &&
      Array.isArray(candidate.terms) && candidate.terms.every((term) => typeof term === "string") &&
      typeof candidate.updatedAt === "string" &&
      (candidate.title === undefined || typeof candidate.title === "string");
  });
}

/** 最近的讚／倒讚，整理成給 AI 參考的範例（最多 30 則）。 */
export function feedbackExamples(feedback: FeedFeedback, limit = 30) {
  return Object.values(feedback)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
    .map((entry) => ({
      title: entry.title || entry.tags.join("、") || entry.source,
      source: entry.source,
      category: entry.category,
      value: entry.value
    }));
}

function preferenceProfile(feedback: FeedFeedback) {
  const sources = new Map<string, number>();
  const categories = new Map<FeedCategory, number>();
  const tags = new Map<string, number>();
  const terms = new Map<string, number>();

  Object.values(feedback).forEach((entry) => {
    sources.set(normalized(entry.source), (sources.get(normalized(entry.source)) || 0) + entry.value);
    categories.set(entry.category, (categories.get(entry.category) || 0) + entry.value);
    entry.tags.forEach((tag) => tags.set(normalized(tag), (tags.get(normalized(tag)) || 0) + entry.value));
    entry.terms.forEach((term) => terms.set(normalized(term), (terms.get(normalized(term)) || 0) + entry.value));
  });

  return { sources, categories, tags, terms };
}

/** 規則式喜好分數（沒有 AI 評分時使用）。 */
export function preferenceScores(items: FeedItem[], feedback: FeedFeedback, now = Date.now()) {
  return new Map(scoreByPreferences(items, feedback, now).map(({ item, score }) => [item.id, score]));
}

export function rankFeedByPreferences(items: FeedItem[], feedback: FeedFeedback, now = Date.now()) {
  return scoreByPreferences(items, feedback, now)
    .sort((left, right) => right.score - left.score ||
      +new Date(right.item.publishedAt) - +new Date(left.item.publishedAt))
    .map(({ item }) => item);
}

function scoreByPreferences(items: FeedItem[], feedback: FeedFeedback, now: number) {
  const profile = preferenceProfile(feedback);

  const ranked = items.map((item) => {
    const directFeedback = feedback[item.id]?.value || 0;
    const sourceScore = profile.sources.get(normalized(item.source)) || 0;
    const categoryScore = profile.categories.get(item.category) || 0;
    const tagScore = item.tags.reduce((sum, tag) => sum + (profile.tags.get(normalized(tag)) || 0), 0);
    const text = `${item.title} ${item.summary}`.toLowerCase();
    const termScore = [...profile.terms].reduce((sum, [term, weight]) => sum + (text.includes(term) ? weight : 0), 0);
    const ageHours = Math.max(0, (now - new Date(item.publishedAt).getTime()) / 3_600_000);
    const recencyScore = Number.isFinite(ageHours) ? Math.max(0, 12 - ageHours / 4) : 0;

    return {
      item,
      score: item.relevance +
        directFeedback * 120 +
        Math.max(-30, Math.min(30, sourceScore * 8)) +
        Math.max(-12, Math.min(12, categoryScore * 3)) +
        Math.max(-24, Math.min(24, tagScore * 5)) +
        Math.max(-20, Math.min(20, termScore * 3)) +
        recencyScore
    };
  });

  return ranked;
}
