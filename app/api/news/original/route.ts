import { NextRequest, NextResponse } from "next/server";
import { GoogleDecoder } from "google-news-url-decoder";

export const dynamic = "force-dynamic";

const decoder = new GoogleDecoder();
const decodedCache = new Map<string, string>();

function safeHttpUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest) {
  const source = safeHttpUrl(request.nextUrl.searchParams.get("url") || undefined);
  if (!source) return NextResponse.json({ error: "Invalid article URL" }, { status: 400 });

  if (source.hostname !== "news.google.com") {
    return NextResponse.redirect(source);
  }

  const cached = decodedCache.get(source.href);
  if (cached) return NextResponse.redirect(cached);

  try {
    const result = await Promise.race([
      decoder.decode(source.href),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000))
    ]);
    const original = safeHttpUrl(result?.status ? result.decoded_url : undefined);
    if (original) {
      decodedCache.set(source.href, original.href);
      return NextResponse.redirect(original);
    }
  } catch {
    // Google 的解析格式可能變動；失敗時仍保留原本可開啟的新聞連結。
  }

  return NextResponse.redirect(source);
}
