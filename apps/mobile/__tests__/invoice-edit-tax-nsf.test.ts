import { hydratedLineTax } from "../lib/invoice-edit-tax";

/**
 * #2392 (a): the NSF bounce-fee line is never taxed by the mobile invoice edit.
 *
 * `hydratedLineTax` inferred the flat rate from the HEADER subtotal, which includes the untaxed NSF
 * fee, and filled that diluted rate onto every 0-rate line — the NSF line included. A $125 invoice
 * ($100 goods + $25 NSF fee) with $7.50 tax (7.5% on goods) inferred 7.5 / 125 = 0.06 (it verifies:
 * 125 × 0.06 = 7.50), so the goods line was under-rated AND the fee was taxed on the next save.
 * The NSF line is excluded from the inference AND the fill: rate = 7.5 / 100 = 0.075 on goods only.
 */
const goods = { taxRate: 0, subtotal: 100, description: "Sample Cola 12pk", systemKind: null };
const stampedNsf = {
  taxRate: 0,
  subtotal: 25,
  description: "NSF fee — returned check #1042",
  systemKind: "NSF_FEE",
};
// The #2169 transition leg: a pre-backfill NSF line carries only the description prefix.
const legacyNsf = { ...stampedNsf, systemKind: null };

describe("#2392 (a) — the NSF fee line is excluded from the tax inference and the fill", () => {
  it.each([
    ["a stamped NSF line (systemKind NSF_FEE)", stampedNsf],
    ["a pre-backfill NSF line (description prefix, systemKind null)", legacyNsf],
  ])("%s: goods load at 0.075 taxable; the fee loads untaxed", (_l, nsf) => {
    expect(hydratedLineTax({ subtotal: 125, taxAmount: 7.5, items: [goods, nsf] as any })).toEqual([
      { taxRate: 0.075, taxable: true },
      { taxRate: 0, taxable: false },
    ]);
  });

  it("a line whose description merely mentions NSF elsewhere is NOT the fee line", () => {
    const lookalike = { ...goods, subtotal: 25, description: "Snack pack (NSF certified)" };
    expect(
      hydratedLineTax({ subtotal: 125, taxAmount: 9.38, items: [goods, lookalike] as any }),
    ).toEqual([
      { taxRate: 0.075, taxable: true },
      { taxRate: 0.075, taxable: true },
    ]);
  });

  it("an invoice holding only an NSF line infers nothing and taxes nothing", () => {
    expect(hydratedLineTax({ subtotal: 25, taxAmount: 0, items: [stampedNsf] as any })).toEqual([
      { taxRate: 0, taxable: false },
    ]);
  });
});

// #2656 / SA-549: the NSF line is never taxed — the API refuses a rate > 0 on it — so a legacy draft
// whose NSF line was STORED taxed loads at 0, untaxable; the next save sends 0 and heals the row.
describe("#2656 — a legacy NSF line stored taxed loads untaxed", () => {
  it.each([
    ["stamped", stampedNsf],
    ["pre-backfill (prefix only)", legacyNsf],
  ])(
    "%s NSF line stored at 0.08 → { taxRate 0, taxable false }; goods keep their own rate",
    (_l, nsf) => {
      const goodsRated = { ...goods, taxRate: 0.075 };
      expect(
        hydratedLineTax({
          subtotal: 125,
          taxAmount: 9.5,
          items: [goodsRated, { ...nsf, taxRate: 0.08 }] as any,
        }),
      ).toEqual([
        { taxRate: 0.075, taxable: true },
        { taxRate: 0, taxable: false },
      ]);
    },
  );
});
