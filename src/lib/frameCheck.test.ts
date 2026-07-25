import { describe, expect, it } from "vitest";
import { evaluateFrameCheck, isEmbeddable } from "@/lib/frameCheck";

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

describe("evaluateFrameCheck", () => {
  // The Daytona proxy answers 502 with no framing headers for the ~seconds
  // between deployRepo handing out the URL and the app binding its port.
  // Verified against a live sandbox on a port nothing listens on. Reading that
  // as "no headers, so embeddable" is what commits the pane to an iframe the
  // app later refuses -- the broken-frame icon.
  it("reports a booting app as unreachable, not embeddable", () => {
    expect(evaluateFrameCheck(502, h({}))).toEqual({ embeddable: true, unreachable: true });
    expect(evaluateFrameCheck(503, h({}))).toEqual({ embeddable: true, unreachable: true });
    expect(evaluateFrameCheck(504, h({}))).toEqual({ embeddable: true, unreachable: true });
  });

  it("gives a definitive answer once the app responds", () => {
    expect(evaluateFrameCheck(200, h({ "x-frame-options": "SAMEORIGIN" }))).toEqual({
      embeddable: false,
    });
    expect(evaluateFrameCheck(200, h({ "content-type": "text/html" }))).toEqual({
      embeddable: true,
    });
  });

  it("treats a 4xx from the app itself as definitive", () => {
    // A 404 comes from the app, so its framing headers are trustworthy.
    expect(evaluateFrameCheck(404, h({ "x-frame-options": "DENY" }))).toEqual({
      embeddable: false,
    });
  });
});
