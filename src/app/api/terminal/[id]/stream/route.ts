import { cookies } from "next/headers";
import { getSession } from "@/lib/terminal";
import { TERMINAL_OWNER_COOKIE } from "../../start/route";

export const maxDuration = 300;

/**
 * Streams PTY output to the browser as SSE. Next's App Router can't host a
 * raw WebSocket server without a custom server, and SSE downstream + POST
 * upstream is plenty for a terminal.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Attaching to a stream means watching someone's root shell -- require the
  // owner cookie, and don't leak whether the session exists.
  const ownerId = (await cookies()).get(TERMINAL_OWNER_COOKIE)?.value ?? "";
  const session = getSession(id, ownerId);
  if (!session) {
    return new Response("session not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let listener: ((chunk: Uint8Array) => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      listener = (chunk: Uint8Array) => {
        // Base64 so arbitrary terminal bytes survive SSE's line protocol.
        const b64 = Buffer.from(chunk).toString("base64");
        try {
          controller.enqueue(encoder.encode(`data: ${b64}\n\n`));
        } catch {
          // Client went away mid-write; cancel() will clean up.
        }
      };

      // Replay anything produced before the client attached.
      for (const chunk of session.backlog) listener(chunk);
      session.backlog.length = 0;

      session.listeners.add(listener);

      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // ignore -- stream is closing
        }
      }, 15_000);
    },
    cancel() {
      if (listener) session.listeners.delete(listener);
      if (keepAlive) clearInterval(keepAlive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
