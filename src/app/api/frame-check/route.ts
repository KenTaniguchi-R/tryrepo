import { NextResponse } from "next/server";
import { evaluateFrameCheck } from "@/lib/frameCheck";

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get("url");
  if (!target) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: "url is not valid" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return NextResponse.json({ error: "unsupported protocol" }, { status: 400 });
  }

  try {
    const res = await fetch(parsed, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    return NextResponse.json(evaluateFrameCheck(res.status, res.headers));
  } catch {
    // The app may still be booting. Report that rather than a verdict -- the
    // caller retries while `unreachable` and only then falls back to trying
    // the iframe, since a blank frame is recoverable and a false "cannot
    // embed" is not.
    return NextResponse.json({ embeddable: true, unreachable: true });
  }
}
