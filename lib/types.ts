export type FeedCategory = "market" | "finance" | "world" | "nba" | "gaming" | "social";

export type FeedItem = {
  id: string;
  category: FeedCategory;
  source: string;
  sourceIcon?: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  image?: string;
  tags: string[];
  relevance: number;
  reason?: string;
  breaking?: boolean;
};

export type MarketQuote = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  sparkline: number[];
};
