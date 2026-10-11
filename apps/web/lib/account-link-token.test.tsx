import * as React from "react";
import { render, screen } from "@testing-library/react";
import {
  LEGACY_LINK_TTL_MS,
  LINK_FORMAT_CUTOVER_AT_MS,
  legacyQueryTokenAccepted,
  readAccountLinkToken,
  scrubAccountLinkToken,
  tokenFromHash,
  useAccountLinkToken,
} from "./account-link-token";

const T = "a".repeat(64);
const before = LINK_FORMAT_CUTOVER_AT_MS - 1;

describe("tokenFromHash", () => {
  it("reads t from the fragment", () => {
    expect(tokenFromHash(`#t=${T}`)).toBe(T);
    expect(tokenFromHash(`t=${T}`)).toBe(T);
  });
  it("is empty without a t param, or when the value is empty or absurdly long", () => {
    expect(tokenFromHash("")).toBe("");
    expect(tokenFromHash("#x=1")).toBe("");
    expect(tokenFromHash("#t=")).toBe("");
    expect(tokenFromHash(`#t=${"b".repeat(513)}`)).toBe("");
  });
});

describe("readAccountLinkToken", () => {
  it("prefers the fragment over a legacy query token", () => {
    expect(
      readAccountLinkToken({ hash: `#t=${T}`, search: "?token=legacy" }, "staffReset", before),
    ).toBe(T);
  });
  it("falls back to the legacy ?token= query when there is no fragment", () => {
    expect(readAccountLinkToken({ hash: "", search: "?token=legacy" }, "staffReset", before)).toBe(
      "legacy",
    );
  });
  it("ignores the legacy query once the flow's longest link lifetime has passed", () => {
    const loc = { hash: "", search: "?token=legacy" };
    for (const flow of Object.keys(LEGACY_LINK_TTL_MS) as Array<keyof typeof LEGACY_LINK_TTL_MS>) {
      const edge = LINK_FORMAT_CUTOVER_AT_MS + LEGACY_LINK_TTL_MS[flow];
      expect(readAccountLinkToken(loc, flow, edge - 1)).toBe("legacy");
      expect(readAccountLinkToken(loc, flow, edge)).toBe("");
      expect(legacyQueryTokenAccepted(flow, edge)).toBe(false);
    }
    // the fragment form never expires with the legacy window
    expect(
      readAccountLinkToken({ hash: `#t=${T}`, search: "" }, "buyerReset", Number.MAX_SAFE_INTEGER),
    ).toBe(T);
  });
  it("uses each flow's own TTL: set-password 72h, buyer reset 15 min, verify and merge 24h", () => {
    const H = 3_600_000;
    expect(LEGACY_LINK_TTL_MS).toEqual({
      staffReset: 72 * H,
      staffVerifyEmail: 24 * H,
      buyerReset: 15 * 60_000,
      buyerVerifyEmail: 24 * H,
      buyerMerge: 24 * H,
    });
  });
});

describe("scrubAccountLinkToken", () => {
  beforeEach(() => window.history.replaceState(null, "", "/reset-password"));

  it("removes the fragment from the address bar", () => {
    window.history.replaceState(null, "", `/reset-password#t=${T}`);
    scrubAccountLinkToken(window);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(T);
  });
  it("removes a legacy ?token= but keeps unrelated params", () => {
    window.history.replaceState(null, "", "/reset-password?token=legacy&lang=en");
    scrubAccountLinkToken(window);
    expect(window.location.search).toBe("?lang=en");
  });
});

function Probe({ flow }: { flow: "staffReset" }) {
  const { token, ready } = useAccountLinkToken(flow);
  return <p data-testid="out">{ready ? `ready:${token}` : "pending"}</p>;
}

describe("useAccountLinkToken", () => {
  it("captures the token, scrubs the address, and survives a strict-mode double effect", () => {
    window.history.replaceState(null, "", `/reset-password#t=${T}`);
    render(
      <React.StrictMode>
        <Probe flow="staffReset" />
      </React.StrictMode>,
    );
    expect(screen.getByTestId("out").textContent).toBe(`ready:${T}`);
    expect(window.location.hash).toBe("");
  });
});
