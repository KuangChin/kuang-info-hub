import { NextResponse } from "next/server";
import { demoQuotes } from "@/lib/demo-data";

export const revalidate = 300;

export async function GET() {
  // 第一版提供穩定展示資料。下一階段可在此接券商或授權即時行情 API。
  return NextResponse.json({ quotes: demoQuotes, mode: "demo", updatedAt: new Date().toISOString() });
}
