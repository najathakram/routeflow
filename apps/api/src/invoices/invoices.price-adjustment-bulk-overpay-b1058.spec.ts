/**
 * B1058 (SA-683, cross-PR with B1051): the bulk re-price (scope ALL_CUSTOMER_SINCE) judges "would this
 * leave an invoice overpaid" at PRE-FLIGHT, over every target, and refuses the whole batch with ONE 400
 * that lists every offender, before any write. The in-tx assertNotOverpaidByPriceChange stays as the
 * race re-judge. Also pinned here (SA-683): a post-commit throw after >= 1 commit is reported as the
 * structured PARTIAL body, never a raw error; a fault rethrown after commits is logged; only KNOWN
 * refusal codes are echoed, an unknown 400 maps to the generic PRICE_ADJUSTMENT_REFUSED; the bulk
 * targets read in a stable order.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { InvoicesService } from "./invoices.service";
import {
  applyBulkPriceAdjustment,
  assertNotOverpaidByPriceChange,
  overpaymentOf,
  preflightBulkPriceAdjustment,
  totalsFromLines,
} from "./price-adjustment-ledger";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

/** 1 x $50, no discount, no tax: re-priced to $20 the invoice total goes 50 -> 20. */
const line = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  invoiceId: "inv-1",
  productId: "prod-x",
  description: "Widget",
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  unitPrice: 50,
  discount: 0,
  subtotal: 50,
  qty: 1,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  promoFreeUnits: null,
  orderItemId: null,
  ...over,
});
const paid = (amount: number, status = "PAID") => ({ status, amount, method: "CASH" });
const money = (n: number) => `$${n.toFixed(2)}`;
const INV = { id: "inv-x", invoiceNumber: "INV-X" };

const invoiceOf = (n: number, payments: any[], over: Record<string, unknown> = {}) => ({
  id: `inv-${n}`,
  invoiceNumber: `INV-${n}`,
  customerId: "cust-1",
  orderId: null,
  status: InvoiceStatus.SENT,
  discount: 0,
  shippingFee: 0,
  subtotal: 50,
  taxAmount: 0,
  total: 50,
  internalNotes: null,
  dueDate: null,
  payments,
  items: [line(`l${n}`)],
  ...over,
});

describe("bulk re-price: the overpay judgment is a PRE-FLIGHT check (B1058)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: Record<string, jest.Mock>;
  let commission: Record<string, jest.Mock>;
  let stored: Record<string, any[]>; // invoiceId -> its CURRENT lines (the tx re-reads them after the writes)

  const arrange = (invoices: any[], order: any[] = invoices) => {
    const byId = Object.fromEntries(invoices.map((i) => [i.id, i]));
    stored = Object.fromEntries(invoices.map((i) => [i.id, i.items.map((l: any) => ({ ...l }))]));
    prisma.invoice.findUnique.mockImplementation(async ({ where }: any) => byId[where.id] ?? null);
    prisma.invoice.findMany.mockResolvedValue(order);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.trackedCategory.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.invoice.update.mockResolvedValue({});
    prisma.invoiceItem.update.mockImplementation(async ({ where, data }: any) => {
      for (const rows of Object.values(stored))
        for (const r of rows) if (r.id === where.id) Object.assign(r, data);
      return {};
    });
    prisma.invoiceItem.findMany.mockImplementation(
      async ({ where }: any) => stored[where.invoiceId] ?? [],
    );
  };
  const noWrites = () => {
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(ledger.correctSaleForPriceChange).not.toHaveBeenCalled();
    expect(commission.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
  };
  const run = (price = 20) =>
    service.applyPriceAdjustment("inv-1", {
      items: [{ itemId: "l1", newUnitPrice: price }],
      scope: "ALL_CUSTOMER_SINCE",
      sinceDate: "2026-01-01",
    });
  const caught = async (p: Promise<unknown>) => {
    const err: any = await p.then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    return err;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    ledger = (service as any).ledger;
    commission = (service as any).commissionEngine;
    jest.spyOn(Logger.prototype, "warn").mockImplementation(); // the partial / rethrow paths log
  });
  afterEach(() => jest.restoreAllMocks());

  describe("fold 1: ONE 400 listing every overpaying invoice, before ANY write", () => {
    // Re-priced $50 -> $20. inv-2 paid 40 (over by 20), inv-4 paid 25 (over by 5). inv-1 paid exactly
    // the new total (settles), inv-3 carries a PENDING payment that the guard ignores, inv-5 owes it all.
    const five = () => [
      invoiceOf(1, [paid(20)]),
      invoiceOf(2, [paid(40)]),
      invoiceOf(3, [paid(10), paid(500, "PENDING"), paid(500, "DRAFT")]),
      invoiceOf(4, [paid(25)]),
      invoiceOf(5, []),
    ];

    it("(a) 5 targets, invoices 2 and 4 overpay: one 400 naming both with their amounts, ZERO writes", async () => {
      arrange(five());
      const err = await caught(run());
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toEqual({
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
        message:
          "This price change would leave 2 invoices overpaid: INV-2 by $20.00, INV-4 by $5.00. " +
          "Nothing was changed. Issue a credit note on each of them instead.",
        overpaid: [
          { invoiceId: "inv-2", invoiceNumber: "INV-2", paid: 40, newTotal: 20, overpaidBy: 20 },
          { invoiceId: "inv-4", invoiceNumber: "INV-4", paid: 25, newTotal: 20, overpaidBy: 5 },
        ],
      });
      noWrites();
    });

    it("(b) control: the same batch without the two offenders re-prices all five", async () => {
      const batch = five();
      batch[1] = invoiceOf(2, [paid(20)]);
      batch[3] = invoiceOf(4, [paid(5)]);
      arrange(batch);
      await run();
      expect(prisma.invoice.update).toHaveBeenCalledTimes(5);
      // PAID where the payment covers the new total (inv-1, inv-2), the rest keep their balance
      const statusOf = (id: string) =>
        prisma.invoice.update.mock.calls.find((c) => c[0].where.id === id)![0].data.status;
      expect(statusOf("inv-1")).toBe(InvoiceStatus.PAID);
      expect(statusOf("inv-2")).toBe(InvoiceStatus.PAID);
      expect(statusOf("inv-4")).toBe(InvoiceStatus.PARTIAL);
    });

    it("(c) a ONE-offender batch still answers with the list shape (one entry), not a bare string", async () => {
      arrange([invoiceOf(1, []), invoiceOf(2, [paid(21)])]);
      const err = await caught(run());
      expect(err.getResponse().message).toBe(
        "This price change would leave 1 invoice overpaid: INV-2 by $1.00. " +
          "Nothing was changed. Issue a credit note on each of them instead.",
      );
      expect(err.getResponse().overpaid).toHaveLength(1);
      noWrites();
    });

    it("(d) DRAFT and PENDING payments are ignored by the guard: only CONFIRMED (PAID) money counts", async () => {
      arrange([invoiceOf(1, [paid(500, "PENDING"), paid(500, "DRAFT")])]);
      await run();
      expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
      expect(prisma.invoice.update.mock.calls[0][0].data.status).toBe(InvoiceStatus.SENT);
    });

    it("(e) the comparison is in cents: 0.1 + 0.2 paid against a $0.30 total is not an overpayment", async () => {
      arrange([
        invoiceOf(1, [paid(0.1), paid(0.2)], {
          items: [line("l1", { unitPrice: 1, subtotal: 1 })],
        }),
      ]);
      await run(0.3);
      expect(prisma.invoice.update).toHaveBeenCalledTimes(1);
    });

    it("(f) a line refusal (negative subtotal) on an earlier invoice wins: it is named, and nothing is written", async () => {
      arrange([
        invoiceOf(1, [], { items: [line("l1", { discount: 40, subtotal: 10 })] }),
        invoiceOf(2, [paid(40)]),
      ]);
      const err = await caught(run(5));
      expect(err.getResponse().code).toBe(API_ERROR_CODES.MONEY_INVARIANT);
      expect(err.message).toMatch(/^Invoice INV-1: Line item "Widget" has a negative subtotal/);
      noWrites();
    });

    it("(g) the race re-judge: a payment landing after the pre-flight read refuses invoice 2 in its tx as a PARTIAL with the overpay code", async () => {
      const batch = [invoiceOf(1, []), invoiceOf(2, []), invoiceOf(3, [])];
      arrange(batch);
      const live2 = { ...batch[1], payments: [paid(40)] }; // the tx re-read under the lock sees it
      prisma.invoice.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === "inv-2" ? live2 : (batch.find((b) => b.id === where.id) ?? null),
      );
      const err = await caught(run());
      expect(err).toBeInstanceOf(ConflictException);
      const body = err.getResponse();
      expect(body.code).toBe(API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL);
      expect(body.applied).toEqual(["inv-1"]);
      expect(body.refused).toEqual({
        invoiceId: "inv-2",
        invoiceNumber: "INV-2",
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
        message: `Invoice INV-2: This price change would leave the invoice overpaid by ${money(20)} (paid ${money(40)}, new total ${money(20)}). Issue a credit note instead.`,
      });
      expect(body.skipped).toEqual(["inv-3"]);
    });
  });

  describe("fold 1: the pre-flight projects the SAME total the tx will write", () => {
    const noDb = { trackedCategory: { findMany: jest.fn() }, product: { findMany: jest.fn() } };
    const plan = (inv: any, price = 20) => ({
      inv,
      localMap: new Map<string, number>(inv.items.map((l: any) => [l.id as string, price])),
    });
    const overpaid = async (inv: any, db: any = noDb) => {
      const err: any = await preflightBulkPriceAdjustment([plan(inv)], false, db).then(
        () => null,
        (e) => e,
      );
      return err?.getResponse?.().overpaid ?? null;
    };

    it("(h) regular tax counts: $20 at 10% is a $22 total, so paying 22 settles and paying 23 overpays by $1", async () => {
      const taxed = (payments: any[]) =>
        invoiceOf(1, payments, {
          items: [line("l1", { taxRate: 0.1 })],
          subtotal: 50,
          taxAmount: 5,
          total: 55,
        });
      expect(await overpaid(taxed([paid(22)]))).toBeNull();
      expect(await overpaid(taxed([paid(23)]))).toEqual([
        { invoiceId: "inv-1", invoiceNumber: "INV-1", paid: 23, newTotal: 22, overpaidBy: 1 },
      ]);
    });

    it("(i) a legacy invoice (every line taxRate 0, a real $5 tax) is judged with the flat rate the tx stamps", async () => {
      // the tx stamps the inferred 10% on the lines before it totals, so the new total is 22, not 20
      const legacy = invoiceOf(1, [paid(21)], { subtotal: 50, taxAmount: 5, total: 55 });
      expect(await overpaid(legacy)).toBeNull();
    });

    it("(j) a regulated line's category tax is re-derived from the NEW subtotal (the tx does), not carried over", async () => {
      const db = {
        trackedCategory: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: "cat-1", taxType: "PERCENT_OF_SALE", rate: 0.1, priceIncludesTax: false },
            ]),
        },
        product: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const regulated = (payments: any[]) =>
        invoiceOf(1, payments, {
          items: [line("l1", { trackedCategoryId: "cat-1", categoryTaxAmount: 5 })],
          subtotal: 50,
          taxAmount: 5,
          total: 55,
        });
      // stored levy 5 would make the total 25; re-derived it is 2, so 22
      expect(await overpaid(regulated([paid(25)]), db)).toEqual([
        { invoiceId: "inv-1", invoiceNumber: "INV-1", paid: 25, newTotal: 22, overpaidBy: 3 },
      ]);
      expect(await overpaid(regulated([paid(22)]), db)).toBeNull();
    });
  });

  describe("fold 2: a post-commit throw after >= 1 commit is the PARTIAL body, not a raw error", () => {
    const orderLinked = () => [
      invoiceOf(1, []),
      invoiceOf(2, [], { orderId: "order-2" }),
      invoiceOf(3, []),
    ];

    it("(k) the order re-sync of invoice 2 throws after its commit: PARTIAL, applied [1, 2], syncFailed 2, skipped [3]", async () => {
      arrange(orderLinked());
      jest
        .spyOn(service, "recomputeOrderFromInvoices")
        .mockRejectedValue(new Error("deadlock detected"));
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const err = await caught(run());
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL,
        message:
          "2 of 3 invoices were updated; invoice INV-2 was updated, but its follow-up sync " +
          "(order totals and commissions) did not finish. Review it, then run the change again.",
        applied: ["inv-1", "inv-2"],
        syncFailed: { invoiceId: "inv-2", invoiceNumber: "INV-2" },
        skipped: ["inv-3"],
      });
      // both invoices committed (STOP after the failing one); the raw error text never reaches the body
      expect(prisma.invoice.update).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(err.getResponse())).not.toContain("deadlock");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toEqual(expect.stringContaining("inv-1"));
      expect(String(warn.mock.calls[0][0])).toEqual(expect.stringContaining("inv-2"));
    });

    it("(m) SA-816d: a NaN sibling on target #3's order refuses the WHOLE batch (400 MONEY_INVARIANT) before #1 or #2 commit", async () => {
      const targets = [
        invoiceOf(1, []),
        invoiceOf(2, []),
        invoiceOf(3, [], { orderId: "order-3" }),
      ];
      arrange(targets);
      // the preflight's reads: the other invoices of order-3 (one carries a stored NaN levy) and the order's lines
      prisma.invoice.findMany.mockImplementation(async (args: any) =>
        args?.where?.orderId
          ? [
              {
                id: "inv-sib",
                orderId: "order-3",
                items: [
                  {
                    id: "sib-1",
                    orderItemId: "oi-1",
                    productId: "p-1",
                    qty: 1,
                    unitPrice: 10,
                    subtotal: 10,
                    unitsPerBox: null,
                    categoryTaxAmount: "NaN",
                  },
                ],
              },
            ]
          : targets,
      );
      prisma.order.findUnique.mockResolvedValue({
        id: "order-3",
        lineItems: [{ id: "oi-1", productId: "p-1", status: "PENDING" }],
      });
      const recompute = jest.spyOn(service, "recomputeOrderFromInvoices");
      const err = await caught(run());
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.MONEY_INVARIANT });
      noWrites();
      expect(recompute).not.toHaveBeenCalled();
    });

    it("(l) a ONE-invoice batch whose own order re-sync throws is still PARTIAL (applied [1], skipped [])", async () => {
      arrange([invoiceOf(1, [], { orderId: "order-1" })]);
      jest.spyOn(service, "recomputeOrderFromInvoices").mockRejectedValue(new Error("boom"));
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const body = (await caught(run())).getResponse();
      expect(body.code).toBe(API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL);
      expect(body.applied).toEqual(["inv-1"]);
      expect(body.syncFailed).toEqual({ invoiceId: "inv-1", invoiceNumber: "INV-1" });
      expect(body.skipped).toEqual([]);
      expect(body.message).toMatch(
        /^1 of 1 invoices were updated; invoice INV-1 was updated, but its follow-up sync \(order totals and commissions\) did not finish/,
      );
    });

    it("(l2) SA-816: a MONEY_INVARIANT refusal from the order re-sync AFTER the commit (only a race reaches it now, see (m)) is still PARTIAL with syncFailed, never the raw 400", async () => {
      arrange(orderLinked());
      jest.spyOn(service, "recomputeOrderFromInvoices").mockRejectedValue(
        new BadRequestException({
          code: API_ERROR_CODES.MONEY_INVARIANT,
          message:
            "Invoice line ii-9 category tax holds a stored amount that is not a valid number.",
        }),
      );
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const err = await caught(run());
      expect(err).toBeInstanceOf(ConflictException);
      const body = err.getResponse();
      expect(body.code).toBe(API_ERROR_CODES.PRICE_ADJUSTMENT_PARTIAL);
      expect(body.applied).toEqual(["inv-1", "inv-2"]);
      expect(body.syncFailed).toEqual({ invoiceId: "inv-2", invoiceNumber: "INV-2" });
      expect(body.skipped).toEqual(["inv-3"]);
    });
  });

  describe("fold 3: a fault rethrown after commits is logged with the applied ids and the failing id", () => {
    it("(m) a database fault on invoice 2's write, after invoice 1 committed: rethrown as is, one warn", async () => {
      arrange([invoiceOf(1, []), invoiceOf(2, []), invoiceOf(3, [])]);
      const boom = new Error("connection reset");
      prisma.invoiceItem.update.mockResolvedValueOnce({}).mockRejectedValueOnce(boom);
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      await expect(run()).rejects.toBe(boom);
      expect(warn).toHaveBeenCalledTimes(1);
      const text = String(warn.mock.calls[0][0]);
      expect(text).toContain("inv-1");
      expect(text).toContain("inv-2");
    });

    it("(n) a fault on the FIRST invoice committed nothing, so there is nothing to log", async () => {
      arrange([invoiceOf(1, []), invoiceOf(2, [])]);
      prisma.invoiceItem.update.mockRejectedValueOnce(new Error("connection reset"));
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      await expect(run()).rejects.toThrow("connection reset");
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("fold 4: only KNOWN refusal codes are echoed; an unknown 400 is the generic refusal", () => {
    const plans = [1, 2, 3].map((n) => ({
      inv: { id: `inv-${n}`, invoiceNumber: `INV-${n}` },
      localMap: new Map<string, number>(),
    }));
    /** invoice 1 commits, invoice 2's apply throws `thrown` */
    const refusedBy = async (thrown: Error) => {
      jest.spyOn(Logger.prototype, "warn").mockImplementation();
      const err: any = await applyBulkPriceAdjustment(plans, async (inv, _m, onCommitted) => {
        if (inv.id === "inv-1") return onCommitted();
        throw thrown;
      }).then(
        () => null,
        (e) => e,
      );
      return err.getResponse().refused;
    };

    it("(o) a 400 with no code maps to PRICE_ADJUSTMENT_REFUSED, never MONEY_INVARIANT", async () => {
      expect(await refusedBy(new BadRequestException("Something else was wrong"))).toEqual({
        invoiceId: "inv-2",
        invoiceNumber: "INV-2",
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_REFUSED,
        message: "Invoice INV-2: Something else was wrong",
      });
    });

    it("(p) a 400 with a code this flow does not know maps to the generic code too", async () => {
      const r = await refusedBy(new BadRequestException({ code: "PLAN_GATE", message: "nope" }));
      expect(r.code).toBe(API_ERROR_CODES.PRICE_ADJUSTMENT_REFUSED);
    });

    it("(q) an untagged 409 is generic as well; the lock's own 409s carry INVOICE_CHANGED_CONCURRENTLY", async () => {
      expect((await refusedBy(new ConflictException("clash"))).code).toBe(
        API_ERROR_CODES.PRICE_ADJUSTMENT_REFUSED,
      );
      expect(
        (
          await refusedBy(
            new ConflictException({
              code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
              message: "moved",
            }),
          )
        ).code,
      ).toBe(API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY);
    });

    it("(r) the re-judge's own refusals are tagged at the source: MONEY_INVARIANT for lines and totals, OVERPAYS for the payment guard", async () => {
      const lock = await refusedBy(
        new BadRequestException({ code: API_ERROR_CODES.MONEY_INVARIANT, message: "x" }),
      );
      expect(lock.code).toBe(API_ERROR_CODES.MONEY_INVARIANT);
      const over = await refusedBy(
        new BadRequestException({ code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS, message: "y" }),
      );
      expect(over.code).toBe(API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS);
    });
  });

  describe("the overpay 400 ALWAYS carries the overpaid list (SINGLE scope and the first-invoice race)", () => {
    const entry = {
      invoiceId: "inv-1",
      invoiceNumber: "INV-1",
      paid: 40,
      newTotal: 20,
      overpaidBy: 20,
    };

    it("(v) SINGLE scope: the in-tx guard's 400 has code, message and a ONE-entry overpaid list", async () => {
      arrange([invoiceOf(1, [paid(40)])]);
      const err = await caught(
        service.applyPriceAdjustment("inv-1", {
          items: [{ itemId: "l1", newUnitPrice: 20 }],
          scope: "SINGLE",
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
        message: `This price change would leave the invoice overpaid by ${money(20)} (paid ${money(40)}, new total ${money(20)}). Issue a credit note instead.`,
        overpaid: [entry],
      });
      // The line write is inside the tx and rolls back with the refusal (price-adjustment-overpay-b1051.db.spec.ts);
      // no invoice, ledger or commission write follows it.
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(ledger.correctSaleForPriceChange).not.toHaveBeenCalled();
      expect(commission.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
    });

    it("(w) a bulk FIRST-invoice race refusal (nothing committed yet) keeps the list under the 'Invoice X:' prefix", async () => {
      const batch = [invoiceOf(1, []), invoiceOf(2, [])];
      arrange(batch);
      prisma.invoice.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === "inv-1"
          ? { ...batch[0], payments: [paid(40)] } // a payment landed after the pre-flight read
          : (batch.find((b) => b.id === where.id) ?? null),
      );
      const err = await caught(run());
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        code: API_ERROR_CODES.PRICE_ADJUSTMENT_OVERPAYS,
        message: `Invoice INV-1: This price change would leave the invoice overpaid by ${money(20)} (paid ${money(40)}, new total ${money(20)}). Issue a credit note instead.`,
        overpaid: [entry],
      });
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });

  describe("totalsFromLines: the ONE totals arithmetic (pre-flight projection and tx write)", () => {
    it("(x) rounds the sums and the tax once: 83.70 at 5% + an 8.37 levy is 96.26", () => {
      expect(
        totalsFromLines(
          [{ subtotal: 83.7, taxRate: 0.05, categoryTaxAmount: 8.37 }],
          {
            discount: 0,
            shippingFee: 0,
          },
          false,
        ),
      ).toEqual({ subtotal: 83.7, taxAmount: 12.56, total: 96.26, discount: 0 });
    });

    it("(y) a discount and a shipping fee enter the total, not the tax", () => {
      expect(
        totalsFromLines(
          [{ subtotal: 100, taxRate: 0.1, categoryTaxAmount: 0 }],
          {
            discount: 5,
            shippingFee: 2.5,
          },
          false,
        ),
      ).toEqual({ subtotal: 100, taxAmount: 10, total: 107.5, discount: 5 });
    });
  });

  describe("fold 5: the bulk targets read in a stable order", () => {
    it("(s) the targets query orders by createdAt ascending, id as the tie-break", async () => {
      arrange([invoiceOf(1, [])]);
      await run();
      expect(prisma.invoice.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: "asc" },
        { id: "asc" },
      ]);
    });
  });
});

// B1051 x SA-651 NOT-WORSE: an invoice that is ALREADY insane (discount above its subtotal, so a NEGATIVE
// total) may still be re-priced when the edit does not make it worse. With nothing paid there is nothing to
// overpay: "paid > total" must not read a negative total as a $60 overpayment of $0.
describe("overpaymentOf / assertNotOverpaidByPriceChange: nothing paid is never an overpayment", () => {
  it("(t) $0 confirmed against a legacy NEGATIVE total is not overpaid; the improving re-price may save", () => {
    expect(overpaymentOf(0, -60)).toBe(0);
    expect(() => assertNotOverpaidByPriceChange(0, -60, INV)).not.toThrow();
    expect(() => assertNotOverpaidByPriceChange(0, 0, INV)).not.toThrow();
  });

  it("(u) money that WAS paid against a negative total still is: paid 10 over -60 is $70 over", () => {
    expect(overpaymentOf(10, -60)).toBe(70);
    expect(() => assertNotOverpaidByPriceChange(10, -60, INV)).toThrow("overpaid by $70.00");
  });
});
