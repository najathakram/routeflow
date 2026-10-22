/**
 * SA-815c / SA-815d (owner rulings; SA-690 amended). ONE predicate answers "does the card checkout bill this admin-only
 * add-on row": `isStripeBillableAddonRow`. It decides BILLING only - the ledger's booking at the reactivation crossing
 * is deliberately unchanged, so live MRR and ledger MRR keep agreeing.
 *
 *  - unit: the predicate's truth table (active, non-comp, priced above zero AND equal to the billing catalog price,
 *    never seat plumbing);
 *  - pin: the adoption's (c) loop (`adoptCheckoutAddons`) decides through it, and neither spells the seat exclusion nor
 *    keeps the old admin-only branch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isPricedBillableCandidate, isStripeBillableAddonRow } from "./addon-row";

const row = (over: Record<string, unknown> = {}) => ({
  addonKey: "REGULATED_ITEMS",
  sku: "REGULATED_ITEMS",
  active: true,
  isComp: false,
  priceSnapshot: 39,
  ...over,
});

describe("SA-815d isStripeBillableAddonRow", () => {
  it("an active, non-comp row priced above zero AT the catalog price is billable (cents-equal, any price type)", () => {
    expect(isStripeBillableAddonRow(row(), 39)).toBe(true);
    expect(isStripeBillableAddonRow(row({ addonKey: "tobacco_dealer", sku: null }), 39)).toBe(true);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: "12.50" }), 12.5)).toBe(true);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 12.5 }), "12.50")).toBe(true);
  });

  it("a price that differs from the catalog (above or below) is not billable", () => {
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 45 }), 39)).toBe(false);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 29 }), 39)).toBe(false);
  });

  it("a catalog price of $0, or no catalog entry, is never billable (even for a priced row)", () => {
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 20 }), 0)).toBe(false);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 20 }), null)).toBe(false);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 20 }), undefined)).toBe(false);
  });

  it("a $0 or unpriced row is not billable", () => {
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 0 }), 0)).toBe(false);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: 0 }), 39)).toBe(false);
    expect(isStripeBillableAddonRow(row({ priceSnapshot: null }), 39)).toBe(false);
  });

  it("a comp row is never billable, even with a stale price at the catalog price", () => {
    expect(isStripeBillableAddonRow(row({ isComp: true }), 39)).toBe(false);
  });

  it("an inactive row is not billable", () => {
    expect(isStripeBillableAddonRow(row({ active: false }), 39)).toBe(false);
  });

  it("SEAT_EXTRA is never billable: seats bill through the plan quantity, not an add-on item", () => {
    const seat = { addonKey: "SEAT_EXTRA", sku: "SEAT_EXTRA", priceSnapshot: 8 };
    expect(isStripeBillableAddonRow(row(seat), 8)).toBe(false);
    expect(isPricedBillableCandidate(row(seat))).toBe(false);
    // keyed by the raw addonKey only
    expect(isStripeBillableAddonRow(row({ ...seat, sku: null }), 8)).toBe(false);
  });

  it("a candidate is an active, non-comp, non-seat row priced above zero (the rows a mismatch notice is raised for)", () => {
    expect(isPricedBillableCandidate(row())).toBe(true);
    expect(isPricedBillableCandidate(row({ priceSnapshot: 0 }))).toBe(false);
    expect(isPricedBillableCandidate(row({ isComp: true }))).toBe(false);
    expect(isPricedBillableCandidate(row({ active: false }))).toBe(false);
  });
});

const BILLING = __dirname;
const read = (f: string) => fs.readFileSync(path.join(BILLING, f), "utf8");
const codeOnly = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
/** The code of the method `name` (from its signature to the next member at the same indent). */
function method(file: string, name: string): string {
  const text = read(file);
  const start = text.search(new RegExp("\\n  (?:private |public )?(?:async )?" + name + "\\("));
  expect(start).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}(?:\/\*\*|(?:private |public |async )*\w+\()/);
  return codeOnly(end < 0 ? rest : rest.slice(0, end + 1));
}

describe("SA-815c the checkout adoption bills through ONE predicate (pin)", () => {
  it("adoptCheckoutAddons' (c) loop decides through isStripeBillableAddonRow and spells neither the seat exclusion nor the old admin-only branch", () => {
    const body = method("subscription-mutation.service.ts", "adoptCheckoutAddons");
    expect(body).toMatch(/isStripeBillableAddonRow\(/);
    expect(body).not.toMatch(/SEAT_EXTRA/);
    expect(body).not.toMatch(/adminPriced/);
  });

  it("the seat exclusion is stated once, inside the predicate's module, with its reason", () => {
    const leaf = read("addon-row.ts");
    expect(codeOnly(leaf)).toMatch(/SEAT_EXTRA/);
    expect(leaf).toMatch(/plan quantity/);
  });

  it("the booking is NOT routed through it (SA-815d: live MRR and ledger MRR keep agreeing)", () => {
    for (const f of ["billing.service.ts", "billing-cron.service.ts", "coupon-state.ts"]) {
      expect(codeOnly(read(f))).not.toMatch(/isStripeBillableAddonRow/);
    }
  });

  it("structural: across the whole api source, ONLY adoptCheckoutAddons, billUnbilledRow and the read-only restore verdict call it (never the claim, the booking or any ledger writer)", () => {
    const SRC = path.join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) files.push(full);
      }
    };
    walk(SRC);
    expect(files.length).toBeGreaterThan(500); // the scan really saw the source tree
    const callers: string[] = [];
    for (const f of files) {
      const code = codeOnly(fs.readFileSync(f, "utf8"));
      // a CALL expression: not the import, not the definition (`export function name(`)
      const re = /(?<!function\s)(?<!\.)\bisStripeBillableAddonRow\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        const before = code.slice(0, m.index);
        const members = [
          ...before.matchAll(/\n {2}(?:private |public |protected )?(?:async )?(\w+)\(/g),
        ];
        const owner = members.length ? members[members.length - 1][1] : "<module>";
        callers.push(`${path.relative(SRC, f).split(path.sep).join("/")}#${owner}`);
      }
    }
    expect(callers.sort()).toEqual([
      // Row 640, SA-834: a restored GRANT is covered only by an active row that passes the billed-row
      // predicate. This is a read-only verdict (overrideRestoreVerdict) - it never bills, claims, books or
      // writes a ledger row. The `#owner` is this scan's heuristic (the last 2-space-indented `name(` above
      // the call - the AddonCoverage interface member), not the function's own name.
      "billing/override-restore-verdict.ts#grantsFlagsOf",
      "billing/subscription-mutation.service.ts#adoptCheckoutAddons",
      "billing/subscription-mutation.service.ts#billUnbilledRow",
    ]);
  });
});
