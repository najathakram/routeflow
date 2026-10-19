/**
 * SA-816 (d)2 / register row 593: a STORED non-finite levy (`InvoiceItem` / `OrderItem` `categoryTaxAmount`
 * holding numeric NaN: node-pg binds a JS NaN as 'NaN' and NUMERIC accepts it) must be REFUSED by the code
 * that reads it, never turned into a silent $0 and never copied on verbatim.
 *
 * `roundMoney` returns 0 for NaN and SA-816 rules that the CALLERS are the fix, so every site below reads
 * the stored value through `finiteStoredMoney` (money-invariants.util.ts) and answers 400 MONEY_INVARIANT.
 * The credit-note and inline-return sites have their own specs next to their services.
 *
 * Each red test records what master did with the stored NaN. "(static read)" = derived by reading the
 * code, not by running this spec on master.
 */
import { BadRequestException } from "@nestjs/common";
import { InvoiceStatus, Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "./api-error-codes";
import { aggregateInvoiceLines } from "../invoices/order-backsync-aggregate";
import { orderLineUnchanged } from "../invoices/order-backsync-lines";
import { InvoicesService } from "../invoices/invoices.service";
import {
  buildEditedLines,
  matchEditLines,
  type StoredEditRow,
} from "../invoices/invoice-edit-plan";
import { toSaleLedgerLines } from "../invoices/pack-at-sale";
import { syncLedgerAfterPriceChange } from "../invoices/price-adjustment-ledger";
import { carriedCategory } from "../orders/carry-line-category";

/** What `Number(...)` of a numeric NaN read back from the database looks like to the app. */
const STORED_NAN: ReadonlyArray<[string, unknown]> = [
  ["the string 'NaN' (a raw pg row)", "NaN"],
  ["Prisma.Decimal('NaN') (a Prisma row)", new Prisma.Decimal("NaN")],
];

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

const caughtAsync = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

/** The coded refusal: 400 with `code: MONEY_INVARIANT` (a missing error fails here with `undefined`). */
function expectMoneyInvariant(err: unknown): void {
  expect(err).toBeInstanceOf(BadRequestException);
  expect((err as BadRequestException).getResponse()).toMatchObject({
    code: API_ERROR_CODES.MONEY_INVARIANT,
  });
}

describe("SA-816 (d)2: a stored non-finite levy is refused, not zeroed or copied", () => {
  describe("order back-sync aggregate (order-backsync-aggregate.ts:90)", () => {
    const orderLines = [{ id: "oi-1", productId: "p-1", status: "PENDING" }];
    const invoicesWith = (levy: unknown) => [
      {
        items: [
          {
            id: "ii-1",
            orderItemId: "oi-1",
            productId: "p-1",
            qty: 2,
            unitPrice: 10,
            subtotal: 20,
            unitsPerBox: null,
            categoryTaxAmount: levy,
          },
        ],
      },
    ];

    it.each(STORED_NAN)(
      "refuses %s (master: Σ levy became NaN, then roundMoney zeroed it at the order write; static read)",
      (_label, nan) => {
        expectMoneyInvariant(caught(() => aggregateInvoiceLines(orderLines, invoicesWith(nan))));
      },
    );

    it("control: a finite, a null and a zero levy aggregate exactly as before", () => {
      const sum = (levy: unknown) =>
        [...aggregateInvoiceLines(orderLines, invoicesWith(levy)).byTarget.values()][0].categoryTax;
      expect(sum("5.25")).toBe(5.25);
      expect(sum(null)).toBe(0);
      expect(sum(0)).toBe(0);
    });
  });

  describe("order back-sync aggregate: the other stored money columns (SA-816b)", () => {
    const orderLines = [{ id: "oi-1", productId: "p-1", status: "PENDING" }];
    const base = {
      id: "ii-1",
      orderItemId: "oi-1",
      productId: "p-1",
      qty: 2,
      unitPrice: 10,
      subtotal: 20,
      unitsPerBox: null,
      categoryTaxAmount: 0,
    };
    const aggregate = (over: Record<string, unknown>) =>
      aggregateInvoiceLines(orderLines, [{ items: [{ ...base, ...over }] }]);

    // master (static read): unitPrice and qty carried NaN into the order write; subtotal's NaN became 0 at roundMoney.
    describe.each(["unitPrice", "qty", "subtotal"])("%s", (column) => {
      it.each(STORED_NAN)("refuses %s", (_label, nan) => {
        expectMoneyInvariant(caught(() => aggregate({ [column]: nan })));
      });
    });

    it("control: finite and null values aggregate as before", () => {
      const agg = [
        ...aggregate({ unitPrice: "10.50", qty: "2", subtotal: "21.00" }).byTarget.values(),
      ][0];
      expect(agg).toMatchObject({ unitPrice: 10.5, qty: 2, subtotal: 21 });
      expect([...aggregate({ subtotal: null }).byTarget.values()][0].subtotal).toBe(0);
    });
  });

  describe("order line comparison: unit price and subtotal (SA-816b)", () => {
    const existing = {
      qty: 2,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 10,
      subtotal: 20,
      categoryTaxAmount: 0,
      promoFreeUnits: null,
      invoicedQty: 2,
      status: "PENDING",
    };
    const shape = { qty: 2, boxes: null, pieces: null, unitsPerBox: null };
    const agg = (over: { unitPrice?: number; subtotal?: number }) => ({
      unitPrice: 10,
      subtotal: 20,
      categoryTax: 0,
      freeUnits: 0,
      ...over,
    });

    // master (static read): a NaN unit price read as "changed", a NaN subtotal as roundMoney 0 (also "changed"),
    // so the line was rewritten from a NaN aggregate instead of refusing.
    it("refuses a NaN unit price and a NaN subtotal", () => {
      expectMoneyInvariant(
        caught(() => orderLineUnchanged(existing, shape, agg({ unitPrice: NaN }))),
      );
      expectMoneyInvariant(
        caught(() => orderLineUnchanged(existing, shape, agg({ subtotal: NaN }))),
      );
    });

    it("control: finite values compare as before", () => {
      expect(orderLineUnchanged(existing, shape, agg({}))).toBe(true);
      expect(orderLineUnchanged(existing, shape, agg({ unitPrice: 11 }))).toBe(false);
    });
  });

  describe("order line comparison (order-backsync-lines.ts:127)", () => {
    const existing = {
      qty: 2,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 10,
      subtotal: 20,
      categoryTaxAmount: 0,
      promoFreeUnits: null,
      invoicedQty: 2,
      status: "PENDING",
    };
    const shape = { qty: 2, boxes: null, pieces: null, unitsPerBox: null };
    const agg = (categoryTax: number) => ({
      unitPrice: 10,
      subtotal: 20,
      categoryTax,
      freeUnits: 0,
    });

    it("refuses a NaN levy sum (master: roundMoney(NaN) = 0 equalled the stored 0, so the line read 'unchanged'; static read)", () => {
      expectMoneyInvariant(caught(() => orderLineUnchanged(existing, shape, agg(NaN))));
    });

    it("control: a finite levy compares as before", () => {
      expect(orderLineUnchanged(existing, shape, agg(0))).toBe(true);
      expect(orderLineUnchanged(existing, shape, agg(1.5))).toBe(false);
    });
  });

  describe("order line -> invoice line (invoices.service.ts buildInvoiceItemData, :927-932)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new InvoicesService(...(Array(15).fill(undefined) as any[]));
    const build = (li: object, billQty: number) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).buildInvoiceItemData(li, billQty, "test-tenant");
    const orderLine = (qty: number, levy: unknown) => ({
      id: "oi-1",
      productId: "p-1",
      qty,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 10,
      subtotal: 100,
      categoryTaxAmount: levy,
      product: { name: "Widget", unitsPerBox: 0 },
    });

    it.each(STORED_NAN)(
      "refuses %s on a line with qty > 0 (master: the prorated roundMoney(NaN) wrote 0; static read)",
      (_label, nan) => {
        expectMoneyInvariant(caught(() => build(orderLine(10, nan), 10)));
      },
    );

    it.each(STORED_NAN)(
      "refuses %s on a line with qty <= 0 (master: `=== 0` is false for NaN, so NaN was copied verbatim; static read)",
      (_label, nan) => {
        expectMoneyInvariant(caught(() => build(orderLine(0, nan), 3)));
      },
    );

    it("control: a finite levy is copied on a full bill and prorated on a partial, as before", () => {
      expect(build(orderLine(10, "5.00"), 10).categoryTaxAmount).toBe(5);
      expect(build(orderLine(10, "5.00"), 4).categoryTaxAmount).toBe(2);
      expect(build(orderLine(10, null), 10).categoryTaxAmount).toBe(0);
    });
  });

  describe("invoice edit plan (invoice-edit-plan.ts:310, an untouched stored row)", () => {
    const row = (levy: unknown): StoredEditRow =>
      ({
        id: "row-1",
        invoiceId: "inv-1",
        productId: null,
        description: "Freight",
        qty: 1,
        unitPrice: 25,
        discount: 0,
        taxRate: 0,
        subtotal: 25,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        promoFreeUnits: null,
        notes: null,
        orderItemId: null,
        trackedCategoryId: null,
        trackedSubcategoryId: null,
        categoryTaxAmount: levy,
      }) as unknown as StoredEditRow;
    const item = {
      id: "row-1",
      description: "Freight",
      qty: 1,
      unitPrice: 25,
      discount: 0,
      taxRate: 0,
    };
    const plan = (stored: StoredEditRow[]) =>
      buildEditedLines({
        items: [item],
        stored,
        matches: matchEditLines([item], stored),
        productMap: new Map(),
        categoryMap: new Map(),
        clampFreeUnits: (free: number | undefined) => free ?? 0,
        warn: () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    it.each(STORED_NAN)(
      "refuses %s (master: the untouched row carried NaN into the rewrite data verbatim; static read)",
      (_label, nan) => {
        expectMoneyInvariant(caught(() => plan([row(nan)])));
      },
    );

    it("control: a finite and a null levy are carried as before", () => {
      expect(plan([row("3.5")])[0].data.categoryTaxAmount).toBe(3.5);
      expect(plan([row(null)])[0].data.categoryTaxAmount).toBe(0);
    });
  });

  describe("category carry (carry-line-category.ts:42, an uncategorised line's own levy)", () => {
    const own = (levy: unknown) => ({
      productId: "p-1",
      trackedCategoryId: null,
      categoryTaxAmount: levy,
    });

    it.each(STORED_NAN)(
      "refuses %s (master: the merge fold re-created the line with NaN; static read)",
      (_label, nan) => {
        expectMoneyInvariant(caught(() => carriedCategory(own(nan), "p-1")));
      },
    );

    it("control: a finite and a null levy are carried as before", () => {
      expect(carriedCategory(own("2.00"), "p-1")).toMatchObject({ categoryTaxAmount: 2 });
      expect(carriedCategory(own(null), "p-1")).toMatchObject({ categoryTaxAmount: 0 });
    });
  });

  describe("regulated ledger lines (pack-at-sale.ts:96 toSaleLedgerLines)", () => {
    const items = (levy: unknown) => [
      {
        id: "ii-1",
        orderItemId: "oi-1",
        trackedCategoryId: "cat-1",
        qty: 2,
        subtotal: 20,
        categoryTaxAmount: levy,
      },
    ];

    it.each(STORED_NAN)(
      "refuses %s (master: a SALE row would have been booked with categoryTax NaN; static read)",
      (_label, nan) => {
        expectMoneyInvariant(caught(() => toSaleLedgerLines(items(nan), new Map())));
      },
    );

    it("control: a finite and a null levy are booked as before", () => {
      expect(toSaleLedgerLines(items("1.25"), new Map())[0].categoryTax).toBe(1.25);
      expect(toSaleLedgerLines(items(null), new Map())[0].categoryTax).toBe(0);
    });
  });

  describe("price-adjust ledger correction (price-adjustment-ledger.ts:85 syncLedgerAfterPriceChange)", () => {
    const run = (levy: unknown) => {
      const correctSaleForPriceChange = jest.fn().mockResolvedValue(undefined);
      const call = () =>
        syncLedgerAfterPriceChange(
          {
            ledger: { correctSaleForPriceChange },
            resync: jest.fn().mockResolvedValue(undefined),
          },
          { id: "inv-1", status: InvoiceStatus.SENT },
          [
            {
              id: "ii-1",
              trackedCategoryId: "cat-1",
              qty: 2,
              subtotal: 20,
              categoryTaxAmount: levy,
              boxes: null,
              unitsPerBox: null,
              promoFreeUnits: null,
            },
          ],
          new Set(["ii-1"]),
          {},
        );
      return { call, correctSaleForPriceChange };
    };

    it.each(STORED_NAN)(
      "refuses %s and books no correction row (master: correctSaleForPriceChange got categoryTax NaN; static read)",
      async (_label, nan) => {
        const { call, correctSaleForPriceChange } = run(nan);
        expectMoneyInvariant(await caughtAsync(call));
        expect(correctSaleForPriceChange).not.toHaveBeenCalled();
      },
    );

    it("control: a finite levy is passed to the ledger as before", async () => {
      const { call, correctSaleForPriceChange } = run("4.00");
      await call();
      expect(correctSaleForPriceChange).toHaveBeenCalledWith(
        expect.objectContaining({
          lines: [expect.objectContaining({ invoiceItemId: "ii-1", categoryTax: 4 })],
        }),
      );
    });
  });
});
