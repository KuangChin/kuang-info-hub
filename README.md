# Kuang Info Hub

個人化情報儀表板，整合台股、財經、世界新聞、NBA、MMORPG 與社群熱門內容。

## 目前功能

- 六大情報分類與即時 RSS 聚合
- 關鍵字搜尋與分類篩選
- 自選市場快照（目前為展示行情）
- 新聞收藏（瀏覽器 localStorage）
- 相關度與推薦原因
- 響應式深色介面
- RSS 無法連線時自動切換展示資料

## 本機執行

```bash
npm install
npm run dev
```

開啟 `http://localhost:3000`。

## API

- `GET /api/feed`：聚合新聞情報
- `GET /api/feed?category=nba`：取得指定分類
- `GET /api/market`：市場快照

## 下一階段

- Supabase 使用者、收藏與自選清單
- TWSE／券商授權行情 API
- 自訂 RSS 與關鍵字來源
- X、Instagram 官方 API
- AI 摘要、去重與重要性排序
- SwiftUI iOS App 與 APNs 推播

> 新聞標題與連結來自第三方來源，內容著作權屬原發布者。市場資訊不構成投資建議。
