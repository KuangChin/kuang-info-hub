"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut, ArrowsClockwise, Basketball, Bell, BookmarkSimple, ChartLineUp,
  Check, Clock, Fire, GameController, GlobeHemisphereWest, House, MagnifyingGlass,
  Newspaper, Plus, SlidersHorizontal, Sparkle, ThumbsDown, ThumbsUp, TrendUp, WifiHigh, X
} from "@phosphor-icons/react";
import { demoFeed } from "@/lib/demo-data";
import { deduplicateFeedItems } from "@/lib/feed-dedupe";
import {
  createFeedbackEntry, isFeedFeedback,
  type FeedbackValue, type FeedFeedback
} from "@/lib/feed-preferences";
import type { CustomSource, FeedCategory, FeedItem, MarketQuote } from "@/lib/types";
import { Sparkline } from "./Sparkline";

const categories: Array<{ id: "all" | FeedCategory; label: string; icon: typeof House }> = [
  { id: "all", label: "全部情報", icon: House },
  { id: "market", label: "台股盤勢", icon: ChartLineUp },
  { id: "finance", label: "財經新聞", icon: Newspaper },
  { id: "world", label: "AI 世界新聞", icon: GlobeHemisphereWest },
  { id: "nba", label: "NBA", icon: Basketball },
  { id: "gaming", label: "MMORPG", icon: GameController },
  { id: "social", label: "社群熱門", icon: Fire }
];

const categoryMeta: Record<FeedCategory, { label: string; className: string }> = {
  market: { label: "市場", className: "market" }, finance: { label: "財經", className: "finance" },
  world: { label: "全球 AI", className: "world" }, nba: { label: "NBA", className: "nba" },
  gaming: { label: "遊戲", className: "gaming" }, social: { label: "社群", className: "social" }
};

const defaultMarketSymbols = ["TAIEX", "2330", "2454", "2327", "NVDA"];
type Dialog = "status" | "notifications" | "sources" | null;

type NotificationSettings = { enabled: boolean; keywords: string };

function articleTime(date: string, referenceDate: string) {
  const published = new Date(date);
  const reference = new Date(referenceDate);
  if (Number.isNaN(published.getTime())) return { label: "時間未知", exact: date };
  const referenceTime = Number.isNaN(reference.getTime()) ? Date.now() : reference.getTime();
  const seconds = Math.max(0, (referenceTime - published.getTime()) / 1000);
  const exact = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(published);
  if (seconds < 60) return { label: "剛剛", exact };
  if (seconds < 3600) return { label: `${Math.floor(seconds / 60)} 分鐘前`, exact };
  if (seconds < 86400) return { label: `${Math.floor(seconds / 3600)} 小時前`, exact };
  const calendarDate = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric"
  }).format(published);
  return { label: `${calendarDate} · ${Math.floor(seconds / 86400)} 天前`, exact };
}

function originalArticleUrl(url: string) {
  try {
    return new URL(url).hostname === "news.google.com"
      ? `/api/news/original?url=${encodeURIComponent(url)}`
      : url;
  } catch {
    return url;
  }
}

function quoteTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button onClick={onClose} aria-label="關閉"><X /></button></header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

export default function InfoHub() {
  const [active, setActive] = useState<"all" | FeedCategory>("all");
  const [baseFeed, setBaseFeed] = useState<FeedItem[]>(demoFeed);
  const [customFeed, setCustomFeed] = useState<FeedItem[]>([]);
  const [customSources, setCustomSources] = useState<CustomSource[]>([]);
  const [quotes, setQuotes] = useState<MarketQuote[]>([]);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(defaultMarketSymbols);
  const [marketManager, setMarketManager] = useState(false);
  const [stockToAdd, setStockToAdd] = useState("");
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketFailedSources, setMarketFailedSources] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<FeedFeedback>({});
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"live" | "demo">("demo");
  const [sourceCount, setSourceCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(new Date().toISOString());
  const [mobileMenu, setMobileMenu] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({ enabled: false, keywords: "" });
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("default");
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceCategory, setSourceCategory] = useState<FeedCategory>("world");
  const [sourceSaving, setSourceSaving] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const knownFeedIds = useRef<Set<string>>(new Set());

  const feed = useMemo(() => {
    const unique = new Map<string, FeedItem>();
    [...baseFeed, ...customFeed].forEach((item) => unique.set(item.id, item));
    return deduplicateFeedItems([...unique.values()]);
  }, [baseFeed, customFeed]);

  async function fetchCustomSources(sources: CustomSource[]) {
    if (!sources.length) {
      setCustomFeed([]);
      return [] as FeedItem[];
    }
    const settled = await Promise.allSettled(sources.map(async (source) => {
      const response = await fetch("/api/feed/custom", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `${source.name} 無法讀取`);
      return Array.isArray(data.items) ? data.items as FeedItem[] : [];
    }));
    const items = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : "自訂來源無法讀取"] : []);
    setCustomFeed(items);
    setSourceError(errors.join("；"));
    return items;
  }

  function notifyNewItems(items: FeedItem[]) {
    const previous = knownFeedIds.current;
    const fresh = previous.size ? items.filter((item) => !previous.has(item.id)) : [];
    knownFeedIds.current = new Set(items.map((item) => item.id));
    if (!fresh.length || !notificationSettings.enabled || notificationPermission !== "granted") return;
    const keywords = notificationSettings.keywords.split(/[,，\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    const matched = fresh.filter((item) => !keywords.length || keywords.some((keyword) =>
      [item.title, item.summary, ...item.tags].join(" ").toLowerCase().includes(keyword)
    ));
    if (!matched.length) return;
    const first = matched[0];
    const notification = new Notification(matched.length > 1 ? `${matched.length} 則新情報` : first.title, {
      body: matched.length > 1 ? `${first.title}，以及其他 ${matched.length - 1} 則` : first.summary.slice(0, 120),
      tag: "kuang-info-hub-news"
    });
    notification.onclick = () => { window.focus(); notification.close(); };
  }

  async function loadMarket(forceRefresh = false) {
    setMarketLoading(true);
    try {
      const response = await fetch(forceRefresh ? "/api/market?refresh=1" : "/api/market", { cache: "no-store" });
      const data = await response.json();
      setQuotes(Array.isArray(data.quotes) ? data.quotes : []);
      setMarketFailedSources(Array.isArray(data.failedSources) ? data.failedSources : []);
    } catch {
      setMarketFailedSources(["TWSE", "NASDAQ"]);
    } finally {
      setMarketLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const [response, customItems] = await Promise.all([
        fetch("/api/feed?refresh=1", { cache: "no-store" }),
        fetchCustomSources(customSources),
        loadMarket(true)
      ]);
      const data = await response.json();
      const items = Array.isArray(data.items) && data.items.length ? data.items as FeedItem[] : demoFeed;
      setBaseFeed(items);
      setMode(data.mode || "demo");
      setSourceCount(Number(data.sourceCount) || 0);
      setUpdatedAt(data.updatedAt || new Date().toISOString());
      setDuplicateCount(Number(data.duplicateCount) || 0);
      notifyNewItems(deduplicateFeedItems([...items, ...customItems]));
    } catch {
      setBaseFeed(demoFeed);
      setMode("demo");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let savedSources: CustomSource[] = [];
    let savedBookmarks: string[] = [];
    let savedFeedback: FeedFeedback = {};
    let restoredSymbols: string[] | undefined;
    let savedNotifications: NotificationSettings | undefined;
    try {
      const parsedBookmarks = JSON.parse(localStorage.getItem("kuang-bookmarks") || "[]");
      if (Array.isArray(parsedBookmarks)) savedBookmarks = parsedBookmarks;
      const parsedFeedback = JSON.parse(localStorage.getItem("kuang-feed-feedback") || "{}");
      if (isFeedFeedback(parsedFeedback)) savedFeedback = parsedFeedback;
      const storedSymbols = localStorage.getItem("kuang-market-symbols");
      const savedSymbols = storedSymbols === null ? undefined : JSON.parse(storedSymbols);
      if (Array.isArray(savedSymbols) && savedSymbols.every((symbol) => typeof symbol === "string")) {
        const withYageo = savedSymbols.includes("2327") ? savedSymbols : [...savedSymbols, "2327"];
        restoredSymbols = withYageo;
        localStorage.setItem("kuang-market-symbols", JSON.stringify(withYageo));
      }
      const parsedSources = JSON.parse(localStorage.getItem("kuang-custom-sources") || "[]");
      if (Array.isArray(parsedSources)) {
        savedSources = parsedSources;
      }
      const parsedNotifications = JSON.parse(localStorage.getItem("kuang-notifications") || "null");
      if (parsedNotifications && typeof parsedNotifications === "object") savedNotifications = parsedNotifications;
    } catch {
      // 損壞的本機設定會自動使用預設值。
    }
    const restoredSources = savedSources;
    const restoreTimer = window.setTimeout(() => {
      setBookmarks(savedBookmarks);
      setFeedback(savedFeedback);
      if (restoredSymbols) setSelectedSymbols(restoredSymbols);
      setCustomSources(restoredSources);
      if (savedNotifications) setNotificationSettings(savedNotifications);
      setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
      Promise.all([
        fetch("/api/feed", { cache: "no-store" }).then((response) => response.json()),
        fetchCustomSources(restoredSources),
        loadMarket()
      ]).then(([data, customItems]) => {
        const items = Array.isArray(data.items) && data.items.length ? data.items as FeedItem[] : demoFeed;
        setBaseFeed(items);
        setMode(data.mode || "demo");
        setSourceCount(Number(data.sourceCount) || 0);
        setDuplicateCount(Number(data.duplicateCount) || 0);
        setUpdatedAt(data.updatedAt || new Date().toISOString());
        knownFeedIds.current = new Set([...items, ...customItems].map((item) => item.id));
      }).catch(() => undefined);
    }, 0);

    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setDialog(null);
    };
    window.addEventListener("keydown", shortcut);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener("keydown", shortcut);
    };
  }, []);

  function toggleBookmark(id: string) {
    setBookmarks((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      localStorage.setItem("kuang-bookmarks", JSON.stringify(next));
      return next;
    });
  }

  function rateItem(item: FeedItem, value: FeedbackValue) {
    setFeedback((current) => {
      const next = { ...current };
      if (next[item.id]?.value === value) {
        delete next[item.id];
      } else {
        next[item.id] = createFeedbackEntry(item, value);
      }
      localStorage.setItem("kuang-feed-feedback", JSON.stringify(next));
      return next;
    });
  }

  function saveSelectedSymbols(symbols: string[]) {
    setSelectedSymbols(symbols);
    localStorage.setItem("kuang-market-symbols", JSON.stringify(symbols));
  }

  function addStock() {
    if (!stockToAdd || selectedSymbols.includes(stockToAdd)) return;
    saveSelectedSymbols([...selectedSymbols, stockToAdd]);
    setStockToAdd("");
  }

  function removeStock(symbol: string) {
    saveSelectedSymbols(selectedSymbols.filter((item) => item !== symbol));
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setNotificationPermission("unsupported");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted") {
      const next = { ...notificationSettings, enabled: true };
      setNotificationSettings(next);
      localStorage.setItem("kuang-notifications", JSON.stringify(next));
    }
  }

  function saveNotifications(next: NotificationSettings) {
    setNotificationSettings(next);
    localStorage.setItem("kuang-notifications", JSON.stringify(next));
  }

  async function addCustomSource(event: React.FormEvent) {
    event.preventDefault();
    setSourceSaving(true);
    setSourceError("");
    const source: CustomSource = { id: crypto.randomUUID(), name: sourceName.trim(), url: sourceUrl.trim(), category: sourceCategory };
    try {
      const response = await fetch("/api/feed/custom", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "無法新增來源");
      const nextSources = [...customSources, source];
      setCustomSources(nextSources);
      setCustomFeed((current) => [...current.filter((item) => item.customSourceId !== source.id), ...(data.items || [])]);
      localStorage.setItem("kuang-custom-sources", JSON.stringify(nextSources));
      setSourceName("");
      setSourceUrl("");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "無法新增來源");
    } finally {
      setSourceSaving(false);
    }
  }

  function removeCustomSource(id: string) {
    const nextSources = customSources.filter((source) => source.id !== id);
    setCustomSources(nextSources);
    setCustomFeed((current) => current.filter((item) => item.customSourceId !== id));
    localStorage.setItem("kuang-custom-sources", JSON.stringify(nextSources));
  }

  const visibleFeed = useMemo(() => {
    const filtered = feed.filter((item) => {
      const categoryMatch = active === "all" || item.category === active;
      const bookmarkMatch = !bookmarkedOnly || bookmarks.includes(item.id);
      const q = query.trim().toLowerCase();
      const queryMatch = !q || [item.title, item.summary, item.source, ...item.tags].join(" ").toLowerCase().includes(q);
      return categoryMatch && bookmarkMatch && queryMatch;
    });
    return filtered
      .sort((left, right) => +new Date(right.publishedAt) - +new Date(left.publishedAt))
      .slice(0, 10);
  }, [feed, active, query, bookmarkedOnly, bookmarks]);
  const feedbackCount = Object.keys(feedback).length;
  const selectedQuotes = useMemo(() => selectedSymbols.flatMap((symbol) => {
    const quote = quotes.find((item) => item.symbol === symbol);
    return quote ? [quote] : [];
  }), [quotes, selectedSymbols]);
  const availableQuotes = quotes.filter((quote) => !selectedSymbols.includes(quote.symbol));
  const notificationsOn = notificationSettings.enabled && notificationPermission === "granted";
  const trackedTopics = ["台積電 2330", "NVIDIA", "NBA", "MMORPG", "AI"];
  const topicCounts = trackedTopics.map((topic) => {
    const terms = topic.toLowerCase().split(/\s+/);
    return feed.filter((item) => terms.some((term) =>
      [item.title, item.summary, ...item.tags].join(" ").toLowerCase().includes(term)
    )).length;
  });
  const pulseTopics = useMemo(() => {
    const counts = new Map<string, number>();
    feed.flatMap((item) => item.tags).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [feed]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
        <div className="brand"><div className="brand-mark"><TrendUp weight="bold" /></div><div><strong>KUANG</strong><span>INFO HUB</span></div></div>
        <button className="close-menu" onClick={() => setMobileMenu(false)} aria-label="關閉選單"><X /></button>
        <nav className="nav-list"><p>情報中心</p>
          {categories.map(({ id, label, icon: Icon }) => <button key={id} className={!bookmarkedOnly && active === id ? "active" : ""} onClick={() => { setActive(id); setBookmarkedOnly(false); setMobileMenu(false); }}><Icon weight={!bookmarkedOnly && active === id ? "fill" : "regular"} /><span>{label}</span>{id === "all" && <em>{feed.length}</em>}</button>)}
        </nav>
        <div className="sidebar-divider" />
        <nav className="nav-list secondary"><p>我的空間</p><button className={bookmarkedOnly ? "active" : ""} onClick={() => { setBookmarkedOnly((current) => !current); setMobileMenu(false); }}><BookmarkSimple weight={bookmarkedOnly ? "fill" : "regular"} /><span>已收藏</span><em>{bookmarks.length}</em></button><button onClick={() => { setDialog("sources"); setMobileMenu(false); }}><Plus /><span>新增來源</span><em>{customSources.length}</em></button><button onClick={() => { setDialog("notifications"); setMobileMenu(false); }}><Bell weight={notificationsOn ? "fill" : "regular"} /><span>通知設定</span></button></nav>
        <div className="sidebar-footer"><div className="avatar">K</div><div><strong>Kuang</strong><span>個人情報台</span></div><button className="footer-settings" onClick={() => setDialog("notifications")} aria-label="開啟設定"><SlidersHorizontal /></button></div>
      </aside>
      {mobileMenu && <div className="scrim" onClick={() => setMobileMenu(false)} />}

      <main>
        <header className="topbar">
          <button className="mobile-brand" onClick={() => setMobileMenu(true)} aria-label="開啟選單"><TrendUp weight="bold" /></button>
          <div className="search"><MagnifyingGlass /><input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋新聞、股票、主題…" /><kbd>⌘ K</kbd></div>
          <div className="top-actions"><button className={`status ${mode}`} onClick={() => setDialog("status")}><WifiHigh />{mode === "live" ? "即時來源" : "展示模式"}</button><button className={`icon-button ${notificationsOn ? "enabled" : ""}`} onClick={() => setDialog("notifications")} aria-label="通知設定"><Bell weight={notificationsOn ? "fill" : "regular"} />{notificationsOn && <i />}</button><button className="add-button" onClick={() => setDialog("sources")}><Plus weight="bold" />新增來源</button></div>
        </header>

        <div className="content">
          <section className="welcome">
            <div><span className="eyebrow"><Sparkle weight="fill" /> PERSONAL INTELLIGENCE</span><h1>早安，Kuang <span>👋</span></h1><p>這是今天為你整理的重要情報。</p></div>
            <div className="date-card"><span>{new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span><strong>{visibleFeed.length}</strong><small>則新情報</small></div>
          </section>

          <section className="market-section">
            <div className="section-heading"><div><h2>市場快照</h2><span>TWSE／NASDAQ 官方行情 · 已顯示 {selectedQuotes.length} 檔</span></div><button onClick={() => setMarketManager((current) => !current)}>{marketManager ? "完成" : "管理股票"} <Plus /></button></div>
            {marketManager && <div className="market-manager">
              <div><strong>新增股票</strong><span>從清單選擇要追蹤的指數或股票</span></div>
              <select value={stockToAdd} onChange={(event) => setStockToAdd(event.target.value)}><option value="">選擇股票…</option>{availableQuotes.map((quote) => <option key={quote.symbol} value={quote.symbol}>{quote.symbol}　{quote.name}</option>)}</select>
              <button onClick={addStock} disabled={!stockToAdd}><Plus weight="bold" />加入</button>
            </div>}
            <div className="quote-grid">{selectedQuotes.map((quote) => <article className="quote-card" key={quote.symbol}>
              {marketManager && <button className="remove-quote" onClick={() => removeStock(quote.symbol)} aria-label={`移除 ${quote.name}`}><X /></button>}
              <div className="quote-top"><div><span>{quote.symbol}</span><small>{quote.name}</small></div><Sparkline data={quote.sparkline} positive={quote.change >= 0} /></div>
              <div className="quote-bottom"><strong>{quote.currency === "USD" ? "$" : ""}{quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><span className={quote.change >= 0 ? "up" : "down"}>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)}　{quote.changePercent >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%</span></div>
              <div className="quote-source"><span>{quote.source} · {quote.currency}</span><time>{quoteTime(quote.asOf)}</time></div>
            </article>)}</div>
            {marketLoading && <div className="market-empty">正在讀取官方行情…</div>}
            {!marketLoading && !selectedQuotes.length && <div className="market-empty">目前沒有可顯示的官方行情，系統不會使用估算價格。</div>}
            {!!marketFailedSources.length && <p className="market-warning">部分行情來源暫時無法取得：{marketFailedSources.join("、")}</p>}
          </section>

          <section className="feed-section">
            <div className="section-heading feed-heading"><div><h2>{bookmarkedOnly ? "已收藏" : "你的情報流"}</h2><span>{bookmarkedOnly ? "最多顯示 10 則收藏" : `依發布時間顯示最新 10 篇${feedbackCount ? ` · 已記錄 ${feedbackCount} 次回饋` : ""}`}</span></div><button className={`refresh ${loading ? "spinning" : ""}`} onClick={() => void refresh()} disabled={loading}><ArrowsClockwise />{loading ? "更新中" : "即時更新"}</button></div>
            <div className="filter-row">{categories.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}>{item.label}</button>)}</div>
            <div className="feed-layout">
              <div className="feed-list">{visibleFeed.length ? visibleFeed.map((item) => {
                const meta = categoryMeta[item.category]; const saved = bookmarks.includes(item.id); const articleUrl = originalArticleUrl(item.url); const rating = feedback[item.id]?.value; const published = articleTime(item.publishedAt, updatedAt);
                return <article className="feed-card" key={`${item.category}:${item.id}:${item.url}`}><div className="feed-accent" data-category={item.category} /><div className="feed-content">
                  <div className="feed-meta"><span className={`category-pill ${meta.className}`}>{meta.label}</span><span>{item.source}</span><i>•</i><span><Clock /><time dateTime={item.publishedAt} title={published.exact}>{published.label}</time></span>{item.breaking && <b><Fire weight="fill" /> 即時</b>}</div>
                  <a href={articleUrl} target="_blank" rel="noreferrer"><h3>{item.title}</h3></a><p>{item.summary}</p>
                  <div className="feed-footer"><div className="tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div><div className="card-actions"><span className="relevance">{item.relevance}% 相關</span><span className="feedback-actions" aria-label="偏好回饋"><button onClick={() => rateItem(item, 1)} className={rating === 1 ? "liked" : ""} aria-label="這篇有命中我的喜好" title="有命中"><ThumbsUp weight={rating === 1 ? "fill" : "regular"} /></button><button onClick={() => rateItem(item, -1)} className={rating === -1 ? "disliked" : ""} aria-label="這篇沒有命中我的喜好" title="沒命中"><ThumbsDown weight={rating === -1 ? "fill" : "regular"} /></button></span><button onClick={() => toggleBookmark(item.id)} className={saved ? "saved" : ""} aria-label="收藏">{saved ? <BookmarkSimple weight="fill" /> : <BookmarkSimple />}</button><a href={articleUrl} target="_blank" rel="noreferrer" aria-label="開啟原文"><ArrowSquareOut /></a></div></div>
                  {item.reason && <div className="reason"><Sparkle weight="fill" /><span>{item.reason}</span></div>}
                </div></article>;
              }) : <div className="empty"><MagnifyingGlass /><h3>找不到符合的情報</h3><p>試試其他關鍵字、分類，或先收藏幾則情報。</p></div>}</div>
              <aside className="right-rail">
                <div className="rail-card pulse-card"><div className="rail-title"><span><Fire weight="fill" />今日脈動</span><small>依情報流</small></div>{pulseTopics.map(([topic, count], i) => <div className="pulse-item" key={topic}><b>0{i + 1}</b><div><strong>{topic}</strong><span>目前情報流熱門標籤</span></div><em>{count} 則</em></div>)}</div>
                <div className="rail-card watch-card"><div className="rail-title"><span><Check />追蹤主題</span><button onClick={() => setDialog("sources")} aria-label="新增來源"><Plus /></button></div>{trackedTopics.map((topic, i) => <button className="watch-item" key={topic} onClick={() => setQuery(topic)}><span style={{ "--i": i } as React.CSSProperties} />{topic}<small>{topicCounts[i]}</small></button>)}</div>
                <p className="last-updated">最後更新：{new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date(updatedAt))}</p>
              </aside>
            </div>
          </section>
        </div>
      </main>

      <nav className="tab-bar" aria-label="快速導覽">
        <button className={!bookmarkedOnly && !dialog ? "active" : ""} onClick={() => { setBookmarkedOnly(false); setDialog(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}><House weight={!bookmarkedOnly && !dialog ? "fill" : "regular"} /><span>情報</span></button>
        <button className={bookmarkedOnly && !dialog ? "active" : ""} onClick={() => { setBookmarkedOnly(true); setDialog(null); window.scrollTo({ top: 0, behavior: "smooth" }); }}><BookmarkSimple weight={bookmarkedOnly && !dialog ? "fill" : "regular"} /><span>收藏{bookmarks.length ? ` ${bookmarks.length}` : ""}</span></button>
        <button className={dialog === "sources" ? "active" : ""} onClick={() => setDialog("sources")}><Plus weight="bold" /><span>來源</span></button>
        <button className={dialog === "status" ? "active" : ""} onClick={() => setDialog("status")}><WifiHigh weight={dialog === "status" ? "fill" : "regular"} /><span>{mode === "live" ? "即時" : "展示"}</span></button>
        <button className={dialog === "notifications" ? "active" : ""} onClick={() => setDialog("notifications")}><Bell weight={notificationsOn || dialog === "notifications" ? "fill" : "regular"} /><span>通知</span></button>
      </nav>

      {dialog === "status" && <Modal title="即時來源狀態" onClose={() => setDialog(null)}>
        <div className="status-grid">
          <div><span>新聞模式</span><strong className={mode === "live" ? "good" : "warn"}>{mode === "live" ? "即時" : "展示備援"}</strong></div>
          <div><span>內建新聞來源</span><strong>{sourceCount} 個可用</strong></div>
          <div><span>自訂來源</span><strong>{customSources.length} 個</strong></div>
          <div><span>已過濾重複新聞</span><strong>{duplicateCount} 則</strong></div>
          <div><span>偏好回饋</span><strong>{feedbackCount} 篇已學習</strong></div>
          <div><span>市場來源</span><strong className={marketFailedSources.length ? "warn" : "good"}>{marketFailedSources.length ? `異常：${marketFailedSources.join("、")}` : "TWSE、NASDAQ 正常"}</strong></div>
        </div>
        <p className="dialog-note">最後更新：{quoteTime(updatedAt)}。來源讀取失敗時，新聞才會切換到展示備援；股票不會顯示估算價格。</p>
        <button className="primary-action" onClick={() => void refresh()} disabled={loading}><ArrowsClockwise />{loading ? "更新中…" : "立即更新全部來源"}</button>
      </Modal>}

      {dialog === "notifications" && <Modal title="通知設定" onClose={() => setDialog(null)}>
        <div className="permission-row"><div><strong>瀏覽器通知</strong><span>{notificationPermission === "granted" ? "已取得權限" : notificationPermission === "denied" ? "已被瀏覽器封鎖" : notificationPermission === "unsupported" ? "此瀏覽器不支援" : "尚未取得權限"}</span></div>{notificationPermission !== "granted" && notificationPermission !== "unsupported" && <button onClick={() => void enableNotifications()}>允許通知</button>}</div>
        <label className="toggle-row"><div><strong>新情報提醒</strong><span>重新整理後有新文章時顯示通知</span></div><input type="checkbox" checked={notificationsOn} disabled={notificationPermission !== "granted"} onChange={(event) => saveNotifications({ ...notificationSettings, enabled: event.target.checked })} /></label>
        <label className="field"><span>關鍵字（可留空）</span><input value={notificationSettings.keywords} onChange={(event) => saveNotifications({ ...notificationSettings, keywords: event.target.value })} placeholder="例如：AI, 台積電, 國巨" /><small>以逗號或空白分隔；留空會通知所有新情報。</small></label>
        <p className="dialog-note">目前通知只在此頁開啟時運作；關閉分頁後不會在背景推播。</p>
      </Modal>}

      {dialog === "sources" && <Modal title="新增 RSS／Atom 來源" onClose={() => setDialog(null)}>
        <form className="source-form" onSubmit={(event) => void addCustomSource(event)}>
          <label className="field"><span>來源名稱</span><input required value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="例如：OpenAI News" /></label>
          <label className="field"><span>RSS／Atom 網址</span><input required type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://example.com/feed.xml" /></label>
          <label className="field"><span>分類</span><select value={sourceCategory} onChange={(event) => setSourceCategory(event.target.value as FeedCategory)}>{categories.filter((item) => item.id !== "all").map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {sourceError && <p className="form-error">{sourceError}</p>}
          <button className="primary-action" type="submit" disabled={sourceSaving}><Plus weight="bold" />{sourceSaving ? "驗證來源中…" : "驗證並新增"}</button>
        </form>
        <div className="saved-sources"><h3>已新增來源</h3>{customSources.length ? customSources.map((source) => <div key={source.id}><div><strong>{source.name}</strong><span>{categoryMeta[source.category].label} · {source.url}</span></div><button onClick={() => removeCustomSource(source.id)} aria-label={`移除 ${source.name}`}><X /></button></div>) : <p>尚未新增自訂來源。</p>}</div>
      </Modal>}
    </div>
  );
}
