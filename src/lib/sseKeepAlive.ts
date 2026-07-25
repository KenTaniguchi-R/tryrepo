// CopilotKit's SSE writer emits agent events and nothing else -- see
// `createSseEventResponse` in @copilotkit/runtime/dist/v2/runtime/handlers/shared.
// While a tool's `execute()` runs, zero bytes cross the wire. A ~3min Docker
// build (koala73/worldmonitor) therefore leaves the response idle for minutes,
// and any proxy in front of the app kills it: measured against the Cloudflare
// tunnel this app is demoed through, the HTTP/2 stream is reset after ~126s of
// silence (curl exit 92; the same request straight to localhost:3000 completes
// fine at 150s idle). In the browser that surfaces as
// `TypeError: network error` -> CopilotKit `agent_run_failed_event`.
//
// Fix: keep the wire warm with SSE comment frames. ag-ui's parser
// (`parseSSEStream`) only collects lines starting with `data:` and skips a
// frame that yields none, so comments are inert for the client.

const KEEPALIVE_FRAME = new TextEncoder().encode(": keepalive\n\n");

/** Well under the ~126s observed cutoff, and cheap: 14 bytes per tick. */
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Wraps an SSE `Response` so that idle periods are padded with comment frames.
 * Non-SSE responses are returned untouched.
 */
export function withSseKeepAlive(
  response: Response,
  intervalMs: number = DEFAULT_INTERVAL_MS
): Response {
  const source = response.body;
  if (!source) return response;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return response;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let done = false;

  const stop = () => {
    done = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (done) return;
        // Enqueueing onto a controller whose consumer has gone away throws;
        // that just means the run is over, so shut the timer down.
        try {
          controller.enqueue(KEEPALIVE_FRAME);
        } catch {
          stop();
        }
      }, intervalMs);

      void (async () => {
        const reader = source.getReader();
        try {
          for (;;) {
            const { done: finished, value } = await reader.read();
            if (finished) break;
            if (done) return;
            controller.enqueue(value);
          }
          stop();
          controller.close();
        } catch (err) {
          stop();
          controller.error(err);
        }
      })();
    },
    cancel(reason) {
      stop();
      return source.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
