import {
  COMMISSION_EPS,
  NSF_FEE_DESCRIPTION_PREFIX,
  accruedCommission,
  collectionRatio,
  commissionBase,
  passesGrandfathering,
  payableCommission,
  resolveRate,
  type InvoiceMoneyState,
  type RateRow,
} from "./commission-math";

/**
 * Pure money-math regression suite for the commission engine (pricing.spec.ts
 * style — no Nest, no mocks). Locks the exact formulas from the plan's
 * "Engine design — Money semantics" and "Rate resolution" sections so they
 * can never silently regress. Owner decision: commission base = product
 * subtotal after discounts, EXCLUDING tax and shipping.
 */
describe("commission-math", () => {
  function state(overrides: Partial<InvoiceMoneyState> = {}): InvoiceMoneyState {
    return {
      subtotal: 100,
      discount: 0,
      total: 100,
      cashCollected: 0,
      creditApplied: 0,
      nsfFees: 0,
      ...overrides,
    };
  }

  describe("commissionBase", () => {
    it("excludes tax and shipping — base is subtotal minus discount only", () => {
      // $100 goods, $10 discount, but total is $118 (tax + shipping folded in).
      // Base must land at $90, never touched by the $18 of tax/shipping.
      expect(
        commissionBase(state({ subtotal: 100, discount: 10, total: 118, creditApplied: 0 })),
      ).toBe(90);
    });

    it("prorates a credit note by its PRE-TAX share — $54 credit on a $108 invoice with $100 goods reduces base by $50, not $54", () => {
      expect(
        commissionBase(state({ subtotal: 100, discount: 0, total: 108, creditApplied: 54 })),
      ).toBe(50);
    });

    it("clamps at zero — a discount larger than the subtotal never produces a negative base", () => {
      expect(commissionBase(state({ subtotal: 50, discount: 80, total: 30 }))).toBe(0);
    });

    it("clamps at zero — a credit larger than the goods never produces a negative base", () => {
      expect(
        commissionBase(state({ subtotal: 20, discount: 0, total: 40, creditApplied: 100 })),
      ).toBe(0);
    });

    it("rounds exactly once — no compounding drift from rounding the credit share then the base separately", () => {
      // goods = 33.33, total = 100, credit = 10 -> creditPrincipal = 3.333 -> 3.33
      // base = 33.33 - 3.33 = 30.00 exactly (not 29.99/30.01 from double rounding).
      expect(
        commissionBase(state({ subtotal: 33.33, discount: 0, total: 100, creditApplied: 10 })),
      ).toBe(30);
    });

    it("excludes an NSF bounce fee from the base — $100 goods @10%, a $25 fee bounce that is fully repaid accrues exactly $10.00, not $12.50", () => {
      // setCheckStatus folds the $25 fee into the STORED subtotal/total (both
      // 100 -> 125), so without the NSF exclusion base would read 125 and
      // accrue 12.50. With it, base lands back at the original 100.
      const s = state({ subtotal: 125, discount: 0, total: 125, nsfFees: 25, cashCollected: 125 });
      const base = commissionBase(s);
      expect(base).toBe(100);
      expect(accruedCommission(base, 10)).toBe(10);
      expect(payableCommission(accruedCommission(base, 10), collectionRatio(s))).toBe(10);
    });

    it("an invoice with no NSF lines is byte-identical to the pre-NSF base (regression pin)", () => {
      // Same scenario as the "excludes tax and shipping" case above, restated
      // explicitly with nsfFees: 0 to pin that its introduction changes nothing
      // for invoices that never had a bounce fee.
      expect(
        commissionBase(
          state({ subtotal: 100, discount: 10, total: 118, creditApplied: 0, nsfFees: 0 }),
        ),
      ).toBe(90);
    });

    it("clamps at zero — an nsfFees covering the whole subtotal never produces a negative base", () => {
      expect(commissionBase(state({ subtotal: 100, discount: 0, total: 125, nsfFees: 150 }))).toBe(
        0,
      );
    });
  });

  describe("NSF_FEE_DESCRIPTION_PREFIX", () => {
    it("is the single shared marker string — no duplicated literal elsewhere", () => {
      expect(NSF_FEE_DESCRIPTION_PREFIX).toBe("NSF fee — returned check");
    });
  });

  describe("collectionRatio", () => {
    it("snaps to 1 when the remaining gap is within epsilon (full-payment snap)", () => {
      expect(
        collectionRatio(
          state({ total: 100.0, creditApplied: 0, cashCollected: 100.0 - COMMISSION_EPS }),
        ),
      ).toBe(1);
    });

    it("a fully-credited invoice (collectible ~= 0) is harmless — ratio is 1", () => {
      expect(collectionRatio(state({ total: 100, creditApplied: 100, cashCollected: 0 }))).toBe(1);
    });

    it("clamps to the [0, 1] range and reflects partial cash collection", () => {
      expect(collectionRatio(state({ total: 100, creditApplied: 0, cashCollected: 25 }))).toBe(
        0.25,
      );
    });

    it("a bounced check (its payment excluded from cashCollected once VOID) drops the ratio", () => {
      // Before the bounce: the check's $40 counted as cash -> fully collected.
      const beforeBounce = collectionRatio(state({ total: 100, cashCollected: 100 }));
      // After the bounce: status flips to VOID, so the caller excludes it from
      // cashCollected before calling collectionRatio -> ratio drops back down.
      const afterBounce = collectionRatio(state({ total: 100, cashCollected: 60 }));
      expect(beforeBounce).toBe(1);
      expect(afterBounce).toBe(0.6);
      expect(afterBounce).toBeLessThan(beforeBounce);
    });

    it("only counts what the caller puts in cashCollected — a DRAFT payment excluded upstream never moves the ratio", () => {
      // The engine only sums status:PAID payments into cashCollected; a DRAFT
      // placeholder payment must never be included by the caller. This function
      // has no special-casing of its own -- it trusts the input completely.
      const withoutDraftPayment = collectionRatio(state({ total: 100, cashCollected: 50 }));
      expect(withoutDraftPayment).toBe(0.5);
    });
  });

  describe("resolveRate", () => {
    const basisDate = new Date("2026-06-15T00:00:00.000Z");
    const customerRates: RateRow[] = [
      { ratePct: 8, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
    ];
    const agentRates: RateRow[] = [
      { ratePct: 5, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
    ];

    it("a 0 order override beats the customer rate — 0 is a value meaning exempt, not absent", () => {
      expect(resolveRate(0, customerRates, agentRates, basisDate)).toEqual({
        ratePct: 0,
        source: "ORDER_OVERRIDE",
      });
    });

    it("a non-zero order override wins outright", () => {
      expect(resolveRate(12, customerRates, agentRates, basisDate)).toEqual({
        ratePct: 12,
        source: "ORDER_OVERRIDE",
      });
    });

    it("no override -> newest customer rate effective on basisDate wins over the agent default", () => {
      expect(resolveRate(null, customerRates, agentRates, basisDate)).toEqual({
        ratePct: 8,
        source: "CUSTOMER_RATE",
      });
    });

    it("future-dated rows are excluded -> falls through past them to the newest still-effective row", () => {
      const rates: RateRow[] = [
        { ratePct: 8, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
        { ratePct: 99, effectiveFrom: new Date("2026-12-31T00:00:00.000Z") }, // after basisDate
      ];
      expect(resolveRate(null, rates, [], basisDate)).toEqual({
        ratePct: 8,
        source: "CUSTOMER_RATE",
      });
    });

    it("no customer rate -> falls through to the newest effective agent rate", () => {
      expect(resolveRate(null, [], agentRates, basisDate)).toEqual({
        ratePct: 5,
        source: "AGENT_DEFAULT",
      });
    });

    it("picks the newest effective-dated row, not the first or last inserted", () => {
      const rates: RateRow[] = [
        { ratePct: 5, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") },
        { ratePct: 7, effectiveFrom: new Date("2026-03-01T00:00:00.000Z") },
        { ratePct: 6, effectiveFrom: new Date("2026-02-01T00:00:00.000Z") },
      ];
      expect(resolveRate(null, rates, [], basisDate)).toEqual({
        ratePct: 7,
        source: "CUSTOMER_RATE",
      });
    });

    it("nothing resolves -> NONE at rate 0", () => {
      expect(resolveRate(null, [], [], basisDate)).toEqual({ ratePct: 0, source: "NONE" });
    });
  });

  describe("passesGrandfathering", () => {
    const stop = new Date("2026-06-01T00:00:00.000Z");
    const before = new Date("2026-05-01T00:00:00.000Z");
    const after = new Date("2026-07-01T00:00:00.000Z");

    it("no stop date set -> always passes", () => {
      expect(
        passesGrandfathering({
          stopNewBusinessAt: null,
          basisDate: after,
          orderTemplateCreatedAt: null,
          recurringInvoiceCreatedAt: null,
        }),
      ).toBe(true);
    });

    it("basisDate before the stop pivot -> always passes, regardless of template/recurring", () => {
      expect(
        passesGrandfathering({
          stopNewBusinessAt: stop,
          basisDate: before,
          orderTemplateCreatedAt: null,
          recurringInvoiceCreatedAt: null,
        }),
      ).toBe(true);
    });

    it("basisDate on/after the stop, order template predates the stop -> grandfathered", () => {
      expect(
        passesGrandfathering({
          stopNewBusinessAt: stop,
          basisDate: after,
          orderTemplateCreatedAt: before,
          recurringInvoiceCreatedAt: null,
        }),
      ).toBe(true);
    });

    it("basisDate on/after the stop, recurring invoice predates the stop -> grandfathered", () => {
      expect(
        passesGrandfathering({
          stopNewBusinessAt: stop,
          basisDate: after,
          orderTemplateCreatedAt: null,
          recurringInvoiceCreatedAt: before,
        }),
      ).toBe(true);
    });

    it("basisDate on/after the stop, neither template nor recurring predates it -> new business, blocked", () => {
      expect(
        passesGrandfathering({
          stopNewBusinessAt: stop,
          basisDate: after,
          orderTemplateCreatedAt: null,
          recurringInvoiceCreatedAt: null,
        }),
      ).toBe(false);
      // Also blocked when the template/recurring row itself postdates the stop
      // (a new template created after the cutoff is new business too).
      expect(
        passesGrandfathering({
          stopNewBusinessAt: stop,
          basisDate: after,
          orderTemplateCreatedAt: after,
          recurringInvoiceCreatedAt: after,
        }),
      ).toBe(false);
    });
  });

  describe("accruedCommission / payableCommission", () => {
    it("accrued = base x rate / 100, rounded to the cent", () => {
      expect(accruedCommission(1000, 7.5)).toBe(75);
      expect(accruedCommission(33.33, 10)).toBe(3.33);
    });

    it("payable = accrued x ratio, rounded to the cent", () => {
      expect(payableCommission(75, 0.5)).toBe(37.5);
      expect(payableCommission(75, 1)).toBe(75);
      expect(payableCommission(75, 0)).toBe(0);
    });
  });
});
