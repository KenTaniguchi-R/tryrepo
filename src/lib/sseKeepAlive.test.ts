import { describe, expect, it } from "vitest";
import { withSseKeepAlive } from "@/lib/sseKeepAlive";

const encoder = new TextEncoder();

/** An SSE response that emits `start`, idles for `idleMs`, then emits `done`. */
function idleStream(idleMs: number, contentType = "text/event-stream") {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("data: start\n\n"));
      await new Promise((r) => setTimeout(r, idleMs));
      controller.enqueue(encoder.encode("data: done\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": contentType } });
}

async function drain(response: Response) {
  const chunks: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

describe("withSseKeepAlive", () => {
  it("fills an idle gap with keepalive comment frames", async () => {
    const chunks = await drain(withSseKeepAlive(idleStream(220), 50));

    const keepalives = chunks.filter((c) => c.startsWith(":"));
    expect(keepalives.length).toBeGreaterThanOrEqual(3);
    // Every keepalive is an SSE comment frame, so a spec-compliant parser
    // (and ag-ui's, which only collects `data:` lines) ignores it.
    expect(keepalives.every((c) => c === ": keepalive\n\n")).toBe(true);
  });

  it("passes the real events through untouched and in order", async () => {
    const chunks = await drain(withSseKeepAlive(idleStream(220), 50));

    expect(chunks.filter((c) => !c.startsWith(":"))).toEqual([
      "data: start\n\n",
      "data: done\n\n",
    ]);
  });

  it("stops the timer once the stream completes", async () => {
    const before = await drain(withSseKeepAlive(idleStream(0), 20));
    await new Promise((r) => setTimeout(r, 120));
    // Nothing should have been appended after close; draining already ended.
    expect(before.filter((c) => c.startsWith(":"))).toHaveLength(0);
  });

  it("leaves a non-SSE response alone", () => {
    const json = new Response("{}", { headers: { "Content-Type": "application/json" } });
    expect(withSseKeepAlive(json, 50)).toBe(json);
  });

  it("preserves status and headers", async () => {
    const wrapped = withSseKeepAlive(idleStream(0), 50);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
  });
});
