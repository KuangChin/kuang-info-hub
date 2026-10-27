import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { callClaudeTool, claudeModel } from "@/lib/claude";
import type { FeedItem } from "@/lib/types";

/**
 * 「社群熱門」的新聞來自媒體對 Threads／IG 爆紅話題的報導，
 * 但搜尋結果會混入平台營運新聞、行銷教學、詐騙宣導等。
 * 這裡由 Claude 只留下「社群上正在爆紅或熱議的具體內容」。
 */

const promptVersion = "social-v1";

const filterTool = {
  name: "record_trending",
  description: "記錄哪些新聞是在講社群上正在爆紅或熱議的具體內容。",
  input_schema: {
    type: "object",
    properties: {
      keep: {
        type: "array",
        description: "要保留的新聞編號",
        items: { type: "integer" }
      }
    },
    required: ["keep"]
  }
};

const systemPrompt = [
  "你是社群趨勢編輯，替台灣讀者挑出 Threads、Instagram 等社群上「正在爆紅或熱議的具體內容」。",
  "保留：某則貼文、影片、照片或留言爆紅；網友熱烈討論或吵翻的話題；名人、網紅的貼文引發關注；有趣、好笑、暖心或讓人驚訝的社群事件；正在流行的梗、挑戰或用語。",
  "排除：平台本身的營運或產品新聞（新功能、用戶數、財報、政策）；行銷或經營帳號教學；詐騙或資安宣導；廣告與業配；和社群熱門內容無關的一般新聞。",
  "只看標題判斷，不確定時偏向保留。"
].join("\n");

type FilterInput = Pick<FeedItem, "id" | "title" | "source">;

async function requestKeep(items: FilterInput[]): Promise<string[]> {
  const list = items.map((item, index) => `${index + 1}. [${item.source}] ${item.title.replace(/\s+/g, " ").slice(0, 180)}`).join("\n");
  const result = await callClaudeTool({
    system: systemPrompt,
    tool: filterTool,
    maxTokens: 400,
    timeoutMs: 20000,
    priority: true,
    user: `請判斷以下新聞：\n${list}`
  });
  if (!Array.isArray(result.keep)) throw new Error("Claude 回應缺少篩選結果");
  const keep = new Set(result.keep.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= items.length));
  return items.filter((_, index) => keep.has(index + 1)).map((item) => item.id);
}

const cachedKeep = unstable_cache(
  async (_key: string, items: FilterInput[]) => requestKeep(items),
  ["ai-social", promptVersion],
  { revalidate: 60 * 60 * 24, tags: ["ai-social"] }
);

const memory = new Map<string, string[]>();

async function keepTrending(items: FilterInput[]) {
  const key = createHash("sha256")
    .update([promptVersion, claudeModel, ...items.map((item) => `${item.id}|${item.title}`).sort()].join("\n"))
    .digest("base64url")
    .slice(0, 32);
  const hit = memory.get(key);
  if (hit) return hit;
  const kept = await cachedKeep(key, items);
  memory.set(key, kept);
  if (memory.size > 50) memory.delete(memory.keys().next().value as string);
  return kept;
}

/**
 * 篩掉 candidates 中不是熱門社群內容的新聞。
 * 時間內沒完成或失敗時先不篩（避免整區空白），背景完成後下次載入就會套用。
 */
export async function filterTrendingSocial(items: FeedItem[], candidateIds: Set<string>, budgetMs: number) {
  const candidates = items.filter((item) => candidateIds.has(item.id)).map(({ id, title, source }) => ({ id, title, source }));
  if (!candidates.length) return { items, kept: 0, dropped: 0, pending: null, error: "" };

  const job = keepTrending(candidates);
  job.catch(() => undefined);
  let kept: string[] | null = null;
  let error = "";
  await Promise.race([
    job.then((value) => { kept = value; }, (caught) => {
      error = caught instanceof Error ? caught.message : String(caught);
      console.warn("[ai-social]", error);
    }),
    new Promise((resolve) => setTimeout(resolve, budgetMs))
  ]);

  const resolved = kept as string[] | null;
  if (!resolved) return { items, kept: candidates.length, dropped: 0, pending: error ? null : job, error };
  const keep = new Set(resolved);
  return {
    items: items.filter((item) => !candidateIds.has(item.id) || keep.has(item.id)),
    kept: keep.size,
    dropped: candidates.length - keep.size,
    pending: null,
    error: ""
  };
}
