import { readFileSync } from "fs";
import { join } from "path";

/**
 * B1395 (SA-1292, OP-7): count-pinned, SHRINK-ONLY inventory of the raw `qty +/- 1` step in the buyer EDIT grids.
 *
 * On a boxed line `qty` counts PIECES, so a `qty + 1` is one PIECE per tap: "+" on a stored 3-box line (12 a box,
 * $18.00 a box) sent 37 pieces and priced $55.50 instead of 48 and $72.00. Both grids now step, type and clamp through
 * `editRowCount` / `setEditRowCount` (buyer-edit-line.ts); a count is stepped in the row's selling unit and `qty` is
 * only ever written by `setEditRowCount`.
 *
 * Baseline at af0c966c5e: web order page 2 hits, mobile edit-items 2, mobile buyer-edit-items 1. Target 0 each: the
 * map may only ever shrink, and a reintroduced raw step fails the build. Sibling of no-raw-qty-beside-price.pin.spec.ts.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const RAW_QTY_STEP = /\bqty\s*[+-]\s*1\b/g;

const PIN: Record<string, number> = {
  "apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx": 0,
  "apps/mobile/app/(customer)/orders/[id]/edit-items.tsx": 0,
  "apps/mobile/lib/buyer-edit-items.ts": 0,
};

describe("no raw qty +/- 1 step in the buyer edit grids (B1395, SA-1292)", () => {
  it.each(Object.entries(PIN))("%s holds exactly %i raw steps (shrink-only)", (file, n) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    expect(src.match(RAW_QTY_STEP)?.length ?? 0).toBe(n);
  });

  it("the pin only shrinks: no entry above its baseline, and none was added", () => {
    expect(Object.keys(PIN).sort()).toEqual([
      "apps/mobile/app/(customer)/orders/[id]/edit-items.tsx",
      "apps/mobile/lib/buyer-edit-items.ts",
      "apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx",
    ]);
    for (const n of Object.values(PIN)) expect(n).toBeLessThanOrEqual(0);
  });

  it.each([
    ["{ ...i, qty: Math.max(1, i.qty - 1) }", 1],
    ["{ ...i, qty: i.qty + 1 }", 1],
    ["setQty(draftKey(item), item.qty - 1)", 1],
    ["{ ...held, qty: held.qty + 1 }", 1],
    ["qty+1 and qty -1", 2],
    ["setEditRowCount(editRowOf(i), n)", 0],
    ["draftCount(item) + 1", 0],
    ["qty: 1, unitPrice", 0],
  ])("anti-vacuity: the raw-step detector sees %s -> %i", (text, n) => {
    expect(text.match(RAW_QTY_STEP)?.length ?? 0).toBe(n);
  });
});
