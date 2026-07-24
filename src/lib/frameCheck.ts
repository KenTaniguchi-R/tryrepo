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
