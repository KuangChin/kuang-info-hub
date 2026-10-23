# Kuang Info Hub

個人化情報儀表板，整合台股、財經、世界新聞、NBA、MMORPG 與社群熱門內容。

## 目前功能

- 六大情報分類與即時 RSS 聚合
- AI 技術來源：Hugging Face、Google DeepMind、OpenAI 與 arXiv AI／機器學習
- 關鍵字搜尋與分類篩選
- 自選市場快照（台股取自 TWSE、美股取自 NASDAQ，顯示來源與更新時間）
- 新聞收藏（瀏覽器 localStorage）
- 每次顯示最符合偏好的前 10 篇，並可用喜歡／不喜歡回饋調整後續排序
- 新聞時間以伺服器更新時間計算，超過一天會同時顯示實際月日
- 相關度與推薦原因
- 響應式深色介面
- RSS 無法連線時自動切換展示資料
- 英文 AI 新聞自動產生繁中標題與摘要（Claude，需設定 `ANTHROPIC_API_KEY`）
- 手機版：可加入主畫面（PWA）、底部導覽列、下拉重新整理、離線顯示上次的新聞

## 本機執行

```bash
npm install
npm run dev
```

開啟 `http://localhost:3000`。

## AI 英文新聞摘要

在 Vercel 專案的 Settings → Environment Variables 加入 `ANTHROPIC_API_KEY`（本機放在 `.env.local`），重新部署後即生效。

- 只處理「AI 世界新聞」分類中以英文為主的文章，中文新聞不會送出
- 預設模型 `claude-haiku-5-5`，可用 `ANTHROPIC_MODEL` 更換
- 每篇依網址、標題與內文快取，同一篇只摘要一次；載入時最多等 3.5 秒，未完成的會在背景完成，下次開啟即可看到
- 若狀態視窗顯示金鑰未綁定工作區（workspace），請改用在工作區內建立的金鑰，或另外設定 `ANTHROPIC_WORKSPACE_ID`
- 未設定金鑰時功能自動關閉，其他功能不受影響

## API

- `GET /api/feed`：聚合新聞情報
- `GET /api/feed?category=nba`：取得指定分類
- `GET /api/market`：市場快照

## 下一階段

- Supabase 使用者、收藏與自選清單
- 券商授權行情 API 與更完整的盤中資料
- 自訂 RSS 與關鍵字來源
- X、Instagram 官方 API
- AI 重要性排序與每日重點整理
- SwiftUI iOS App 與 APNs 推播

> 新聞標題與連結來自第三方來源，內容著作權屬原發布者。市場資訊不構成投資建議。
