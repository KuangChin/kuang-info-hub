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
  url: string;
  publishedAt: string;
  image?: string;
  tags: string[];
  relevance: number;
  reason?: string;
  breaking?: boolean;
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
