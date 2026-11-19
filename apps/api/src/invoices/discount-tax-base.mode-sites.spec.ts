// SA-1153 (W-989 PR-2, round 3): one behavioural red per production mode site whose answer moves money, through the entry the row
// names, with the cutover SET (the harness) so a swap to the wrong mode source goes red. Rows 4, 14, 15, 16, 17, 18 live here;
// the service-driven rows (10, 11, 12+13) are in discount-tax-base.mode-sites.service.spec.ts, 2/3 in the estimates spec, 6-9 in
// discount-tax-base.generation-sites.spec.ts, 19/20 in the orders spec. Every row asserts TWO things:
//   1. the fixture discriminates: the SAME call over a PRE_TAX-dated source (AFTER) writes a different figure than the BEFORE one;
//   2. the written figure for a LEGACY (BEFORE) source equals the same call run with the cutover NULL (R3). Nothing typed by hand.
import {
  AFTER,
  BEFORE,
  FIXTURE,
  expectFixtureDiscriminates,
  settled,
  underCutover,
  withDiscountCutover,
} from "../common/testing/discount-cutover";
import { InvoiceStatus } from "@prisma/client";
import { finalizeOrderRecompute } from "./finalize-order-recompute";
import { planHeaderOnlyTotals } from "./locked-invoice-edit";
import { planPartialPriceFollow } from "./partial-price-follow";
import { orderDerivedTaxRate } from "./manual-invoice-context";
import { assertTaxStateRecomputable, taxStateOf } from "./stored-tax-state";
import { commitPriceAdjustment, preflightBulkPriceAdjustment } from "./price-adjustment-ledger";
import { createMockPrisma } from "../testing/prisma-mock";

/** Runs `run` for a BEFORE source with the cutover set and null, and for an AFTER source; asserts the two named things. */
async function expectSiteKeepsLegacy<T>(run: (createdAt: Date) => Promise<T> | T): Promise<void> {
  expectFixtureDiscriminates();
  const darkRun = await underCutover(null, () => run(BEFORE)); // the cutover-null run: master's figure
  const preTaxRun = await settled(() => run(AFTER)); // a PRE_TAX-dated source through the same site
  expect(preTaxRun).not.toEqual(darkRun); // 1: the fixture discriminates at THIS site
  expect(await run(BEFORE)).toEqual(darkRun); // 2: a LEGACY-dated source keeps its formula
}

describe("SA-1153 behavioural rows (cutover set)", () => {
  withDiscountCutover();

  // Row 4: finalize-order-recompute.ts:352 (ORDER). The subtotal CHANGES 100 -> 120: with it unchanged both modes reproduce the
  // stored tax (rate x base = tax), which is why the threading spec's version stays green under a swap.
  describe("row 4: finalizeOrderRecompute infers the rate off the ORDER's mode", () => {
    const recompute = async (createdAt: Date) => {
      const written: any[] = [];
      const db: any = {
        orderItem: { update: async () => ({}) },
        order: { update: async (a: any) => written.push(a.data) },
      };
      const out = await finalizeOrderRecompute({
        db,
        orderId: "o1",
        // stored: subtotal 100, discount 20, tax 10 (LEGACY: 10 / 100 = 0.10; read as PRE_TAX it is 10 / 80 = 0.125)
        order: { subtotal: FIXTURE.subtotal, tax: 10, discountAmount: FIXTURE.discount, createdAt },
        deliveredBasis: { hasMutations: false, byLineId: new Map() },
        unbilled: new Map(),
        subtotal: 120, // the line was edited up
        categoryTaxSum: 0,
        invoices: [{ discount: FIXTURE.discount, shippingFee: FIXTURE.shipping }],
      });
      return { tax: out.tax, total: out.total };
    };

    it("an order made BEFORE the cutover recomputes exactly as the cutover-null run (same rate, same tax)", () =>
      expectSiteKeepsLegacy(recompute));
  });

  // Row 14: locked-invoice-edit.ts:281 (OWN), the header discount PATCH's planner (`update()` calls it with the locked row).
  // Fixture note: the recompute's tax (`t.tax`) is computed on the row's OWN mode by stored-tax-state.ts:189, so a swap at :281
  // alone moves nothing while stored tax equals the line sum (both modes then skip `taxAmount`). It becomes observable where the
  // stored tax is an ORDER ALLOCATION share (one of two invoices of the order): within the allocation tolerance, a cent off the
  // line sum, so `differs(t.tax, stored)` is true and the plan is sensitive to the mode there. That is the fixture below (N2:
  // on the plain fixture the swap is an equivalent mutant, so it cannot discriminate). The expected value is that the written
  // figures equal the cutover-null run on this fixture, which `expectSiteKeepsLegacy` compares.
  describe("row 14: a header discount PATCH writes no tax on a LEGACY invoice (master's shape)", () => {
    const patched = (createdAt: Date, over: Record<string, unknown> = {}) =>
      planHeaderOnlyTotals(
        {
          invoice: {
            id: "inv-1",
            status: "DRAFT",
            subtotal: 100,
            taxAmount: 10.01, // the allocated share of the order's LEGACY tax: a cent off the line sum 10.00
            discount: FIXTURE.discount,
            shippingFee: 0,
            total: 100 - FIXTURE.discount + 10.01,
            orderId: "o-1",
            createdAt: AFTER, // the invoice itself is newer than the cutover
            order: { createdAt }, // the ORDER is the source (R4)
            estimate: null,
            ...over,
          },
          storedRows: [{ id: "li-1", subtotal: 100, taxRate: 0.1, categoryTaxAmount: 0 }],
          isTaxExempt: false,
          payments: [],
          orderInvoiceCount: 2, // this invoice and one sibling share the order's tax
        } as any,
        { discount: 30 }, // 20 -> 30
      );

    it("an invoice cut AFTER the cutover from an order made BEFORE it: PATCH 20 -> 30 leaves taxAmount unwritten, as the cutover-null run", async () => {
      await expectSiteKeepsLegacy((at) => patched(at));
      expect(patched(BEFORE)).not.toHaveProperty("taxAmount");
    });
  });

  // Row 15: partial-price-follow.ts:127 (ORDER), a derived DRAFT takes the ORDER's mode.
  describe("row 15: planPartialPriceFollow stamps the ORDER's rate on a derived draft", () => {
    const plan = async (createdAt: Date) => {
      const order = {
        id: "o1",
        customerId: "c1",
        createdAt,
        subtotal: 100,
        discountAmount: FIXTURE.discount,
        tax: 10, // stored: LEGACY 10 / 100 = 0.10; as PRE_TAX the rate would be 10 / 80 = 0.125
        lineItems: [
          { id: "oi-1", qty: 10, unitPrice: 11, originalPrice: null, priceType: "STANDARD" },
        ],
      };
      const db: any = {
        invoice: {
          findMany: async () => [
            {
              id: "inv-1",
              invoiceNumber: "INV-1",
              status: InvoiceStatus.DRAFT,
              discount: 10,
              shippingFee: 0,
              items: [
                {
                  id: "ii-1",
                  orderItemId: "oi-1",
                  qty: 5, // a partial: it bills less than the order, so the follow runs
                  unitPrice: 10, // the order line now says 11: stale
                  originalPrice: null,
                  priceType: "STANDARD",
                  subtotal: 50,
                  promoFreeUnits: 0,
                  categoryTaxAmount: 0,
                },
              ],
            },
          ],
        },
        order: { findUnique: async () => order },
        customer: { findFirst: async () => ({ isTaxExempt: false }) },
      };
      const deps = {
        buildItem: () => ({ unitPrice: 11, subtotal: 55, promoFreeUnits: 0, categoryTaxAmount: 0 }),
        taxRateOf: orderDerivedTaxRate,
        applyMsrp: async () => undefined,
        tenantId: "t-1",
      };
      const out = await planPartialPriceFollow(deps as any, db, "o1");
      const draft = out.drafts[0];
      return {
        rates: draft.itemUpdates.map((u) => u.data.taxRate),
        taxAmount: draft.taxAmount,
        total: draft.total,
      };
    };

    it("an order made BEFORE the cutover: the draft's rate, tax and total equal the cutover-null run", () =>
      expectSiteKeepsLegacy(plan));
  });

  // Rows 16 and 17: price-adjustment-ledger.ts:370 (projectedTotals, reached by the bulk pre-flight, whose result is the projected
  // total per invoice) and :806 (commitPriceAdjustment, the tx write). OWN.
  describe("rows 16, 17: a price adjustment totals the invoice on its OWN mode", () => {
    const line = {
      id: "l1",
      invoiceId: "inv-1",
      productId: "prod-x",
      description: "Widget",
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      unitPrice: 100,
      discount: 0,
      subtotal: 100,
      qty: 1,
      taxRate: FIXTURE.rate,
      categoryTaxAmount: 0,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitLabel: null,
      promoFreeUnits: null,
      orderItemId: null,
    };
    const invoice = (createdAt: Date) => ({
      id: "inv-1",
      invoiceNumber: "INV-1",
      customerId: "cust-1",
      orderId: null,
      order: null,
      estimate: null,
      createdAt,
      status: InvoiceStatus.SENT,
      discount: FIXTURE.discount,
      shippingFee: FIXTURE.shipping,
      subtotal: 100,
      taxAmount: 10, // LEGACY: 10% of 100
      total: 90,
      internalNotes: null,
      dueDate: null,
      payments: [],
      items: [line],
    });

    it("row 16 (projectedTotals, through preflightBulkPriceAdjustment): the projected total of a price raise 100 -> 110", async () => {
      const prisma = createMockPrisma();
      prisma.trackedCategory.findMany.mockResolvedValue([]);
      prisma.product.findMany.mockResolvedValue([]);
      await expectSiteKeepsLegacy(async (at) => {
        const projected = await preflightBulkPriceAdjustment(
          [{ inv: invoice(at), localMap: new Map([["l1", 110]]) }],
          false,
          prisma as any,
          "t-1",
        );
        return [...projected.entries()];
      });
    });

    it("row 17 (commitPriceAdjustment, the tx write): the totals written for the same price raise", async () => {
      await expectSiteKeepsLegacy(async (at) => {
        const raised = { ...line, unitPrice: 110, subtotal: 110 };
        const update = jest.fn().mockResolvedValue({});
        const tx: any = {
          invoiceItem: { findMany: jest.fn().mockResolvedValue([raised]) },
          invoice: { update },
        };
        await commitPriceAdjustment({
          inv: invoice(at),
          itemUpdates: [{ id: "l1", data: { unitPrice: 110, subtotal: 110 } }],
          auditLine: "[adjusted]",
          tx,
          isTaxExempt: false,
          recomputeStatus: (_paid: number, _total: number, _due: Date | null, status: any) =>
            status,
          ledger: { correctSaleForPriceChange: jest.fn() } as any,
          resync: jest.fn(),
        });
        const d = update.mock.calls[0][0].data;
        return { subtotal: d.subtotal, taxAmount: d.taxAmount, total: d.total };
      });
    });
  });

  // Row 18: stored-tax-state.ts:189 (OWN), the stored-row verdict. SA-1141 case 9 re-run with the cutover set (as written it runs dark).
  describe("row 18: the stored-row verdict reads the row's own mode", () => {
    const verdictOf = (createdAt: Date) =>
      taxStateOf({
        invoice: {
          subtotal: 100,
          taxAmount: 10, // stored LEGACY tax
          discount: FIXTURE.discount,
          orderId: null,
          order: null,
          estimate: null,
          createdAt,
        },
        storedLines: [{ id: "li-1", subtotal: 100, taxRate: 0.1, categoryTaxAmount: 0 } as any],
        canRestamp: false,
        isTaxExempt: false,
        discount: FIXTURE.discount,
        shipping: 0,
      });

    it("an invoice sourced BEFORE the cutover with stored LEGACY tax 10 is not STALE, and equals the cutover-null verdict", async () => {
      await expectSiteKeepsLegacy((at) => verdictOf(at));
      expect(verdictOf(BEFORE).stale).toBe(false);
      expect(verdictOf(AFTER).stale).toBe(true); // the discriminator: the same stored row read as PRE_TAX is stale
    });

    it("the guard agrees: a BEFORE row passes assertTaxStateRecomputable, a mis-dated one is refused", () => {
      const args = (createdAt: Date) => ({
        invoice: {
          subtotal: 100,
          taxAmount: 10,
          discount: FIXTURE.discount,
          orderId: null,
          order: null,
          estimate: null,
          createdAt,
        },
        storedLines: [{ id: "li-1", subtotal: 100, taxRate: 0.1, categoryTaxAmount: 0 } as any],
        canRestamp: false,
        isTaxExempt: false,
        discount: FIXTURE.discount,
        shipping: 0,
      });
      expect(() => assertTaxStateRecomputable(args(BEFORE))).not.toThrow();
      expect(() => assertTaxStateRecomputable(args(AFTER))).toThrow();
    });
  });
});
