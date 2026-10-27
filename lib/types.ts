export type FeedCategory = "market" | "finance" | "world" | "nba" | "gaming" | "social";

export type FeedItem = {
  id: string;
  customSourceId?: string;
  category: FeedCategory;
  source: string;
  sourceIcon?: string;
  title: string;
  /** 英文新聞的 AI 繁中標題 */
  titleZh?: string;
  summary: string;
  /** summary 是否為 AI 產生的摘要 */
  aiSummary?: boolean;
  /** AI 摘要依據：full＝讀過原文正文；title＝只有標題 */
  summaryBasis?: "full" | "title";
  url: string;
  publishedAt: string;
  image?: string;
  tags: string[];
  relevance: number;
  reason?: string;
  breaking?: boolean;
  /** 伺服器簽章：證明這篇新聞由本站 API 提供，AI 排序只接受有簽章的新聞 */
  sig?: string;
  /** relevance 與 reason 是否由 AI 喜好排序產生 */
  aiRanked?: boolean;
  /** 伺服器 AI 判斷：報導同一事件的新聞會有相同的 storyId */
  storyId?: string;
  /** 顯示用：被合併、沒有顯示出來的類似報導數量與來源 */
  similarCount?: number;
  similarSources?: string[];
};

export type CustomSource = {
  id: string;
  name: string;
  url: string;
  category: FeedCategory;
};

export type MarketQuote = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  sparkline: number[];
  currency: "TWD" | "USD";
  source: "TWSE" | "NASDAQ";
  asOf: string;
};
