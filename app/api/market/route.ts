import { NextRequest, NextResponse } from "next/server";
import type { MarketQuote } from "@/lib/types";

export const revalidate = 60;

const twseSymbols = ["2330", "2454", "2303", "2317", "2327", "2382", "3231"] as const;
const nasdaqSymbols = ["NVDA", "AAPL", "MSFT"] as const;

type TwseMessage = {
  c?: string;
  n?: string;
  z?: string;
  y?: string;
  d?: string;
  t?: string;
  tlong?: string;
};

type NasdaqChart = {
  data?: {
    company?: string;
    timeAsOf?: string;
    lastSalePrice?: string;
    netChange?: string;
    percentageChange?: string;
    chart?: Array<{ y?: number }>;
  };
};

function numberOf(value: string | number | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;
  const parsed = Number(value.replace(/[$,%+,]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function currentTaipeiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date()).replaceAll("-", "");
}

async function fetchJson<T>(url: string, headers?: HeadersInit, forceRefresh = false): Promise<T> {
  const response = await fetch(url, {
    ...(forceRefresh ? { cache: "no-store" as const } : { next: { revalidate: 60 } }),
    headers,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json() as Promise<T>;
}

async function twseHistory(symbol: string, date: string, forceRefresh: boolean) {
  const isIndex = symbol === "TAIEX";
  const url = isIndex
    ? `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${date}&response=json`
    : `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${date}&stockNo=${symbol}`;
  const data = await fetchJson<{ data?: string[][] }>(url, undefined, forceRefresh);
  const closeColumn = isIndex ? 4 : 6;
  const values = (data.data || [])
    .map((row) => numberOf(row[closeColumn]))
    .filter((value): value is number => value !== undefined)
    .slice(-12);
  return values.length >= 2 ? values : undefined;
}

async function fetchTwseQuotes(date: string, forceRefresh: boolean): Promise<MarketQuote[]> {
  const channels = ["tse_t00.tw", ...twseSymbols.map((symbol) => `tse_${symbol}.tw`)].join("|");
  const endpoint = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels)}&json=1&delay=0`;
  const data = await fetchJson<{ msgArray?: TwseMessage[] }>(endpoint, {
    "User-Agent": "Mozilla/5.0 (compatible; KuangInfoHub/1.0)"
  }, forceRefresh);
  const messages = data.msgArray || [];
  const histories = await Promise.allSettled([
    twseHistory("TAIEX", date, forceRefresh),
    ...twseSymbols.map((symbol) => twseHistory(symbol, date, forceRefresh))
  ]);

  return messages.flatMap((message, index) => {
    const symbol = message.c === "t00" ? "TAIEX" : message.c;
    const previous = numberOf(message.y);
    const price = numberOf(message.z) ?? previous;
    if (!symbol || price === undefined || previous === undefined) return [];
    const change = price - previous;
    const history = histories[index]?.status === "fulfilled" ? histories[index].value : undefined;
    const asOf = message.tlong
      ? new Date(Number(message.tlong)).toISOString()
      : `${message.d || date} ${message.t || ""}`;

    return [{
      symbol,
      name: symbol === "TAIEX" ? "台灣加權" : message.n || symbol,
      price,
      change,
      changePercent: previous ? (change / previous) * 100 : 0,
      sparkline: history || [previous, price],
      currency: "TWD" as const,
      source: "TWSE" as const,
      asOf
    }];
  });
}

async function fetchNasdaqQuote(symbol: string, forceRefresh: boolean): Promise<MarketQuote> {
  const data = await fetchJson<NasdaqChart>(
    `https://api.nasdaq.com/api/quote/${symbol}/chart?assetclass=stocks`,
    {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json, text/plain, */*"
    },
    forceRefresh
  );
  const quote = data.data;
  const price = numberOf(quote?.lastSalePrice);
  const change = numberOf(quote?.netChange);
  const changePercent = numberOf(quote?.percentageChange);
  if (!quote || price === undefined || change === undefined || changePercent === undefined) {
    throw new Error(`Invalid NASDAQ response for ${symbol}`);
  }
  const chart = (quote.chart || [])
    .map((point) => point.y)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    symbol,
    name: quote.company?.replace(/ Common Stock$/, "") || symbol,
    price,
    change,
    changePercent,
    sparkline: chart.length >= 2 ? chart.slice(-24) : [price - change, price],
    currency: "USD",
    source: "NASDAQ",
    asOf: quote.timeAsOf || new Date().toISOString()
  };
}

export async function GET(request: NextRequest) {
  const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
  const date = currentTaipeiDate();
  const [twseResult, ...nasdaqResults] = await Promise.allSettled([
    fetchTwseQuotes(date, forceRefresh),
    ...nasdaqSymbols.map((symbol) => fetchNasdaqQuote(symbol, forceRefresh))
  ]);
  const quotes = [
    ...(twseResult.status === "fulfilled" ? twseResult.value : []),
    ...nasdaqResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
  ];
  const failedSources = [
    ...(twseResult.status === "rejected" ? ["TWSE"] : []),
    ...nasdaqResults.flatMap((result, index) => result.status === "rejected" ? [`NASDAQ:${nasdaqSymbols[index]}`] : [])
  ];

  return NextResponse.json({
    quotes,
    mode: quotes.length ? "live" : "unavailable",
    updatedAt: new Date().toISOString(),
    failedSources
  });
}
