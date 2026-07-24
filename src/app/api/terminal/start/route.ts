import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { newOwnerId, startTerminalSession } from "@/lib/terminal";

export const maxDuration = 300;

export const TERMINAL_OWNER_COOKIE = "tryrepo_term_owner";

export async function POST(req: Request) {
  try {
    const { repoUrl } = (await req.json()) as { repoUrl?: string };
    if (!repoUrl) {
      return NextResponse.json({ error: "repoUrl is required" }, { status: 400 });
    }

    // A terminal is a root shell, so it's bound to the browser that asked for
    // it. Reuse this browser's owner id if it already has one.
    const jar = await cookies();
    const existing = jar.get(TERMINAL_OWNER_COOKIE)?.value;
    const ownerId = existing ?? newOwnerId();

    console.log(`[terminal] starting session for ${repoUrl}`);
    const result = await startTerminalSession(repoUrl, ownerId);
    console.log(`[terminal] session ready (${result.baseImage})`);

    const res = NextResponse.json(result);
    if (!existing) {
      res.cookies.set(TERMINAL_OWNER_COOKIE, ownerId, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 60 * 60 * 4,
      });
    }
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[terminal] start failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
