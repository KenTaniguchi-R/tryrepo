import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resize, sendInput } from "@/lib/terminal";
import { TERMINAL_OWNER_COOKIE } from "../../start/route";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as { data?: string; cols?: number; rows?: number };

  // Without the owner cookie this is someone else's shell -- treat it as
  // missing rather than confirming the session exists.
  const ownerId = (await cookies()).get(TERMINAL_OWNER_COOKIE)?.value ?? "";

  try {
    if (typeof body.cols === "number" && typeof body.rows === "number") {
      const ok = await resize(id, body.cols, body.rows, ownerId);
      if (!ok) return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    if (typeof body.data === "string") {
      const ok = await sendInput(id, body.data, ownerId);
      if (!ok) return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
