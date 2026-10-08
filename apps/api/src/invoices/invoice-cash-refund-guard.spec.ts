/**
 * Money safety pins: an invoice part of which was refunded in CASH cannot be voided, and its order cannot be cancelled.
 *
 * A counter refund is a RESOLUTION OF THE RETURN (EXTERNAL_REFUND + refundedAt), not a payment, so the invoice still reads
 * PAID. `voidInvoice` (after `lockInvoiceRow`) and the order cancel (after `lockOrderForCancel`) must refuse 409
 * INVOICE_HAS_CASH_REFUND BEFORE any write, the wallet release included. Each refusal pin is RED if a guard call is removed
 * or moved after a write; each "proceeds" pin is RED if the guard over-blocks.
 *
 * The fake `tx.return.findFirst` EVALUATES the `where` the guard sends against fake Return rows (a tiny Prisma matcher),
 * so the pins fail on a wrong filter, not just on a missing call. The behavioural order-cancel pins (409 with the order
 * wording, nothing written, call order) live in order-cancel-cas.spec.ts, which owns the OrdersService harness.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({ getOrGenerate: jest.fn() })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import * as fs from "fs";
import * as path from "path";
import { ConflictException } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import {
  assertNoCashRefundOnInvoice,
  assertNoCashRefundOnOrder,
  INVOICE_HAS_CASH_REFUND_MESSAGE,
  ORDER_HAS_CASH_REFUND_MESSAGE,
} from "./invoice-cash-refund-guard";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { CASH_REFUNDED_RETURN_WHERE } from "../returns/inline-return-refund";
import { DEAD_RETURN_STATUSES } from "../orders/counter-sale/counter-sale-today";

const INVOICE_ID = "inv-1";
const ORDER_ID = "ord-1";
const THIS_LINE = "line-on-inv-1";

type FakeReturn = {
  id: string;
  kind: "INLINE" | "STANDARD";
  orderId: string;
  status: string;
  refundMethod: string | null;
  refundedAt: Date | null;
  creditNoteId?: string | null;
  items: Array<{ sourceInvoiceItemId: string | null }>;
};

const NOW = new Date("2026-10-01T12:00:00Z");

const cashRefunded = (over: Partial<FakeReturn>): FakeReturn => ({
  id: "ret-1",
  kind: "INLINE",
  orderId: "ord-carry",
  status: "REFUNDED",
  refundMethod: "EXTERNAL_REFUND",
  refundedAt: NOW,
  items: [{ sourceInvoiceItemId: THIS_LINE }],
  ...over,
});

/** The slice of Prisma `where` the guard uses: equality, { not }, { in }, { notIn }, OR, and `items: { some }`. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return cond.some((c: any) => matches(row, c));
    if (key === "items") return (row.items as any[]).some((it) => matches(it, cond.some));
    const value = row[key];
    if (cond !== null && typeof cond === "object") {
      if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
      if ("in" in cond) return (cond.in as unknown[]).includes(value);
      if ("notIn" in cond) return !(cond.notIn as unknown[]).includes(value);
      throw new Error(`fake matcher: unsupported condition on ${key}`);
    }
    return value === cond;
  });
}

/** `tx.return` over fake rows: the filter the guard sends is evaluated, not assumed. */
const returnTable = (returns: FakeReturn[]) => ({
  findFirst: jest.fn(async (args: any) => {
    const hit = returns.find((r) => matches(r, args.where));
    return hit ? { id: hit.id } : null;
  }),
});

function makeTx(returns: FakeReturn[]) {
  const writes = {
    invoiceUpdateMany: jest.fn().mockResolvedValue({ count: 1 }),
    invoiceUpdate: jest.fn(),
    creditNoteUpdate: jest.fn(),
    orderItemUpdate: jest.fn(),
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0), // the row locks of lockInvoiceRow
    invoice: {
      updateMany: writes.invoiceUpdateMany,
      update: writes.invoiceUpdate,
      findUnique: jest.fn().mockResolvedValue({ id: INVOICE_ID, status: "VOID" }),
    },
    invoiceItem: {
      // `id` is what the guard reads; no orderItemId/productId keeps adjustInvoicedQtyForInvoice a no-op.
      findMany: jest.fn().mockResolvedValue([{ id: THIS_LINE, qty: 1 }]),
    },
    orderItem: { findMany: jest.fn().mockResolvedValue([]), update: writes.orderItemUpdate },
    creditNote: { findMany: jest.fn().mockResolvedValue([]), update: writes.creditNoteUpdate },
    invoicePayment: { findMany: jest.fn(), update: jest.fn(), delete: jest.fn() },
    return: returnTable(returns),
  };
  return { tx, writes };
}

/** The real `voidInvoice` over a fake tx: the guard sits in the CALLER now, so the pins drive the caller. */
function makeVoidHarness(returns: FakeReturn[], orderId: string | null = ORDER_ID) {
  const { tx, writes } = makeTx(returns);
  const ledger = { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) };
  const commissionEngine = { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) };
  const release = jest.fn().mockResolvedValue({ credits: [], advances: 0 });
  const prisma = {
    forTenant: () => ({
      invoice: {
        findUnique: jest.fn().mockResolvedValue({ id: INVOICE_ID, orderId, payments: [] }),
      },
    }),
    tenantTransaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const service = Object.create(InvoicesService.prototype) as InvoicesService;
  Object.assign(service, { prisma, ledger, commissionEngine, releaseWalletPaymentsInTx: release });
  return { service, tx, writes, ledger, commissionEngine, release };
}

async function expectRefused(
  promise: Promise<unknown>,
  code = "INVOICE_HAS_CASH_REFUND",
  message = INVOICE_HAS_CASH_REFUND_MESSAGE,
) {
  const err: any = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictException);
  expect(err.getStatus()).toBe(409);
  expect(err.getResponse()).toEqual({ code, message });
}

function expectNothingChanged(h: ReturnType<typeof makeVoidHarness>) {
  expect(h.release).not.toHaveBeenCalled(); // the wallet release is a write too
  expect(h.writes.invoiceUpdateMany).not.toHaveBeenCalled();
  expect(h.writes.invoiceUpdate).not.toHaveBeenCalled();
  expect(h.writes.creditNoteUpdate).not.toHaveBeenCalled();
  expect(h.writes.orderItemUpdate).not.toHaveBeenCalled();
  expect(h.ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
  expect(h.commissionEngine.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
}

describe("voidInvoice refuses 409 INVOICE_HAS_CASH_REFUND when part of the invoice was refunded in cash", () => {
  it("the two codes and the two messages are the contract (own code and wording per surface)", () => {
    expect(API_ERROR_CODES.INVOICE_HAS_CASH_REFUND).toBe("INVOICE_HAS_CASH_REFUND");
    expect(API_ERROR_CODES.ORDER_HAS_CASH_REFUND).toBe("ORDER_HAS_CASH_REFUND");
    expect(INVOICE_HAS_CASH_REFUND_MESSAGE).toBe(
      "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.",
    );
    expect(ORDER_HAS_CASH_REFUND_MESSAGE).toBe(
      "Part of this order was refunded in cash. Issue a credit note instead of cancelling.",
    );
  });

  it("an INLINE return sourced from this invoice's lines, cash-refunded: 409 and NOTHING is written", async () => {
    const h = makeVoidHarness([cashRefunded({})]);

    await expectRefused(h.service.voidInvoice(INVOICE_ID));

    expectNothingChanged(h);
    // only lockInvoiceRow's re-read happened, not the void's own
    expect(h.tx.invoice.findUnique).toHaveBeenCalledTimes(1);
  });

  it("the void refuses with INVOICE_HAS_CASH_REFUND and never the order code (red if the two are swapped)", async () => {
    const h = makeVoidHarness([cashRefunded({})]);
    const err: any = await h.service.voidInvoice(INVOICE_ID).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err.getResponse().code).toBe("INVOICE_HAS_CASH_REFUND");
    expect(err.getResponse().code).not.toBe("ORDER_HAS_CASH_REFUND");
    expect(err.getResponse().message).toBe(INVOICE_HAS_CASH_REFUND_MESSAGE);
  });

  it("the same refusal holds for a standalone invoice (no order)", async () => {
    const h = makeVoidHarness([cashRefunded({})], null);

    await expectRefused(h.service.voidInvoice(INVOICE_ID));

    expectNothingChanged(h);
  });

  it("a STANDARD return on the invoice's order, cash-refunded: 409 and NOTHING is written", async () => {
    const standard = cashRefunded({
      id: "ret-std",
      kind: "STANDARD",
      orderId: ORDER_ID,
      status: "PROCESSED",
      items: [],
    });
    const h = makeVoidHarness([standard]);

    await expectRefused(h.service.voidInvoice(INVOICE_ID));

    expectNothingChanged(h);
  });

  it("the guard runs ONCE per void, after the row locks and BEFORE the wallet release and every other write", async () => {
    const h = makeVoidHarness([]);

    await h.service.voidInvoice(INVOICE_ID);

    const guardRead = h.tx.return.findFirst.mock.invocationCallOrder;
    expect(guardRead).toHaveLength(1); // not repeated inside voidInvoiceInTx
    expect(h.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(guardRead[0]);
    expect(guardRead[0]).toBeLessThan(h.release.mock.invocationCallOrder[0]);
    expect(guardRead[0]).toBeLessThan(h.writes.invoiceUpdateMany.mock.invocationCallOrder[0]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("a PENDING refund (EXTERNAL_REFUND chosen, refundedAt still null) does not block: the void proceeds", async () => {
    const pending = cashRefunded({ status: "RECEIVED", refundedAt: null });
    const standardPending = cashRefunded({
      id: "ret-std",
      kind: "STANDARD",
      orderId: ORDER_ID,
      status: "APPROVED",
      refundedAt: null,
      items: [],
    });
    const h = makeVoidHarness([pending, standardPending]);

    await h.service.voidInvoice(INVOICE_ID);

    expect(h.writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.ledger.reverseInvoiceEntries).toHaveBeenCalledTimes(1);
  });

  it.each(["CANCELLED", "REJECTED"])(
    "a %s return does not block, inline or standard (it moved no money)",
    async (dead) => {
      const inline = cashRefunded({ status: dead });
      const standard = cashRefunded({
        id: "ret-std",
        kind: "STANDARD",
        orderId: ORDER_ID,
        status: dead,
        items: [],
      });
      const h = makeVoidHarness([inline, standard]);

      await h.service.voidInvoice(INVOICE_ID);

      expect(h.writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("returns that are not a cash refund of THIS invoice do not block", async () => {
    const storeCredit = cashRefunded({
      id: "ret-credit",
      status: "PROCESSED",
      refundMethod: "CREDIT_NOTE",
      refundedAt: null,
      creditNoteId: "cn-1",
    });
    const otherInvoice = cashRefunded({
      id: "ret-other",
      items: [{ sourceInvoiceItemId: "line-on-another-invoice" }],
    });
    const otherOrder = cashRefunded({
      id: "ret-other-order",
      kind: "STANDARD",
      orderId: "ord-other",
      items: [],
    });
    // an INLINE return CARRIED by this invoice's order refunds goods sold elsewhere: this invoice is the new sale
    const carriedHere = cashRefunded({
      id: "ret-carried",
      orderId: ORDER_ID,
      items: [{ sourceInvoiceItemId: "line-on-an-earlier-sale" }],
    });
    const h = makeVoidHarness([storeCredit, otherInvoice, otherOrder, carriedHere]);

    await h.service.voidInvoice(INVOICE_ID);

    expect(h.writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("an invoice with no returns voids as before", async () => {
    const h = makeVoidHarness([]);

    await h.service.voidInvoice(INVOICE_ID);

    expect(h.writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.ledger.reverseInvoiceEntries).toHaveBeenCalledTimes(1);
    expect(h.commissionEngine.syncInvoiceCommissionSafe).toHaveBeenCalledTimes(1);
  });

  it("the guard reads returns and invoice lines only (no payment is touched, no write is made)", async () => {
    const { tx } = makeTx([cashRefunded({})]);

    await expect(assertNoCashRefundOnInvoice(tx, INVOICE_ID, ORDER_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(tx.invoicePayment.findMany).not.toHaveBeenCalled();
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});

describe("assertNoCashRefundOnOrder (order cancel): the same refusal for every live invoice of the order", () => {
  const LINE_ON_ORDER = "line-on-an-invoice-of-ord-1";
  const orderTx = (returns: FakeReturn[], lineIds: string[] = [LINE_ON_ORDER]) => ({
    invoiceItem: { findMany: jest.fn().mockResolvedValue(lineIds.map((id) => ({ id }))) },
    invoice: { findMany: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    invoicePayment: { findMany: jest.fn() },
    return: returnTable(returns),
  });
  const onOrderLine = (over: Partial<FakeReturn>) =>
    cashRefunded({ items: [{ sourceInvoiceItemId: LINE_ON_ORDER }], ...over });

  it("an INLINE return sourced from a live invoice of the order, cash-refunded: 409 with the ORDER wording", async () => {
    const tx = orderTx([onOrderLine({})]);

    await expectRefused(
      assertNoCashRefundOnOrder(tx, ORDER_ID),
      "ORDER_HAS_CASH_REFUND",
      ORDER_HAS_CASH_REFUND_MESSAGE,
    );

    // the lines come from the order's non-VOID invoices in ONE query (no invoice.findMany)
    expect(tx.invoiceItem.findMany).toHaveBeenCalledWith({
      where: { invoice: { orderId: ORDER_ID, status: { not: "VOID" } } },
      select: { id: true },
    });
    expect(tx.invoice.findMany).not.toHaveBeenCalled();
  });

  it("a STANDARD return on the order, cash-refunded: 409 (even when the invoices have no lines)", async () => {
    const standard = cashRefunded({
      id: "ret-std",
      kind: "STANDARD",
      orderId: ORDER_ID,
      status: "PROCESSED",
      items: [],
    });

    await expectRefused(
      assertNoCashRefundOnOrder(orderTx([standard], []), ORDER_ID),
      "ORDER_HAS_CASH_REFUND",
      ORDER_HAS_CASH_REFUND_MESSAGE,
    );
  });

  it("the cancel refuses with ORDER_HAS_CASH_REFUND and never the invoice code (red if the two are swapped)", async () => {
    const err: any = await assertNoCashRefundOnOrder(orderTx([onOrderLine({})]), ORDER_ID).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err.getResponse().code).toBe("ORDER_HAS_CASH_REFUND");
    expect(err.getResponse().code).not.toBe("INVOICE_HAS_CASH_REFUND");
    expect(err.getResponse().message).toBe(ORDER_HAS_CASH_REFUND_MESSAGE);
  });

  it("PENDING, CANCELLED and REJECTED returns do not block the cancel", async () => {
    const pending = onOrderLine({ id: "r1", status: "RECEIVED", refundedAt: null });
    const cancelled = onOrderLine({ id: "r2", status: "CANCELLED" });
    const rejected = onOrderLine({ id: "r3", status: "REJECTED" });
    const standardRejected = cashRefunded({
      id: "r4",
      kind: "STANDARD",
      orderId: ORDER_ID,
      status: "REJECTED",
      items: [],
    });

    const tx = orderTx([pending, cancelled, rejected, standardRejected]);

    await expect(assertNoCashRefundOnOrder(tx, ORDER_ID)).resolves.toBeUndefined();
  });

  it("returns that are not a cash refund of THIS order do not block", async () => {
    const otherOrderLine = cashRefunded({
      id: "r-other",
      items: [{ sourceInvoiceItemId: "line-on-another-order" }],
    });
    const otherOrder = cashRefunded({
      id: "r-other-order",
      kind: "STANDARD",
      orderId: "ord-other",
      items: [],
    });
    const storeCredit = onOrderLine({
      id: "r-credit",
      refundMethod: "CREDIT_NOTE",
      refundedAt: null,
      creditNoteId: "cn-1",
    });

    await expect(
      assertNoCashRefundOnOrder(orderTx([otherOrderLine, otherOrder, storeCredit]), ORDER_ID),
    ).resolves.toBeUndefined();
  });

  it("an order with no returns passes, and the guard reads only (no write, no payment read)", async () => {
    const tx = orderTx([]);

    await assertNoCashRefundOnOrder(tx, ORDER_ID);

    expect(tx.invoicePayment.findMany).not.toHaveBeenCalled();
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
    expect(tx.invoice.update).not.toHaveBeenCalled();
  });
});

describe("CASH_REFUNDED_RETURN_WHERE excludes the dead return statuses today's sales already uses", () => {
  it("the exclusion IS DEAD_RETURN_STATUSES (REJECTED and CANCELLED), reused, not a second list", () => {
    expect(CASH_REFUNDED_RETURN_WHERE.status.notIn).toBe(DEAD_RETURN_STATUSES);
    expect([...DEAD_RETURN_STATUSES].sort()).toEqual(["CANCELLED", "REJECTED"]);
    expect(CASH_REFUNDED_RETURN_WHERE.refundMethod).toBe("EXTERNAL_REFUND");
    expect(CASH_REFUNDED_RETURN_WHERE.refundedAt).toEqual({ not: null });
  });
});

describe("where the guards are wired (source pins; strict: one call site per path, before the first write)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
  const invoicesSource = read("invoices.service.ts");
  const ordersSource = read("../orders/orders.service.ts");
  const methodBody = (name: string): string => {
    const start = invoicesSource.indexOf(`  async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = invoicesSource.indexOf("\n  async ", start + 1);
    return invoicesSource.slice(start, next === -1 ? undefined : next);
  };

  it("invoice void: exactly one call, in voidInvoice, after lockInvoiceRow and before the wallet release and the void", () => {
    expect(invoicesSource.match(/assertNoCashRefundOnInvoice\(/g)).toHaveLength(1);
    const body = methodBody("voidInvoice");
    const guard = body.indexOf("await assertNoCashRefundOnInvoice(tx, id, inv.orderId);");
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf("lockInvoiceRow(tx, id, inv.orderId)")).toBeLessThan(guard);
    expect(guard).toBeLessThan(body.indexOf("this.releaseWalletPaymentsInTx(tx, id)"));
    expect(guard).toBeLessThan(body.indexOf("this.voidInvoiceInTx(tx, id, inv.orderId)"));
  });

  it("voidInvoiceInTx does not repeat the guard (the callers assert once, before their writes)", () => {
    const body = methodBody("voidInvoiceInTx");
    expect(body).not.toContain("assertNoCashRefundOn");
    expect(body).not.toContain("INVOICE_HAS_CASH_REFUND");
  });

  it("order cancel: exactly one call, right after lockOrderForCancel and before the claim, the stock credit and the invoice teardown", () => {
    expect(ordersSource.match(/assertNoCashRefundOnOrder\(/g)).toHaveLength(1);
    const lock = ordersSource.indexOf("await lockOrderForCancel(tx, id);");
    const guard = ordersSource.indexOf("await assertNoCashRefundOnOrder(tx, id);");
    expect(lock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(lock);
    const after = ordersSource.slice(lock);
    expect(guard - lock).toBeLessThan(120); // adjacent: nothing sits between the lock and the guard
    expect(guard).toBeLessThan(lock + after.indexOf("tx.order.updateMany"));
    expect(guard).toBeLessThan(lock + after.indexOf("this.settleStockForEdit("));
    expect(guard).toBeLessThan(lock + after.indexOf("releaseOrderCreditsInTx(tx, id)"));
    expect(guard).toBeLessThan(lock + after.indexOf("releaseWalletPaymentsInTx(tx, inv.id)"));
  });
});

describe("voiding a PAYMENT on a cash-refunded invoice stays allowed", () => {
  // Source check, not a behavioural run: voidPayment drags withAfterCommit, tenantTimeZone, the ledger, the commission
  // engine and the invoice recompute, so a faithful fake costs more than the property is worth. The guard is only
  // reachable from voidInvoice / the order cancel (pinned above), and voidPayment calls neither.
  const source = fs.readFileSync(path.join(__dirname, "invoices.service.ts"), "utf8");
  const start = source.indexOf("  async voidPayment(");
  const body = source.slice(start, source.indexOf("\n  async ", start + 1));

  it("voidPayment never reaches the guard or the invoice void, so the invoice keeps its total (balance = total)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain("assertNoCashRefundOn");
    expect(body).not.toContain("voidInvoiceInTx");
    expect(body).not.toContain("voidInvoice(");
    expect(body).not.toContain("INVOICE_HAS_CASH_REFUND");
  });
});
