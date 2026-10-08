/**
 * Money safety pins: an invoice part of which was refunded in CASH cannot be voided.
 *
 * A counter refund is a RESOLUTION OF THE RETURN (EXTERNAL_REFUND + refundedAt), not a payment, so the invoice still reads
 * PAID. `voidInvoiceInTx` must refuse 409 INVOICE_HAS_CASH_REFUND before it writes anything. Each refusal pin is RED if
 * the guard call is removed from `voidInvoiceInTx`; each "proceeds" pin is RED if the guard over-blocks.
 *
 * The fake `tx.return.findFirst` EVALUATES the `where` the guard sends against fake Return rows (a tiny Prisma matcher),
 * so the pins fail on a wrong filter, not just on a missing call.
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
  INVOICE_HAS_CASH_REFUND_MESSAGE,
} from "./invoice-cash-refund-guard";
import { API_ERROR_CODES } from "../common/api-error-codes";

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

/** The slice of Prisma `where` the guard uses: equality, { not }, { in }, OR, and `items: { some }`. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return cond.some((c: any) => matches(row, c));
    if (key === "items") return (row.items as any[]).some((it) => matches(it, cond.some));
    const value = row[key];
    if (cond !== null && typeof cond === "object") {
      if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
      if ("in" in cond) return (cond.in as unknown[]).includes(value);
      throw new Error(`fake matcher: unsupported condition on ${key}`);
    }
    return value === cond;
  });
}

function makeTx(returns: FakeReturn[]) {
  const writes = {
    invoiceUpdateMany: jest.fn().mockResolvedValue({ count: 1 }),
    invoiceUpdate: jest.fn(),
    creditNoteUpdate: jest.fn(),
    orderItemUpdate: jest.fn(),
  };
  const tx = {
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
    return: {
      findFirst: jest.fn(async (args: any) => {
        const hit = returns.find((r) => matches(r, args.where));
        return hit ? { id: hit.id } : null;
      }),
    },
  };
  return { tx, writes };
}

function makeService() {
  const ledger = { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) };
  const commissionEngine = { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) };
  const service = Object.create(InvoicesService.prototype) as InvoicesService;
  Object.assign(service, { ledger, commissionEngine });
  return { service, ledger, commissionEngine };
}

async function expectRefused(promise: Promise<unknown>) {
  const err: any = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConflictException);
  expect(err.getStatus()).toBe(409);
  expect(err.getResponse()).toEqual({
    code: "INVOICE_HAS_CASH_REFUND",
    message:
      "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.",
  });
}

function expectNothingChanged(
  writes: ReturnType<typeof makeTx>["writes"],
  ledger: { reverseInvoiceEntries: jest.Mock },
  commissionEngine: { syncInvoiceCommissionSafe: jest.Mock },
) {
  expect(writes.invoiceUpdateMany).not.toHaveBeenCalled();
  expect(writes.invoiceUpdate).not.toHaveBeenCalled();
  expect(writes.creditNoteUpdate).not.toHaveBeenCalled();
  expect(writes.orderItemUpdate).not.toHaveBeenCalled();
  expect(ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
  expect(commissionEngine.syncInvoiceCommissionSafe).not.toHaveBeenCalled();
}

describe("voidInvoiceInTx refuses 409 INVOICE_HAS_CASH_REFUND when part of the invoice was refunded in cash", () => {
  it("the code and the message are the contract", () => {
    expect(API_ERROR_CODES.INVOICE_HAS_CASH_REFUND).toBe("INVOICE_HAS_CASH_REFUND");
    expect(INVOICE_HAS_CASH_REFUND_MESSAGE).toBe(
      "Part of this invoice was refunded in cash. Issue a credit note for the rest instead of voiding.",
    );
  });

  it("an INLINE return sourced from this invoice's lines, cash-refunded: 409 and NOTHING is written", async () => {
    const { tx, writes } = makeTx([cashRefunded({})]);
    const { service, ledger, commissionEngine } = makeService();

    await expectRefused(service.voidInvoiceInTx(tx, INVOICE_ID, ORDER_ID));

    expectNothingChanged(writes, ledger, commissionEngine);
    expect(tx.invoice.findUnique).not.toHaveBeenCalled();
  });

  it("the same refusal holds for a standalone invoice (no order)", async () => {
    const { tx, writes } = makeTx([cashRefunded({})]);
    const { service, ledger, commissionEngine } = makeService();

    await expectRefused(service.voidInvoiceInTx(tx, INVOICE_ID, null));

    expectNothingChanged(writes, ledger, commissionEngine);
  });

  it("a STANDARD return on the invoice's order, cash-refunded: 409 and NOTHING is written", async () => {
    const standard = cashRefunded({
      id: "ret-std",
      kind: "STANDARD",
      orderId: ORDER_ID,
      status: "PROCESSED",
      items: [],
    });
    const { tx, writes } = makeTx([standard]);
    const { service, ledger, commissionEngine } = makeService();

    await expectRefused(service.voidInvoiceInTx(tx, INVOICE_ID, ORDER_ID));

    expectNothingChanged(writes, ledger, commissionEngine);
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
    const { tx, writes } = makeTx([pending, standardPending]);
    const { service, ledger } = makeService();

    await service.voidInvoiceInTx(tx, INVOICE_ID, ORDER_ID);

    expect(writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    expect(ledger.reverseInvoiceEntries).toHaveBeenCalledTimes(1);
  });

  it("a CANCELLED return does not block, inline or standard", async () => {
    const inline = cashRefunded({ status: "CANCELLED" });
    const standard = cashRefunded({
      id: "ret-std",
      kind: "STANDARD",
      orderId: ORDER_ID,
      status: "CANCELLED",
      items: [],
    });
    const { tx, writes } = makeTx([inline, standard]);
    const { service } = makeService();

    await service.voidInvoiceInTx(tx, INVOICE_ID, ORDER_ID);

    expect(writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
  });

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
    const { tx, writes } = makeTx([storeCredit, otherInvoice, otherOrder, carriedHere]);
    const { service } = makeService();

    await service.voidInvoiceInTx(tx, INVOICE_ID, ORDER_ID);

    expect(writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("an invoice with no returns voids as before", async () => {
    const { tx, writes } = makeTx([]);
    const { service, ledger, commissionEngine } = makeService();

    await service.voidInvoiceInTx(tx, INVOICE_ID, ORDER_ID);

    expect(writes.invoiceUpdateMany).toHaveBeenCalledTimes(1);
    expect(ledger.reverseInvoiceEntries).toHaveBeenCalledTimes(1);
    expect(commissionEngine.syncInvoiceCommissionSafe).toHaveBeenCalledTimes(1);
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

describe("voiding a PAYMENT on a cash-refunded invoice stays allowed", () => {
  const source = fs.readFileSync(path.join(__dirname, "invoices.service.ts"), "utf8");
  const methodBody = (name: string): string => {
    const start = source.indexOf(`  async ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf("\n  async ", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it("voidPayment never reaches the guard or the invoice void, so the invoice keeps its total (balance = total)", () => {
    const body = methodBody("voidPayment");
    expect(body).not.toContain("assertNoCashRefundOnInvoice");
    expect(body).not.toContain("voidInvoiceInTx");
    expect(body).not.toContain("INVOICE_HAS_CASH_REFUND");
  });

  it("the guard is wired into exactly one place: the first statement of voidInvoiceInTx", () => {
    expect(source.match(/assertNoCashRefundOnInvoice\(/g)).toHaveLength(1);
    const body = methodBody("voidInvoiceInTx");
    expect(body).toContain("await assertNoCashRefundOnInvoice(tx, id, orderId);");
    expect(body.indexOf("assertNoCashRefundOnInvoice")).toBeLessThan(body.indexOf("updateMany"));
  });
});
