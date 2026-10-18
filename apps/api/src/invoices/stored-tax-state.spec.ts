import { readdirSync, readFileSync } from "fs";
import path from "path";
import { ConflictException } from "@nestjs/common";
import { NSF_FEE_SYSTEM_KIND } from "@routeflow/pricing";
import {
  assertTaxStateRecomputable,
  guardItemsEditTaxState,
  taxStateOf,
  TAX_STATE_STALE_COPY,
} from "./stored-tax-state";

/**
 * SA-814 R5-2 — the ONE guard for "can the stored lines reproduce the stored tax?". Pure unit cases for the
 * helper, plus the structural pin: no `sumInvoiceTotals*` over STORED rows in `invoices/**` outside the
 * helper's callers. The behavioural proof through the three recompute paths is
 * invoices.service.stored-tax-state.spec.ts.
 */
const base = { canRestamp: true, path: "PRICE_ADJUSTMENT" as const };
// $10,000 at 8.875%: the inferred rate rounds to 0.0888, and 10000 x 0.0888 = 888.00 != 887.50.
const UNVERIFIABLE = { subtotal: 10000, taxAmount: 887.5 };
const VERIFIED = { subtotal: 100, taxAmount: 7.5 };
const zero = (subtotal: number) => ({ subtotal, taxRate: 0, categoryTaxAmount: 0 });

describe("assertTaxStateRecomputable", () => {
  it("lines that reproduce the stored tax pass, with nothing to re-stamp", () => {
    const v = assertTaxStateRecomputable({
      ...base,
      invoice: VERIFIED,
      storedLines: [{ subtotal: 100, taxRate: 0.075 }],
    });
    expect(v).toMatchObject({ stale: false, restampRate: null });
    expect(v.totals.tax).toBe(7.5);
  });

  it("the regulated levy counts: sum(subtotal x rate) + sum(category tax) is the stored tax", () => {
    const v = assertTaxStateRecomputable({
      ...base,
      invoice: { subtotal: 100, taxAmount: 10.5 },
      storedLines: [{ subtotal: 100, taxRate: 0.075, categoryTaxAmount: 3 }],
    });
    expect(v.stale).toBe(false);
  });

  it("a cent of difference is stale (beyond half a cent)", () => {
    expect(() =>
      assertTaxStateRecomputable({
        ...base,
        invoice: { subtotal: 100, taxAmount: 7.51 },
        storedLines: [{ subtotal: 100, taxRate: 0.075 }],
      }),
    ).toThrow(ConflictException);
  });

  it("every-line-zero with a real header tax that does NOT verify is a 409 INVOICE_TAX_STATE_STALE", () => {
    const run = () =>
      assertTaxStateRecomputable({ ...base, invoice: UNVERIFIABLE, storedLines: [zero(10000)] });
    expect(run).toThrow(ConflictException);
    try {
      run();
    } catch (e) {
      expect((e as ConflictException).getResponse()).toEqual({
        code: "INVOICE_TAX_STATE_STALE",
        message: TAX_STATE_STALE_COPY.PRICE_ADJUSTMENT,
        path: "PRICE_ADJUSTMENT",
      });
    }
  });

  it("every-line-zero that VERIFIES hands back the rate to stamp instead of throwing", () => {
    const v = assertTaxStateRecomputable({ ...base, invoice: VERIFIED, storedLines: [zero(100)] });
    expect(v).toMatchObject({ stale: true, restampRate: 0.075 });
  });

  it("a caller that cannot stamp (header-only) is refused even when the rate would verify", () => {
    expect(() =>
      assertTaxStateRecomputable({
        ...base,
        canRestamp: false,
        invoice: VERIFIED,
        storedLines: [zero(100)],
      }),
    ).toThrow(ConflictException);
  });

  it("a mixed-rate invoice is never inferred: stale rows are a 409", () => {
    expect(() =>
      assertTaxStateRecomputable({
        ...base,
        invoice: { subtotal: 100, taxAmount: 7.5 },
        storedLines: [
          { subtotal: 50, taxRate: 0.05 },
          { subtotal: 50, taxRate: 0 },
        ],
      }),
    ).toThrow(ConflictException);
  });

  it("the NSF fee line is excluded from the inferred rate (goods only, #2656)", () => {
    const v = taxStateOf({
      ...base,
      invoice: { subtotal: 125, taxAmount: 7.5 },
      storedLines: [zero(100), { ...zero(25), systemKind: NSF_FEE_SYSTEM_KIND }],
    });
    expect(v).toMatchObject({ stale: true, restampRate: 0.075 });
  });

  it("an exempt customer's rated lines reproduce a stored tax of 0 when the caller honours exemption", () => {
    const v = assertTaxStateRecomputable({
      ...base,
      isTaxExempt: true,
      invoice: { subtotal: 100, taxAmount: 0 },
      storedLines: [{ subtotal: 100, taxRate: 0.075 }],
    });
    expect(v.stale).toBe(false);
  });

  it("an exempt customer's invoice that still carries a levy snapshot is stale when the caller refuses it (and is never re-stamped)", () => {
    const v = taxStateOf({
      ...base,
      isTaxExempt: true,
      refuseExemptLevy: true,
      invoice: { subtotal: 100, taxAmount: 0 },
      storedLines: [{ subtotal: 100, taxRate: 0, categoryTaxAmount: 5 }],
    });
    expect(v).toMatchObject({ stale: true, restampRate: null });
    // the items edit zeroes the snapshot itself, so it does not ask for that rule
    expect(
      taxStateOf({
        ...base,
        isTaxExempt: true,
        invoice: { subtotal: 100, taxAmount: 0 },
        storedLines: [{ subtotal: 100, taxRate: 0, categoryTaxAmount: 5 }],
      }).stale,
    ).toBe(false);
  });

  it("returns the discount and shipping total from the same formula (header-only reads it)", () => {
    const v = assertTaxStateRecomputable({
      ...base,
      canRestamp: false,
      invoice: VERIFIED,
      storedLines: [{ subtotal: 100, taxRate: 0.075 }],
      discount: 5,
      shipping: 2,
    });
    expect(v.totals.total).toBe(104.5);
  });
});

describe("guardItemsEditTaxState (the DRAFT items edit)", () => {
  const lockedOf = (invoice: object, storedRows: any[], isTaxExempt = false) => ({
    invoice,
    storedRows,
    isTaxExempt,
  });
  const row = (id: string, subtotal: number, taxRate = 0, extra: object = {}) => ({
    id,
    subtotal,
    taxRate,
    categoryTaxAmount: 0,
    ...extra,
  });
  const edited = (r: { id: string; taxRate: number }) => ({
    rowId: r.id as string | null,
    data: { taxRate: r.taxRate } as Record<string, any>,
  });

  it("a consistent stored state is untouched", () => {
    const r = row("a", 100, 0.075);
    const lines = [edited(r)];
    guardItemsEditTaxState({
      locked: lockedOf(VERIFIED, [r]),
      items: [{ taxRate: 0.075 }],
      matches: [{ row: r }],
      editLines: lines,
    });
    expect(lines[0].data.taxRate).toBe(0.075);
  });

  it("an exempt customer's draft proceeds even when its stored tax was charged at creation", () => {
    const r = row("a", 100, 0.075);
    expect(() =>
      guardItemsEditTaxState({
        locked: lockedOf({ subtotal: 100, taxAmount: 7.5 }, [r], true),
        items: [{ taxRate: 0.075 }],
        matches: [{ row: r }],
        editLines: [edited(r)],
      }),
    ).not.toThrow();
  });

  it("the web re-send of a stored rate 0 on an unverifiable invoice is a 409", () => {
    const r = row("a", 10000, 0);
    expect(() =>
      guardItemsEditTaxState({
        locked: lockedOf(UNVERIFIABLE, [r]),
        items: [{ taxRate: 0 }],
        matches: [{ row: r }],
        editLines: [edited(r)],
      }),
    ).toThrow(ConflictException);
    expect(TAX_STATE_STALE_COPY.DRAFT_EDIT.length).toBeGreaterThan(0);
  });

  it("a kept line whose payload rate differs from the stored one is the user's own change: proceeds", () => {
    const r = row("a", 10000, 0);
    expect(() =>
      guardItemsEditTaxState({
        locked: lockedOf(UNVERIFIABLE, [r]),
        items: [{ taxRate: 0.0888 }],
        matches: [{ row: r }],
        editLines: [edited({ id: "a", taxRate: 0.0888 })],
      }),
    ).not.toThrow();
  });

  it("no stored line kept (a full rewrite) proceeds", () => {
    const r = row("a", 10000, 0);
    expect(() =>
      guardItemsEditTaxState({
        locked: lockedOf(UNVERIFIABLE, [r]),
        items: [{ taxRate: 0 }],
        matches: [{ row: null }],
        editLines: [{ rowId: null, data: { taxRate: 0 } }],
      }),
    ).not.toThrow();
  });

  it("a verified inferred rate is stamped on the kept rate-0 goods lines only (not new lines, not NSF)", () => {
    const a = row("a", 60);
    const b = row("b", 15);
    const nsf = row("n", 25, 0, { systemKind: NSF_FEE_SYSTEM_KIND });
    const lines = [edited(a), edited(b), edited(nsf), { rowId: null, data: { taxRate: 0 } }];
    guardItemsEditTaxState({
      locked: lockedOf({ subtotal: 100, taxAmount: 5.63 }, [a, b, nsf]),
      items: [{ taxRate: 0 }, { taxRate: 0 }, { taxRate: 0 }, { taxRate: 0 }],
      matches: [{ row: a }, { row: b }, { row: nsf }, { row: null }],
      editLines: lines,
    });
    // goods are 75 of the 100 subtotal: 5.63 / 75 = 0.0751 verifies (75 x 0.0751 = 5.6325 -> 5.63)
    expect(lines.map((l) => l.data.taxRate)).toEqual([0.0751, 0.0751, 0, 0]);
  });
});

/**
 * The structural pin. `sumInvoiceTotals*` over rows STORED in the database is the recompute this guard
 * protects, so a file in `invoices/**` that imports it must be a known caller, and the stored-row readers
 * (header-only totals, price-adjustment totals) must route through the guard.
 */
describe("no sumInvoiceTotals* over stored rows outside the guard's callers", () => {
  const dir = __dirname;
  const sources = readdirSync(dir, { recursive: true } as any)
    .map(String)
    .filter((f) => f.endsWith(".ts") && !/\.(spec|db\.spec)\.ts$/.test(f))
    .map((f) => ({
      file: f.split(path.sep).join("/"),
      text: readFileSync(path.join(dir, f), "utf8"),
    }));
  const importsTotals = (text: string) => /import[^;]*\bsumInvoiceTotals\w*[^;]*from/.test(text);

  /** file -> why its sum is NOT a recompute of stored tax. */
  const ALLOWED: Record<string, string> = {
    "stored-tax-state.ts": "the guard itself: the one sum over stored rows",
    "invoices.service.ts":
      "create() / duplicate sum the lines they BUILD; update() sums the edited lines after guardItemsEditTaxState",
    "manual-invoice-context.ts": "foldCategoryTax: the levy of lines being built",
    "price-adjustment-ledger.ts":
      "totalsFromLines: the re-priced lines' totals with the exemption, behind priceAdjustmentTaxState",
    "partial-price-follow.ts":
      "re-prices a draft at the order-derived rate; it never reuses a stored rate",
  };

  it("every file that imports the totals builder is a known caller", () => {
    const importers = sources.filter((s) => importsTotals(s.text)).map((s) => s.file);
    expect(importers.filter((f) => !(f in ALLOWED)).sort()).toEqual([]);
  });

  it("the allow-list holds no stale rows", () => {
    const importers = new Set(sources.filter((s) => importsTotals(s.text)).map((s) => s.file));
    expect(Object.keys(ALLOWED).filter((f) => !importers.has(f))).toEqual([]);
  });

  const text = (f: string) => sources.find((s) => s.file === f)!.text;

  it("price adjustment (tx and bulk pre-flight), the items edit and the header-only path all call the guard", () => {
    expect(text("invoices.service.ts")).toMatch(/priceAdjustmentTaxState\(live,/);
    expect(text("price-adjustment-ledger.ts")).toMatch(
      /priceAdjustmentTaxState\(\s*\{\s*\.\.\.inv,/,
    );
    expect(text("invoices.service.ts")).toMatch(/guardItemsEditTaxState\(\{/);
    expect(text("locked-invoice-edit.ts")).toMatch(/assertTaxStateRecomputable\(\{/);
  });

  it("invoices.service.ts runs exactly 3 totals sums: create(), duplicate (both on lines they build) and update() AFTER its guard", () => {
    const svc = text("invoices.service.ts");
    const calls = [...svc.matchAll(/\bsumInvoiceTotalsStrict\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(3);
    // the middle one is update()'s edited-lines sum: it must come after guardItemsEditTaxState({
    const guardAt = svc.indexOf("guardItemsEditTaxState({");
    expect(guardAt).toBeGreaterThan(0);
    expect(calls[0]).toBeLessThan(guardAt);
    expect(calls[1]).toBeGreaterThan(guardAt);
    expect(calls[2]).toBeGreaterThan(calls[1]);
  });

  it("totalsFromLines (Σ subtotal x stored rate) is only ever called inside the price-adjustment module", () => {
    const callers = sources.filter((s) => /\btotalsFromLines\(/.test(s.text)).map((s) => s.file);
    expect(callers).toEqual(["price-adjustment-ledger.ts"]);
  });
});
