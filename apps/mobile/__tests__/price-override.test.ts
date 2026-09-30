/**
 * B263 (B246 Option B) / T1 (REG-B263-A) — `price-override.test.ts`
 *
 * `cause-ruling.md` §2 D2: a new pure `lib/price-override.ts` centralises the
 * price-override write both `PriceOverrideModal` hosts (list branch + picker
 * branch, D3) will call — `applyPriceOverride` rounds the typed price with
 * `roundMoney` (money discipline: CLAUDE.md "Round every monetary write") and
 * stamps the reason, leaving every other field of the draft row untouched; it
 * writes NO line total — the row's total is derived at render through
 * `computeLineSubtotal` with `draftFreeUnits(item)` (edit-items.tsx `:1161`),
 * the single money path — and both callers read only `.unitPrice` /
 * `.overrideReason`. `needsMarginAck` extracts the existing below-floor ack
 * check into something the picker branch can call without duplicating it.
 *
 * TODAY: `lib/price-override.ts` does not exist — the test author added a
 * signature-only stub (returns `{}` / `undefined`) so these fail on THEIR
 * OWN assertion, never on an unresolvable import or a thrown TypeError.
 *
 * Each oracle sits in its OWN `it` so Jest's stop-at-first-failing-expect
 * cannot mask the money half of T1 in a red run (red-gate audit 2026-09-08).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { applyPriceOverride, needsMarginAck } from "../lib/price-override";
import { classifyMargin, computeMarginFraction } from "@routeflow/pricing";

describe("applyPriceOverride (REG-B263-A)", () => {
  // A real `DraftItem`-shaped row (edit-items.tsx `:86-124`): free units live
  // in `promoFreeUnits`/`promoBaseUnits`, and there is no `freeUnits` and no
  // `lineTotal` field — the helper must not invent either.
  const item = {
    productId: "p1",
    lineId: "l1",
    qty: 27,
    boxes: 2,
    pieces: 3,
    unitsPerBox: 12,
    unitPrice: 10,
    catalogPrice: 10,
    name: "Widgets",
    averageCost: 6,
    category: "general",
    promoFreeUnits: 3,
    promoBaseUnits: 24,
  };
  const input = { unitPrice: 12.345, reason: "negotiated" };

  it("REG-B263-A: rounds the new unit price to cents", () => {
    // roundMoney(12.345) === 12.35 (half-away-from-zero at the cent —
    // packages/pricing/src/pricing.ts:22-42). TODAY the stub returns `{}`,
    // so `result.unitPrice` is `undefined` and this fails on ITS OWN value.
    expect(applyPriceOverride(item, input).unitPrice).toBe(12.35);
  });

  it("REG-B263-A: carries the typed reason onto overrideReason", () => {
    expect(applyPriceOverride(item, input).overrideReason).toBe("negotiated");
  });

  it("REG-B263-A: preserves every quantity field unchanged", () => {
    // Quantity fields must round-trip unchanged — an override never touches
    // how much was ordered. Own `it` so a failure above cannot hide these.
    const result = applyPriceOverride(item, input);
    expect(result.qty).toBe(27);
    expect(result.boxes).toBe(2);
    expect(result.pieces).toBe(3);
    expect(result.promoFreeUnits).toBe(3);
    expect(result.promoBaseUnits).toBe(24);
  });

  it("REG-B263-A: writes no lineTotal — the row's total stays a render-time derivation", () => {
    // The helper cannot net a BOGO line's free units (they live in
    // `promoFreeUnits`, and `draftFreeUnits(item)` is what nets them at
    // render, edit-items.tsx `:1159-1167`). A `lineTotal` written here would
    // be an over-stated second money path no caller reads.
    const result = applyPriceOverride(item, input);
    expect("lineTotal" in result).toBe(false);
  });
});

describe("PriceOverrideModal list-branch apply path (REG-B263-A, source pin)", () => {
  const SCREEN_PATH = join(
    __dirname,
    "..",
    "app",
    "(operator)",
    "(tabs)",
    "orders",
    "[id]",
    "edit-items.tsx",
  );
  const source = readFileSync(SCREEN_PATH, "utf8");

  // Split at `function ProductPicker` exactly as `edit-items-scan-price.test.ts`
  // does, so this pins the LIST branch's pre-existing mount (`:733-748`) and
  // never the picker-branch mount D3 adds.
  const splitIndex = source.indexOf("function ProductPicker");
  const parentSrc = source.slice(0, splitIndex === -1 ? source.length : splitIndex);

  // The mount's whole JSX element: `<PriceOverrideModal … />`, onSave body
  // included (the body holds no JSX, so the first `/>` closes the mount).
  const listModalMount = (parentSrc.match(/<PriceOverrideModal\b[\s\S]{0,1200}?\/>/) ?? [""])[0];

  it("REG-B263-A: the list-branch apply path routes the write through applyPriceOverride", () => {
    // The rounding lives INSIDE `applyPriceOverride` (D2), not in the JSX —
    // so pin the hand-off, not a redundant `roundMoney(` in the modal.
    expect(listModalMount.length).toBeGreaterThan(0); // sanity: the mount still exists
    // TODAY: the onSave body is a hand-rolled `setDraft` spread — zero
    // references to the helper anywhere in the list branch.
    const applyCalls = (listModalMount.match(/applyPriceOverride\(/g) ?? []).length;
    expect(applyCalls).toBeGreaterThanOrEqual(1);
  });

  it("REG-B263-A: the list-branch draft write takes its rounded price from the helper", () => {
    // POSITIVE pin, own `it`. The negative oracle below only rejects the
    // pre-fix identifier `newPrice`, so renaming the modal's callback param
    // lets a raw-price write slip past it — `unitPrice: price` survived every
    // other list-branch oracle in the mutation probe (2026-09-08). Pin the
    // hand-off itself: the price written into the draft is the one
    // `applyPriceOverride` rounded. Red at HEAD (`unitPrice: newPrice`).
    expect(listModalMount.length).toBeGreaterThan(0); // sanity: the mount still exists
    expect(listModalMount).toMatch(/unitPrice:\s*updated\.unitPrice\b/);
  });

  it("REG-B263-A: the list-branch draft write takes its reason from the helper", () => {
    // Its own `it` so the price pin above cannot mask it — the stamped reason
    // is the helper's too, not a second hand-rolled `reason || undefined`.
    // Red at HEAD (`overrideReason: reason || undefined`).
    expect(listModalMount.length).toBeGreaterThan(0); // sanity: the mount still exists
    expect(listModalMount).toMatch(/overrideReason:\s*updated\.overrideReason\b/);
  });

  it("REG-B263-A: the list-branch apply path no longer writes the raw typed price", () => {
    expect(listModalMount.length).toBeGreaterThan(0); // sanity: the mount still exists
    // TODAY: `unitPrice: newPrice,` — the raw typed value, unrounded (the
    // bug). This fails on the bug's OWN wrong source text.
    expect(listModalMount).not.toMatch(/unitPrice:\s*newPrice\b/);
  });
});

describe("needsMarginAck (REG-B263-A)", () => {
  it("REG-B263-A: true when the new price sits below the floor", () => {
    const item = { unitPrice: 10, catalogPrice: 10 };
    // TODAY the stub returns `undefined` — fails cleanly against `true`
    // rather than throwing.
    expect(needsMarginAck(item, 9.99, 10)).toBe(true);
  });

  it("REG-B263-A: false when the new price meets the floor exactly", () => {
    const item = { unitPrice: 10, catalogPrice: 10 };
    expect(needsMarginAck(item, 10, 10)).toBe(false);
  });

  it("REG-B263-A: false when there is no floor (unknown cost)", () => {
    // A row with no average cost yields no floor — no ack can ever be needed,
    // whatever the typed price.
    const item = { unitPrice: 10, catalogPrice: 10 };
    expect(needsMarginAck(item, 0.01, null)).toBe(false);
  });
});

describe("below-floor message class distinguishes cost from floor (REG-B263-H)", () => {
  // Finding B263-H: `needsMarginAck` alone only says "ack needed" — it can't
  // tell a caller WHICH message to show. Both edit-items.tsx surfaces (list
  // row + picker strip) additionally call `classifyMargin` on the margin
  // FRACTION for that; pin the boundary the bug got wrong so it can't drift
  // back: a price at or above cost (non-negative margin) but still under the
  // category floor must classify as "belowFloor" (-> the "Below floor · X%
  // margin" wording), never "belowCost" (-> "Below cost (X%)").
  it("REG-B263-H: price >= cost but < floor yields belowFloor, not belowCost", () => {
    // Finding's own repro numbers: cost $7.00/unit, price $8.00 -> 12.5%
    // margin — non-negative (not below cost) and under a 0.15 floor.
    const marginFrac = computeMarginFraction(8.0, 7.0, null);
    expect(marginFrac).not.toBeNull();
    expect(marginFrac!).toBeGreaterThanOrEqual(0);
    expect(classifyMargin(marginFrac, 0.15)).toBe("belowFloor");
    expect(classifyMargin(marginFrac, 0.15)).not.toBe("belowCost");
  });

  it("REG-B263-H: price below cost yields belowCost", () => {
    const marginFrac = computeMarginFraction(6.5, 7.0, null);
    expect(marginFrac).not.toBeNull();
    expect(marginFrac!).toBeLessThan(0);
    expect(classifyMargin(marginFrac, 0.15)).toBe("belowCost");
  });
});
