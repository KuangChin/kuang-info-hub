import { NextResponse } from "next/server";
import { maxCandidates, maxExamples, rankCandidates, verifyCandidate, type RankCandidate, type RankExample } from "@/lib/ai-rank";
import { claudeEnabled } from "@/lib/claude";
import type { FeedCategory } from "@/lib/types";

export const maxDuration = 60;

const categories = new Set<FeedCategory>(["market", "finance", "world", "nba", "gaming", "social"]);

// 粗略的每個伺服器實例速率限制，避免短時間大量呼叫消耗額度。
const windowMs = 10 * 60 * 1000;
const maxRequests = 40;
const hits = new Map<string, number[]>();
function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((time) => now - time < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) hits.clear();
  return recent.length > maxRequests;
}

const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function readCandidate(value: unknown): RankCandidate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!isString(item.id, 120) || !isString(item.title, 400) || !isString(item.source, 120) ||
    !isString(item.sig, 64) || !categories.has(item.category as FeedCategory)) return null;
  return { id: item.id, title: item.title, source: item.source, category: item.category as FeedCategory, sig: item.sig };
}

function readExample(value: unknown): RankExample | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!isString(item.title, 400) || !isString(item.source, 120) || !categories.has(item.category as FeedCategory) ||
    (item.value !== 1 && item.value !== -1)) return null;
  return { title: item.title, source: item.source, category: item.category as FeedCategory, value: item.value };
}

export async function POST(request: Request) {
  if (!claudeEnabled()) return NextResponse.json({ enabled: false, scores: {} });

  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return NextResponse.json({ enabled: true, scores: {}, error: "請求太頻繁，請稍後再試" }, { status: 429 });

  let body: { candidates?: unknown; examples?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ enabled: true, scores: {}, error: "格式錯誤" }, { status: 400 });
  }

  const examples = (Array.isArray(body.examples) ? body.examples : []).slice(0, maxExamples)
    .map(readExample).filter((example): example is RankExample => !!example);
  const candidates = (Array.isArray(body.candidates) ? body.candidates : []).slice(0, maxCandidates)
    .map(readCandidate).filter((candidate): candidate is RankCandidate => !!candidate && verifyCandidate(candidate));

  if (!examples.length || !candidates.length) {
    return NextResponse.json({ enabled: true, scores: {}, rejected: Array.isArray(body.candidates) ? body.candidates.length - candidates.length : 0 });
  }

  const { profile, scores, error } = await rankCandidates(examples, candidates);
  return NextResponse.json({
    enabled: true,
    profile,
    scores,
    examples: examples.length,
    scored: Object.keys(scores).length,
    candidates: candidates.length,
    error: error || undefined
  });
}
