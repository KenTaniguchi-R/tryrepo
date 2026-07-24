import { describe, expect, it } from "vitest";
import { isEmbeddable } from "@/lib/frameCheck";

const h = (init: Record<string, string>) => new Headers(init);

describe("isEmbeddable", () => {
  it("allows a response with no framing headers", () => {
    expect(isEmbeddable(h({ "content-type": "text/html" }))).toBe(true);
  });

  it("blocks X-Frame-Options DENY and SAMEORIGIN", () => {
    expect(isEmbeddable(h({ "x-frame-options": "DENY" }))).toBe(false);
    expect(isEmbeddable(h({ "x-frame-options": "sameorigin" }))).toBe(false);
  });

  it("blocks CSP frame-ancestors none and self", () => {
    expect(isEmbeddable(h({ "content-security-policy": "frame-ancestors 'none'" }))).toBe(false);
    expect(
      isEmbeddable(h({ "content-security-policy": "default-src *; frame-ancestors 'self'" }))
    ).toBe(false);
  });

  it("allows a CSP with no frame-ancestors directive", () => {
    expect(isEmbeddable(h({ "content-security-policy": "default-src 'self'" }))).toBe(true);
  });

  it("allows frame-ancestors with a wildcard", () => {
    expect(isEmbeddable(h({ "content-security-policy": "frame-ancestors *" }))).toBe(true);
  });
});
