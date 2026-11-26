import { issuedConsent } from "./issued-edit-consent";

/**
 * SA-1508 commit 6 (consent). Red on master: the module does not exist (master silently re-taxes, or refuses a stale tax
 * with INVOICE_TAX_STATE_STALE). The judge reads the figures the save WRITES and asks only when a stored cent would move.
 * Imported fixture: lines 100.00, file total 108.25, tax 0 (`acme` dummy data).
 */
const IMPORTED = { total: 108.25, taxAmount: 0 };
const TOTAL_STATE = { state: "TOTAL_NOT_FROM_LINES", restampRate: null } as const;
const STALE_VERIFIED = { state: "TAX_STALE", restampRate: 0.0825 } as const;
const STALE_UNVERIFIED = { state: "TAX_STALE", restampRate: null } as const;
const STORED = [{ id: "r1" }, { id: "r2", systemKind: "NSF_FEE" }];
const edited = (rate: number) => [
  { rowId: "r1", untouched: false, data: { taxRate: rate } as any },
];

describe("issuedConsent", () => {
  it("a REPRODUCES invoice, a DRAFT and an order-linked invoice (no judge) are never asked", () => {
    for (const recompute of [
      { state: "REPRODUCES", restampRate: null } as const,
      null,
      undefined,
    ]) {
      expect(
        issuedConsent({
          recompute,
          invoice: IMPORTED,
          storedRows: STORED,
          written: { total: 200 },
        }),
      ).toEqual({ body: null, consented: false });
    }
  });

  it("the 409 body carries the stored, new and difference figures and the cause", () => {
    const v = issuedConsent({
      recompute: TOTAL_STATE,
      invoice: IMPORTED,
      storedRows: STORED,
      written: { total: 200, tax: 0 },
    });
    expect(v.consented).toBe(false);
    expect(v.body).toEqual({
      storedTotal: 108.25,
      newTotal: 200,
      difference: -91.75, // stored minus new: negative, so the client offers an invoice discount of 91.75
      storedTax: 0,
      newTax: 0,
      cause: "TOTAL_NOT_FROM_LINES",
    });
  });

  it("a new total BELOW the stored one has a positive difference (add a line for it)", () => {
    const v = issuedConsent({
      recompute: TOTAL_STATE,
      invoice: IMPORTED,
      storedRows: STORED,
      written: { total: 100 },
    });
    expect(v.body).toMatchObject({ newTotal: 100, difference: 8.25 });
  });

  it("the cents compare: a line added for the difference lands on the stored figures and asks nothing", () => {
    expect(
      issuedConsent({
        recompute: TOTAL_STATE,
        invoice: IMPORTED,
        storedRows: STORED,
        written: { total: 108.25, tax: 0 },
      }),
    ).toEqual({ body: null, consented: false });
    // 108.2501 and 108.2499 round to the same cent; 108.26 does not
    expect(
      issuedConsent({
        recompute: TOTAL_STATE,
        invoice: IMPORTED,
        storedRows: STORED,
        written: { total: 108.2499 },
      }).body,
    ).toBeNull();
    expect(
      issuedConsent({
        recompute: TOTAL_STATE,
        invoice: IMPORTED,
        storedRows: STORED,
        written: { total: 108.26 },
      }).body,
    ).not.toBeNull();
  });

  it("a matching echo proceeds and says consented; a stale echo is refused with the fresh figures", () => {
    const args = {
      recompute: TOTAL_STATE,
      invoice: IMPORTED,
      storedRows: STORED,
      written: { total: 200 },
    };
    expect(issuedConsent({ ...args, accept: { storedTotal: 108.25, newTotal: 200 } })).toEqual({
      body: null,
      consented: true,
    });
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 108.25, newTotal: 150 } }).body,
    ).toMatchObject({ newTotal: 200 });
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 99, newTotal: 200 } }).body,
    ).not.toBeNull();
    // half a cent either way still matches
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 108.2549, newTotal: 200.004 } }).consented,
    ).toBe(true);
    // the edge: exactly half a cent off still matches (floating dust tolerated), a hair past it does not
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 108.255, newTotal: 200.005 } }).consented,
    ).toBe(true);
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 108.2451, newTotal: 199.995 } }).consented,
    ).toBe(true);
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 108.2551, newTotal: 200 } }).consented,
    ).toBe(false);
    expect(
      issuedConsent({ ...args, accept: { storedTotal: 108.25, newTotal: 199.9949 } }).consented,
    ).toBe(false);
  });

  it("an older tax is cause OLDER_TAX; with no verified rate any moved figure asks", () => {
    const v = issuedConsent({
      recompute: STALE_UNVERIFIED,
      invoice: { total: 324.75, taxAmount: 24.75 },
      storedRows: STORED,
      written: { total: 308.25, tax: 8.25, lines: edited(0) },
    });
    expect(v.body).toMatchObject({ cause: "OLDER_TAX", storedTax: 24.75, newTax: 8.25 });
  });

  describe("a verified rate (SA-814 R5-2, kept)", () => {
    const stale = { total: 324.75, taxAmount: 24.75 };
    it("every goods line carries a rate on the written lines: silent even when the total moves", () => {
      expect(
        issuedConsent({
          recompute: STALE_VERIFIED,
          invoice: stale,
          storedRows: STORED,
          written: { total: 433.0, tax: 33.0, lines: edited(0.0825) },
        }),
      ).toEqual({ body: null, consented: false });
    });
    it("a goods line still at rate 0 on the written lines (the stamp did not reach it) asks", () => {
      const v = issuedConsent({
        recompute: STALE_VERIFIED,
        invoice: stale,
        storedRows: STORED,
        written: { total: 309.08, tax: 9.08, lines: edited(0) },
      });
      expect(v.body).toMatchObject({ newTax: 9.08, cause: "OLDER_TAX" });
    });
    it("an NSF fee line at rate 0 is not a goods line", () => {
      const lines = [
        { rowId: "r1", untouched: false, data: { taxRate: 0.0825 } as any },
        { rowId: "r2", untouched: true, data: { taxRate: 0 } as any },
      ];
      expect(
        issuedConsent({
          recompute: STALE_VERIFIED,
          invoice: stale,
          storedRows: STORED,
          written: { total: 400, tax: 30, lines },
        }).body,
      ).toBeNull();
    });
    it("M4: a NEW rate-0 line beside stamped kept rows does not ask when the tax is unchanged", () => {
      const lines = [
        { rowId: "r1", untouched: false, data: { taxRate: 0.0825 } as any },
        { rowId: null, untouched: false, data: { taxRate: 0 } as any },
      ];
      expect(
        issuedConsent({
          recompute: STALE_VERIFIED,
          invoice: stale,
          storedRows: STORED,
          written: { total: 424.75, tax: 24.75, lines },
        }),
      ).toEqual({ body: null, consented: false });
    });
    it("M4: a kept row still at rate 0 asks even with a new line beside it; all-new lines ask (a cent moves)", () => {
      const keptZero = [
        { rowId: "r1", untouched: false, data: { taxRate: 0 } as any },
        { rowId: null, untouched: false, data: { taxRate: 0.0825 } as any },
      ];
      expect(
        issuedConsent({
          recompute: STALE_VERIFIED,
          invoice: stale,
          storedRows: STORED,
          written: { total: 424.75, tax: 24.75, lines: keptZero },
        }).body,
      ).not.toBeNull();
      const allNew = [{ rowId: null, untouched: false, data: { taxRate: 0.0825 } as any }];
      expect(
        issuedConsent({
          recompute: STALE_VERIFIED,
          invoice: stale,
          storedRows: STORED,
          written: { total: 108.25, tax: 8.25, lines: allNew },
        }).body,
      ).not.toBeNull();
    });
    it("a header-only save has no lines to stamp (L11): it asks when a figure moves", () => {
      expect(
        issuedConsent({
          recompute: STALE_VERIFIED,
          invoice: stale,
          storedRows: STORED,
          written: { total: 300, tax: 0 },
        }).body,
      ).not.toBeNull();
    });
  });
});
