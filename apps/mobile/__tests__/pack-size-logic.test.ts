import { packSizePromptFor, parsePackSize } from "../lib/pack-size-logic";
import type { PackSizeSuggestion } from "@routeflow/types";
import { buildProductPayload, emptyProductForm } from "../lib/product-form";
// NOTE: `parsePackSize` now lives in lib/pack-size-logic.ts rather than
// inside PackSizeSheet.tsx. That move is what makes it testable at all:
// this Jest project only transforms plain `.ts` pure logic, so a copy in a
// `.tsx` component fails to parse ("Unexpected token '<'") and silently
// escapes coverage — which is how its floor-before-validate bug shipped.

// Suggestions mirror the shape `suggestPackSize()` (@routeflow/types) actually
// returns, `reason` text included — packSizePromptFor is intentionally "dumb"
// and shows the parser's own reason rather than inventing its own copy, so
// these fixtures use realistic reason strings rather than leaving them blank.
function suggestion(overrides: Partial<PackSizeSuggestion>): PackSizeSuggestion {
  return {
    packSize: null,
    counts: [],
    confidence: null,
    reason: null,
    ...overrides,
  };
}

describe("packSizePromptFor", () => {
  it("returns null when there is no suggestion at all", () => {
    expect(packSizePromptFor(null)).toBeNull();
    expect(packSizePromptFor(undefined)).toBeNull();
  });

  it("returns null when confidence is null (nothing detected, or unitsPerBox already set)", () => {
    expect(packSizePromptFor(suggestion({ confidence: null }))).toBeNull();
  });

  it("never prompts for a PIECE_UNIT product, even with a clean count in the name", () => {
    const s = suggestion({
      confidence: "PIECE_UNIT",
      packSize: 12,
      counts: [12],
      reason: "Sold by the piece already — a pack size here would divide the piece price.",
    });
    expect(packSizePromptFor(s)).toBeNull();
  });

  it("AMBIGUOUS yields an EMPTY initial value — never pre-fills either count", () => {
    // "…5CT - 12Pack" — the single most important case: must never resolve to 5 or 12.
    const s = suggestion({
      confidence: "AMBIGUOUS",
      packSize: null,
      counts: [5, 12],
      reason:
        "This name mentions two different counts (5 and 12) — tell us which one the price is for.",
    });
    const prompt = packSizePromptFor(s);
    expect(prompt).not.toBeNull();
    expect(prompt!.initialValue).toBe("");
    expect(prompt!.initialValue).not.toBe("5");
    expect(prompt!.initialValue).not.toBe("12");
    expect(prompt!.message).toContain("5");
    expect(prompt!.message).toContain("12");
  });

  it("AMBIGUOUS still yields an empty initial value even with no reason text", () => {
    const s = suggestion({ confidence: "AMBIGUOUS", counts: [3, 6], reason: null });
    const prompt = packSizePromptFor(s);
    expect(prompt).not.toBeNull();
    expect(prompt!.initialValue).toBe("");
    expect(prompt!.message.length).toBeGreaterThan(0);
  });

  it("HIGH pre-fills the parsed count", () => {
    const s = suggestion({
      confidence: "HIGH",
      packSize: 24,
      counts: [24],
      reason: "Looks like this is sold in a box of 24. Set pack size?",
    });
    const prompt = packSizePromptFor(s);
    expect(prompt).not.toBeNull();
    expect(prompt!.initialValue).toBe("24");
    expect(prompt!.message).toContain("24");
  });

  it("MEDIUM pre-fills the parsed count", () => {
    const s = suggestion({
      confidence: "MEDIUM",
      packSize: 10,
      counts: [10],
      reason: "The name mentions a count of 10 — is this sold in a box of 10?",
    });
    const prompt = packSizePromptFor(s);
    expect(prompt).not.toBeNull();
    expect(prompt!.initialValue).toBe("10");
  });

  it("LOW asks quietly with an EMPTY initial value (packish unit, no count)", () => {
    const s = suggestion({
      confidence: "LOW",
      packSize: null,
      counts: [],
      reason: "How many pieces are in a box?",
    });
    const prompt = packSizePromptFor(s);
    expect(prompt).not.toBeNull();
    expect(prompt!.initialValue).toBe("");
    expect(prompt!.message.length).toBeGreaterThan(0);
  });

  it("never pre-fills a number for HIGH/MEDIUM if the parser somehow omits packSize", () => {
    const s = suggestion({ confidence: "MEDIUM", packSize: null, counts: [], reason: "…" });
    const prompt = packSizePromptFor(s);
    expect(prompt).not.toBeNull();
    expect(prompt!.initialValue).toBe("");
  });
});

// WP3 — apps/mobile/lib/product-form.ts:190 had the identical compare-then-
// floor flaw: `upbRaw > 1 ? Math.floor(upbRaw) : undefined` let "1.5" pass
// the guard (1.5 > 1) and floor to 1, silently writing unitsPerBox = 1.
describe("buildProductPayload — unitsPerBox floors before validating (WP3)", () => {
  function payloadFor(unitsPerBox: string) {
    return buildProductPayload({
      ...emptyProductForm(),
      name: "Widget",
      pricePerUnit: "9.99",
      unitsPerBox,
    });
  }

  it('"1.5" must NOT write unitsPerBox = 1 — it is omitted entirely', () => {
    const result = payloadFor("1.5");
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.unitsPerBox).toBeUndefined();
  });

  it('"1" is omitted (no box packaging)', () => {
    const result = payloadFor("1");
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.unitsPerBox).toBeUndefined();
  });

  it('"0" is omitted', () => {
    const result = payloadFor("0");
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.unitsPerBox).toBeUndefined();
  });

  it('"" (blank) is omitted', () => {
    const result = payloadFor("");
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.unitsPerBox).toBeUndefined();
  });

  it('"12" is kept as the integer 12', () => {
    const result = payloadFor("12");
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.unitsPerBox).toBe(12);
  });

  it('a valid fractional above the sentinel floors, e.g. "12.9" -> 12', () => {
    const result = payloadFor("12.9");
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.unitsPerBox).toBe(12);
  });
});

// ─── parsePackSize — the operator-typed value ────────────────────────────────
// This guard shipped a real bug: it compared the raw input against the bound
// and only floored afterwards, so "1.5" passed `n <= 1` and returned 1 — the
// meaningless "no packaging" value the guard exists to reject, and one the web
// surface refuses outright. It now lives in this pure module precisely so these
// cases can run: while it sat inside PackSizeSheet.tsx, jest.config.js's
// pure-logic-only transform could not load it at all.
describe("parsePackSize", () => {
  it("rejects a fractional value instead of flooring it to the sentinel 1", () => {
    expect(parsePackSize("1.5")).toBeNull();
    expect(parsePackSize("1.99")).toBeNull();
  });

  it("rejects values that mean 'no packaging' or are out of range", () => {
    for (const bad of ["1", "0", "-3", "1001", "abc", "", "   "]) {
      expect(parsePackSize(bad)).toBeNull();
    }
  });

  it("accepts a real pack size and floors a fraction above the bound", () => {
    expect(parsePackSize("12")).toBe(12);
    expect(parsePackSize(" 24 ")).toBe(24);
    expect(parsePackSize("1000")).toBe(1000);
    // 12.9 is unambiguously "more than a box of 12", so flooring is safe here —
    // unlike 1.5, which floors onto the rejected sentinel.
    expect(parsePackSize("12.9")).toBe(12);
  });
});
