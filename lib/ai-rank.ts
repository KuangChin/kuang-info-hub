import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { unstable_cache } from "next/cache";
import { callClaudeTool, claudeModel } from "@/lib/claude";
import type { FeedCategory, FeedItem } from "@/lib/types";

/**
 * 依使用者的讚／倒讚，由 Claude 為新聞打 0–100 的喜好分數並寫推薦原因。
 *
 * 防止網站被拿來消耗額度：
 * - 候選新聞必須帶有伺服器簽章（只有本站 API 回傳的新聞才有），不能塞任意文字
 * - 每次最多評估 maxCandidates 篇、參考 maxExamples 則回饋，文字長度有上限
 * - 相同「喜好＋新聞」的結果會快取，不重複呼叫
 */

const promptVersion = "rank-v1";
export const maxCandidates = 120;
export const maxExamples = 30;
const batchSize = 40;
const maxTitle = 160;

export type RankCandidate = { id: string; title: string; source: string; category: FeedCategory; sig: string };
export type RankExample = { title: string; source: string; category: FeedCategory; value: 1 | -1 };
export type RankScore = { score: number; reason: string };

function signingKey() {
  const secret = (process.env.FEED_SIGNING_SECRET || process.env.ANTHROPIC_API_KEY || "").trim();
  // 不直接使用金鑰本身，而是衍生出專用的簽章金鑰。
  return createHash("sha256").update(`kuang-feed-signing:${secret}`).digest();
}

function signature(id: string, title: string) {
  return createHmac("sha256", signingKey()).update(`${id}\n${title}`).digest("base64url").slice(0, 22);
}

export function signFeedItems<T extends FeedItem>(items: T[]): T[] {
  return items.map((item) => ({ ...item, sig: signature(item.id, item.title) }));
}

export function verifyCandidate(candidate: RankCandidate) {
  const expected = Buffer.from(signature(candidate.id, candidate.title));
  const actual = Buffer.from(candidate.sig || "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const categoryLabels: Record<FeedCategory, string> = {
  market: "台股", finance: "財經", world: "AI／科技", nba: "NBA", gaming: "遊戲", social: "社群"
};

const clean = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, maxTitle);

export function profileKey(examples: RankExample[]) {
  const normalized = examples
    .map((example) => `${example.value}|${example.category}|${clean(example.source)}|${clean(example.title)}`)
    .sort();
  return createHash("sha256").update([promptVersion, claudeModel, ...normalized].join("\n")).digest("base64url").slice(0, 24);
}

const rankTool = {
  name: "record_scores",
  description: "記錄每篇候選新聞符合使用者喜好的分數與推薦原因。",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer", description: "候選新聞編號" },
            score: { type: "integer", minimum: 0, maximum: 100, description: "符合喜好的程度，0 到 100" },
            reason: { type: "string", description: "繁體中文推薦原因，12 到 24 字，具體指出與哪個興趣相關" }
          },
          required: ["n", "score", "reason"]
        }
      }
    },
    required: ["scores"]
  }
};

const systemPrompt = [
  "你是台灣使用者的個人新聞推薦助手。",
  "使用者對過去的新聞按過「喜歡」或「不喜歡」。請從中推斷他真正在意的主題、公司、人物與內容類型，",
  "而不只是比對字面關鍵字：例如喜歡「AI 晶片」時，GPU、先進製程、算力相關新聞也應加分。",
  "不喜歡的主題要明顯減分；只是同分類但主題無關的新聞給中間分數。",
  "評分標準：85–100 高度符合；60–84 相關；35–59 普通；0–34 不感興趣或與不喜歡的內容相近。",
  "推薦原因用繁體中文（台灣用語），具體說明與哪個興趣相關；低分時說明為何較不相關。",
  "每一篇候選新聞都要評分。"
].join("\n");

function describe(examples: RankExample[], value: 1 | -1) {
  const lines = examples
    .filter((example) => example.value === value)
    .map((example) => `- [${categoryLabels[example.category] || example.category}｜${clean(example.source)}] ${clean(example.title)}`);
  return lines.length ? lines.join("\n") : "（無）";
}

async function scoreBatch(examples: RankExample[], candidates: RankCandidate[]): Promise<Record<string, RankScore>> {
  const list = candidates
    .map((candidate, index) => `${index + 1}. [${categoryLabels[candidate.category] || candidate.category}｜${clean(candidate.source)}] ${clean(candidate.title)}`)
    .join("\n");
  const result = await callClaudeTool({
    system: systemPrompt,
    tool: rankTool,
    maxTokens: 120 + candidates.length * 70,
    timeoutMs: 40000,
    user: `使用者喜歡的新聞：\n${describe(examples, 1)}\n\n使用者不喜歡的新聞：\n${describe(examples, -1)}\n\n請為以下候選新聞評分：\n${list}`
  });

  const scores: Record<string, RankScore> = {};
  const rows = Array.isArray(result.scores) ? result.scores : [];
  rows.forEach((row) => {
    if (!row || typeof row !== "object") return;
    const { n, score, reason } = row as { n?: unknown; score?: unknown; reason?: unknown };
    const candidate = typeof n === "number" ? candidates[n - 1] : undefined;
    if (!candidate || typeof score !== "number" || !Number.isFinite(score)) return;
    scores[candidate.id] = {
      score: Math.max(0, Math.min(100, Math.round(score))),
      reason: typeof reason === "string" ? reason.trim().slice(0, 40) : ""
    };
  });
  // 一篇都沒有解析到時視為失敗，避免把空結果寫進快取。
  if (!Object.keys(scores).length) throw new Error("Claude 回應缺少評分內容");
  return scores;
}

const cachedBatch = unstable_cache(
  async (_profile: string, _batch: string, examples: RankExample[], candidates: RankCandidate[]) => scoreBatch(examples, candidates),
  ["ai-rank", promptVersion],
  { revalidate: 60 * 60 * 24 * 7, tags: ["ai-rank"] }
);

// 同一個伺服器實例內記住每篇的分數，喜好不變時新出現的新聞才需要重新評分。
const memory = new Map<string, RankScore>();

export async function rankCandidates(examples: RankExample[], candidates: RankCandidate[]) {
  const profile = profileKey(examples);
  const scores: Record<string, RankScore> = {};
  const missing: RankCandidate[] = [];
  candidates.forEach((candidate) => {
    const hit = memory.get(`${profile}:${candidate.id}`);
    if (hit) scores[candidate.id] = hit;
    else missing.push(candidate);
  });

  const batches: RankCandidate[][] = [];
  for (let index = 0; index < missing.length; index += batchSize) batches.push(missing.slice(index, index + batchSize));

  let error = "";
  await Promise.all(batches.map(async (batch) => {
    const batchKey = createHash("sha256").update(batch.map((candidate) => `${candidate.id}|${candidate.title}`).join("\n")).digest("base64url").slice(0, 24);
    try {
      const result = await cachedBatch(profile, batchKey, examples, batch);
      Object.entries(result).forEach(([id, score]) => {
        scores[id] = score;
        memory.set(`${profile}:${id}`, score);
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      console.warn("[ai-rank]", error);
    }
  }));

  return { profile, scores, error };
}
