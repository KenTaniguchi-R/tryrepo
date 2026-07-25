/**
 * Whether a response permits being embedded in our iframe.
 *
 * A blocked iframe renders blank with no error event we can catch, so this is
 * checked server-side before the pane commits to embedding. Conservative by
 * design: anything other than a clearly permissive policy counts as blocked.
 */
export function isEmbeddable(headers: Headers): boolean {
  const xfo = headers.get("x-frame-options");
  if (xfo && /deny|sameorigin/i.test(xfo)) return false;

  const csp = headers.get("content-security-policy");
  if (csp) {
    const directive = csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith("frame-ancestors"));

    if (directive) {
      const value = directive.slice("frame-ancestors".length).trim().toLowerCase();
      if (!value.includes("*")) return false;
    }
  }

  return true;
}

export type FrameCheckResult = { embeddable: boolean; unreachable?: boolean };

/**
 * Interprets a probe of the preview URL.
 *
 * `deployRepo` hands out the preview URL about a second after launching the
 * app's run command, so the first probe usually lands while the app is still
 * binding its port. The Daytona proxy answers that window with a 5xx carrying
 * no framing headers -- verified against a live sandbox on a port nothing
 * listens on. Passing those headers to `isEmbeddable` yields `true` (nothing
 * forbids framing), which is how an app that *does* send
 * `X-Frame-Options: SAMEORIGIN` still ends up in an iframe the browser then
 * blocks. Treat 5xx as "ask again later" instead of a verdict.
 */
export function evaluateFrameCheck(status: number, headers: Headers): FrameCheckResult {
  if (status >= 500) return { embeddable: true, unreachable: true };
  return { embeddable: isEmbeddable(headers) };
}
