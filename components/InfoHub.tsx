"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut, ArrowsClockwise, Basketball, Bell, BookmarkSimple, ChartLineUp,
  Check, Clock, Fire, GameController, GlobeHemisphereWest, House, MagnifyingGlass,
  Newspaper, Plus, SlidersHorizontal, Sparkle, TrendUp, WifiHigh, X
} from "@phosphor-icons/react";
import { demoFeed, demoQuotes } from "@/lib/demo-data";
import type { FeedCategory, FeedItem, MarketQuote } from "@/lib/types";
import { Sparkline } from "./Sparkline";

const categories: Array<{ id: "all" | FeedCategory; label: string; icon: typeof House }> = [
  { id: "all", label: "全部情報", icon: House },
  { id: "market", label: "台股盤勢", icon: ChartLineUp },
  { id: "finance", label: "財經新聞", icon: Newspaper },
  { id: "world", label: "世界新聞", icon: GlobeHemisphereWest },
  { id: "nba", label: "NBA", icon: Basketball },
  { id: "gaming", label: "MMORPG", icon: GameController },
  { id: "social", label: "社群熱門", icon: Fire }
];

const categoryMeta: Record<FeedCategory, { label: string; className: string }> = {
  market: { label: "市場", className: "market" }, finance: { label: "財經", className: "finance" },
  world: { label: "國際", className: "world" }, nba: { label: "NBA", className: "nba" },
  gaming: { label: "遊戲", className: "gaming" }, social: { label: "社群", className: "social" }
};

function timeAgo(date: string) {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "剛剛";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分鐘前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小時前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export default function InfoHub() {
  const [active, setActive] = useState<"all" | FeedCategory>("all");
  const [feed, setFeed] = useState<FeedItem[]>(demoFeed);
  const [quotes, setQuotes] = useState<MarketQuote[]>(demoQuotes);
  const [query, setQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem("kuang-bookmarks") || "[]");
    } catch {
      return [];
    }
  });
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"live" | "demo">("demo");
  const [updatedAt, setUpdatedAt] = useState(new Date().toISOString());
  const [mobileMenu, setMobileMenu] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/feed", { cache: "no-store" });
      const data = await response.json();
      if (data.items?.length) setFeed(data.items);
      setMode(data.mode || "demo");
      setUpdatedAt(data.updatedAt || new Date().toISOString());
    } catch {
      setFeed(demoFeed);
      setMode("demo");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    fetch("/api/feed", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (data.items?.length) setFeed(data.items);
        setMode(data.mode || "demo");
        setUpdatedAt(data.updatedAt || new Date().toISOString());
      })
      .catch(() => undefined);
    fetch("/api/market")
      .then((response) => response.json())
      .then((data) => data.quotes && setQuotes(data.quotes))
      .catch(() => undefined);
  }, []);

  function toggleBookmark(id: string) {
    setBookmarks((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      localStorage.setItem("kuang-bookmarks", JSON.stringify(next));
      return next;
    });
  }

  const visibleFeed = useMemo(() => feed.filter((item) => {
    const categoryMatch = active === "all" || item.category === active;
    const q = query.trim().toLowerCase();
    const queryMatch = !q || [item.title, item.summary, item.source, ...item.tags].join(" ").toLowerCase().includes(q);
    return categoryMatch && queryMatch;
  }), [feed, active, query]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
        <div className="brand"><div className="brand-mark"><TrendUp weight="bold" /></div><div><strong>KUANG</strong><span>INFO HUB</span></div></div>
        <button className="close-menu" onClick={() => setMobileMenu(false)} aria-label="關閉選單"><X /></button>
        <nav className="nav-list"><p>情報中心</p>
          {categories.map(({ id, label, icon: Icon }) => <button key={id} className={active === id ? "active" : ""} onClick={() => { setActive(id); setMobileMenu(false); }}><Icon weight={active === id ? "fill" : "regular"} /><span>{label}</span>{id === "all" && <em>{feed.length}</em>}</button>)}
        </nav>
        <div className="sidebar-divider" />
        <nav className="nav-list secondary"><p>我的空間</p><button><BookmarkSimple /><span>已收藏</span><em>{bookmarks.length}</em></button><button><Bell /><span>通知設定</span></button></nav>
        <div className="sidebar-footer"><div className="avatar">K</div><div><strong>Kuang</strong><span>個人情報台</span></div><SlidersHorizontal /></div>
      </aside>
      {mobileMenu && <div className="scrim" onClick={() => setMobileMenu(false)} />}

      <main>
        <header className="topbar">
          <button className="mobile-brand" onClick={() => setMobileMenu(true)}><TrendUp weight="bold" /></button>
          <div className="search"><MagnifyingGlass /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋新聞、股票、主題…" /><kbd>⌘ K</kbd></div>
          <div className="top-actions"><span className={`status ${mode}`}><WifiHigh />{mode === "live" ? "即時來源" : "展示模式"}</span><button className="icon-button"><Bell /><i /></button><button className="add-button"><Plus weight="bold" />新增來源</button></div>
        </header>

        <div className="content">
          <section className="welcome">
            <div><span className="eyebrow"><Sparkle weight="fill" /> PERSONAL INTELLIGENCE</span><h1>早安，Kuang <span>👋</span></h1><p>這是今天為你整理的重要情報。</p></div>
            <div className="date-card"><span>{new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</span><strong>{visibleFeed.length}</strong><small>則新情報</small></div>
          </section>

          <section className="market-section">
            <div className="section-heading"><div><h2>市場快照</h2><span>行情展示資料</span></div><button>查看完整盤勢 <ArrowSquareOut /></button></div>
            <div className="quote-grid">{quotes.map((quote) => <article className="quote-card" key={quote.symbol}>
              <div className="quote-top"><div><span>{quote.symbol}</span><small>{quote.name}</small></div><Sparkline data={quote.sparkline} positive={quote.change >= 0} /></div>
              <div className="quote-bottom"><strong>{quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><span className={quote.change >= 0 ? "up" : "down"}>{quote.change >= 0 ? "+" : ""}{quote.change}　{quote.changePercent >= 0 ? "+" : ""}{quote.changePercent}%</span></div>
            </article>)}</div>
          </section>

          <section className="feed-section">
            <div className="section-heading feed-heading"><div><h2>你的情報流</h2><span>依照關注主題與重要性排序</span></div><button className={`refresh ${loading ? "spinning" : ""}`} onClick={() => void refresh()} disabled={loading}><ArrowsClockwise />{loading ? "更新中" : "重新整理"}</button></div>
            <div className="filter-row">{categories.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => setActive(item.id)}>{item.label}</button>)}</div>
            <div className="feed-layout">
              <div className="feed-list">{visibleFeed.length ? visibleFeed.map((item) => {
                const meta = categoryMeta[item.category]; const saved = bookmarks.includes(item.id);
                return <article className="feed-card" key={item.id}><div className="feed-accent" data-category={item.category} /><div className="feed-content">
                  <div className="feed-meta"><span className={`category-pill ${meta.className}`}>{meta.label}</span><span>{item.source}</span><i>•</i><span><Clock />{timeAgo(item.publishedAt)}</span>{item.breaking && <b><Fire weight="fill" /> 即時</b>}</div>
                  <a href={item.url} target="_blank" rel="noreferrer"><h3>{item.title}</h3></a><p>{item.summary}</p>
                  <div className="feed-footer"><div className="tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div><div className="card-actions"><span className="relevance">{item.relevance}% 相關</span><button onClick={() => toggleBookmark(item.id)} className={saved ? "saved" : ""} aria-label="收藏">{saved ? <BookmarkSimple weight="fill" /> : <BookmarkSimple />}</button><a href={item.url} target="_blank" rel="noreferrer" aria-label="開啟原文"><ArrowSquareOut /></a></div></div>
                  {item.reason && <div className="reason"><Sparkle weight="fill" /><span>{item.reason}</span></div>}
                </div></article>;
              }) : <div className="empty"><MagnifyingGlass /><h3>找不到符合的情報</h3><p>試試其他關鍵字或分類。</p></div>}</div>
              <aside className="right-rail">
                <div className="rail-card pulse-card"><div className="rail-title"><span><Fire weight="fill" />今日脈動</span><small>即時</small></div>{[["AI 供應鏈", "熱度快速上升", "+38%"], ["NBA 開季", "討論持續增加", "+24%"], ["MMORPG 更新", "社群集中討論", "+17%"]].map((row, i) => <div className="pulse-item" key={row[0]}><b>0{i + 1}</b><div><strong>{row[0]}</strong><span>{row[1]}</span></div><em>{row[2]}</em></div>)}</div>
                <div className="rail-card watch-card"><div className="rail-title"><span><Check />追蹤主題</span><button><Plus /></button></div>{["台積電 2330", "NVIDIA", "NBA", "MMORPG", "迷因梗"].map((topic, i) => <div className="watch-item" key={topic}><span style={{ "--i": i } as React.CSSProperties} />{topic}<small>{[12, 8, 19, 6, 23][i]}</small></div>)}</div>
                <p className="last-updated">最後更新：{new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date(updatedAt))}</p>
              </aside>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
