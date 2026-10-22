import type { FeedItem } from "./types";

const now = Date.now();
const minsAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const demoFeed: FeedItem[] = [
  {
    id: "demo-market-1",
    category: "market",
    source: "市場雷達",
    title: "台股盤勢震盪，AI 供應鏈與大型權值股成交升溫",
    summary: "電子權值股成為盤面焦點，市場同步觀察外資動向與後續量能變化。",
    url: "https://www.twse.com.tw/",
    publishedAt: minsAgo(8),
    tags: ["台股", "AI", "2330"],
    relevance: 96,
    reason: "你的自選股包含 2330",
    breaking: true
  },
  {
    id: "demo-finance-1",
    category: "finance",
    source: "財經速報",
    title: "全球市場聚焦企業財報與利率路徑",
    summary: "投資人評估主要企業財測，同時等待新的通膨與央行政策訊號。",
    url: "https://finance.yahoo.com/",
    publishedAt: minsAgo(24),
    tags: ["美股", "財報", "利率"],
    relevance: 91,
    reason: "符合你追蹤的「美股」主題"
  },
  {
    id: "demo-nba-1",
    category: "nba",
    source: "NBA",
    title: "今日聯盟焦點：新賽季輪替與球星狀態成為話題",
    summary: "各隊調整陣容配置，年輕球員表現與傷兵恢復進度受到關注。",
    url: "https://www.nba.com/news",
    publishedAt: minsAgo(42),
    tags: ["NBA", "籃球"],
    relevance: 86,
    reason: "你追蹤 NBA 新聞"
  },
  {
    id: "demo-gaming-1",
    category: "gaming",
    source: "MMORPG 情報",
    title: "本週 MMORPG 更新整理：新副本、職業平衡與季節活動",
    summary: "多款線上遊戲釋出更新公告，包含限時活動、獎勵與系統優化。",
    url: "https://www.ign.com/genre/mmorpg",
    publishedAt: minsAgo(73),
    tags: ["MMORPG", "更新"],
    relevance: 79,
    reason: "符合你追蹤的「MMORPG」主題"
  },
  {
    id: "demo-social-1",
    category: "social",
    source: "社群脈動",
    title: "今日社群熱點：迷因、科技話題與熱門討論快速竄升",
    summary: "彙整社群平台近期高互動內容，讓你快速掌握正在流行的話題。",
    url: "https://www.reddit.com/r/popular/",
    publishedAt: minsAgo(105),
    tags: ["迷因", "趨勢", "社群"],
    relevance: 72,
    reason: "今日熱門內容"
  },
  {
    id: "demo-world-1",
    category: "world",
    source: "全球 AI",
    title: "全球 AI 產業聚焦新模型、算力建設與監管進展",
    summary: "掌握國際人工智慧公司的產品更新、晶片與資料中心投資，以及各國政策動態。",
    url: "https://www.reuters.com/technology/artificial-intelligence/",
    publishedAt: minsAgo(138),
    tags: ["AI", "人工智慧", "國際"],
    relevance: 68,
    reason: "符合你追蹤的「AI」主題"
  }
];
