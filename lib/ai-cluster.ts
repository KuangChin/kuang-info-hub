import { createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { callClaudeTool, claudeModel } from "@/lib/claude";
import type { FeedItem } from "@/lib/types";

/**
 * 由 Claude 找出「報導同一事件」的新聞，回傳 id → storyId。
 * 只合併同一個具體事件（同一場發表、財報、比賽、公告…），
 * 同公司或同主題但不同事件不合併，避免把想看的新聞藏起來。
 */

const promptVersion = "cluster-v1";
const maxItems = 150;

const clusterTool = {
  name: "record_groups",
  description: "記錄報導同一事件的新聞分組。",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "每一組是報導同一事件的新聞編號；只列出兩則以上的組，沒有就給空陣列。",
        items: { type: "array", items: { type: "integer" }, minItems: 2 }
      }
    },
    required: ["groups"]
  }
};

const systemPrompt = [
  "你是新聞編輯，負責找出「報導同一個具體事件」的新聞，讓讀者每個事件只看一則。",
  "只有在報導的是同一個事件時才歸為同一組：同一場產品發表、同一份財報或法說會、同一場比賽、同一則公告、同一篇研究成果、同一起事故。",
  "以下情況不要合併：同一公司或同一主題但不同事件；不同日期的例行報導（例如不同天的盤勢、不同場比賽）；只是都提到同一個名字。",
  "不同語言、不同媒體、標題寫法不同，只要是同一事件就要合併。",
  "每則新聞最多屬於一組。不確定時不要合併。"
].join("\n");

const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
};

type ClusterInput = Pick<FeedItem, "id" | "title" | "source" | "publishedAt">;

async function requestGroups(items: ClusterInput[]): Promise<string[][]> {
  const list = items
    .map((item, index) => `${index + 1}. [${item.source}｜${dateLabel(item.publishedAt)}] ${item.title.replace(/\s+/g, " ").slice(0, 180)}`)
    .join("\n");
  const result = await callClaudeTool({
    system: systemPrompt,
    tool: clusterTool,
    maxTokens: 1200,
    timeoutMs: 30000,
    priority: true,
    user: `請找出以下新聞中報導同一事件的分組：\n${list}`
  });

  const used = new Set<number>();
  const groups: string[][] = [];
  (Array.isArray(result.groups) ? result.groups : []).forEach((group) => {
    if (!Array.isArray(group)) return;
    const members = group
      .filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= items.length && !used.has(n));
    const unique = [...new Set(members)];
    if (unique.length < 2) return;
    unique.forEach((n) => used.add(n));
    groups.push(unique.map((n) => items[n - 1].id));
  });
  return groups;
}

const cachedGroups = unstable_cache(
  async (_key: string, items: ClusterInput[]) => requestGroups(items),
  ["ai-cluster", promptVersion],
  { revalidate: 60 * 60 * 24, tags: ["ai-cluster"] }
);

const memory = new Map<string, string[][]>();

async function clusterItems(items: ClusterInput[]) {
  const key = createHash("sha256")
    .update([promptVersion, claudeModel, ...items.map((item) => `${item.id}|${item.title}`).sort()].join("\n"))
    .digest("base64url")
    .slice(0, 32);
  const hit = memory.get(key);
  if (hit) return hit;
  const groups = await cachedGroups(key, items);
  memory.set(key, groups);
  if (memory.size > 50) memory.delete(memory.keys().next().value as string);
  return groups;
}

const storyIdOf = (ids: string[]) =>
  `story-${createHash("sha256").update([...ids].sort().join("|")).digest("base64url").slice(0, 16)}`;

/**
 * 在時間預算內替新聞加上 storyId；來不及的會回傳 pending，
 * 交給 after() 在背景完成並寫入快取，下次載入就會套用。
 */
export async function attachStoryGroups(items: FeedItem[], budgetMs: number) {
  const inputs = [...items]
    .sort((left, right) => +new Date(right.publishedAt) - +new Date(left.publishedAt))
    .slice(0, maxItems)
    .map(({ id, title, source, publishedAt }) => ({ id, title, source, publishedAt }));
  if (inputs.length < 2) return { items, groups: 0, pending: null, error: "" };

  const job = clusterItems(inputs);
  job.catch(() => undefined);
  let groups: string[][] | null = null;
  let error = "";
  await Promise.race([
    job.then((value) => { groups = value; }, (caught) => {
      error = caught instanceof Error ? caught.message : String(caught);
      console.warn("[ai-cluster]", error);
    }),
    new Promise((resolve) => setTimeout(resolve, budgetMs))
  ]);

  const resolved = groups as string[][] | null;
  if (!resolved) return { items, groups: 0, pending: error ? null : job, error };
  const storyIds = new Map<string, string>();
  resolved.forEach((group) => {
    const storyId = storyIdOf(group);
    group.forEach((id) => storyIds.set(id, storyId));
  });
  return {
    items: items.map((item) => storyIds.has(item.id) ? { ...item, storyId: storyIds.get(item.id) } : item),
    groups: resolved.length,
    pending: null,
    error: ""
  };
}
