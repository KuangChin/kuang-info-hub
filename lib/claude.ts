/**
 * 伺服器端共用的 Claude 呼叫：重試、錯誤訊息、工作區標頭與同時呼叫上限。
 * API Key 只在伺服器讀取，不會送到瀏覽器。
 */

export const claudeModel = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

// 從手機複製貼上時容易夾帶空白或換行。
const apiKey = () => (process.env.ANTHROPIC_API_KEY || "").trim();
// 金鑰沒有綁定工作區時，Claude API 要求以 anthropic-workspace-id 指定工作區。
const workspaceId = () => (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();

export function claudeEnabled() {
  return Boolean(apiKey());
}

export class ClaudeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** 把 API 錯誤整理成可顯示的短訊息（不含金鑰）。 */
async function readError(response: Response) {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
    const detail = [parsed.error?.type, parsed.error?.message].filter(Boolean).join(": ");
    return `Claude API ${response.status}${detail ? ` ${detail}` : ""}`.slice(0, 240);
  } catch {
    return `Claude API ${response.status} ${text}`.slice(0, 240);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 限制同時呼叫的數量，避免新帳號的速率上限讓整批失敗。
const maxConcurrent = 4;
let running = 0;
const queue: Array<() => void> = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= maxConcurrent) await new Promise<void>((resolve) => queue.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    queue.shift()?.();
  }
}

export type ClaudeTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

let tunedSupported = true;

/**
 * 強制 Claude 以指定工具回覆，回傳工具輸入（結構化結果）。
 * 先關閉 thinking、effort=low 以求快與省；模型不接受時自動改用預設參數。
 */
export async function callClaudeTool(options: {
  system: string;
  user: string;
  tool: ClaudeTool;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  return limited(async () => {
    const key = apiKey();
    if (!key) throw new ClaudeError("ANTHROPIC_API_KEY 未設定", 0);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const tuned = tunedSupported;
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          ...(workspaceId() ? { "anthropic-workspace-id": workspaceId() } : {})
        },
        body: JSON.stringify({
          model: claudeModel,
          max_tokens: options.maxTokens,
          ...(tuned ? { thinking: { type: "disabled" }, output_config: { effort: "low" } } : {}),
          system: options.system,
          tools: [options.tool],
          tool_choice: { type: "tool", name: options.tool.name },
          messages: [{ role: "user", content: options.user }]
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 25000)
      });

      if (response.ok) {
        const data = await response.json() as { content?: Array<{ type: string; input?: unknown }> };
        const input = data.content?.find((block) => block.type === "tool_use")?.input;
        if (!input || typeof input !== "object") throw new ClaudeError("Claude 回應缺少結構化內容", 200);
        return input as Record<string, unknown>;
      }

      const message = await readError(response);
      if (response.status === 400 && tuned && /thinking|effort|output_config/i.test(message)) {
        tunedSupported = false;
        console.warn("[claude] 改用預設參數重試：", message);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1500 * (attempt + 1));
        continue;
      }
      throw new ClaudeError(message, response.status);
    }
    throw new ClaudeError("Claude API 重試次數過多", 0);
  });
}
