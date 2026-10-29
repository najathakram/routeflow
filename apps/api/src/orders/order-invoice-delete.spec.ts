import * as fs from "fs";
import * as path from "path";
import { SOURCE_DELETED_ACTION } from "../credit-notes/sourced-credit-guard";
import { deleteOrderInvoice } from "./order-invoice-delete";

/**
 * REG-ROW259 (#2848 door wiring): the order service's two invoice-delete doors (deleteOrder's invoice
 * loop and the merge-loser draft delete) go through ONE helper that unlinks the credit notes the
 * invoice sourced, then deletes the invoice. The unlink contract itself is `unlinkSourcedCredits`
 * (source-deleted-2848.spec.ts); this spec pins the helper's wiring around it.
 */
describe("REG-ROW259: deleteOrderInvoice", () => {
  const makeTx = (notes: Array<{ id: string; invoiceId: string }>, invoiceNumber = "INV-7") => {
    const calls: string[] = [];
    const tx = {
      invoice: {
        findUnique: jest.fn().mockImplementation(() => {
          calls.push("number");
          return Promise.resolve({ invoiceNumber });
        }),
        delete: jest.fn().mockImplementation(() => {
          calls.push("delete");
          return Promise.resolve({});
        }),
      },
      creditNote: {
        findMany: jest.fn().mockImplementation(() => {
          calls.push("read");
          return Promise.resolve(notes);
        }),
        updateMany: jest.fn().mockImplementation(() => {
          calls.push("unlink");
          return Promise.resolve({ count: notes.length });
        }),
      },
      // SA-1050 A-1: deleteOrderInvoice first refuses an invoice that has write-off history; none here.
      invoiceWriteOffEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      auditLog: {
        createMany: jest.fn().mockImplementation(() => {
          calls.push("audit");
          return Promise.resolve({ count: notes.length });
        }),
      },
    };
    return { tx, calls };
  };

  it("REG-ROW259: marks and unlinks the sourced credit notes BEFORE it deletes the invoice", async () => {
    const { tx, calls } = makeTx([{ id: "cn-1", invoiceId: "inv-1" }]);

    await deleteOrderInvoice(tx, "inv-1", "t-1");

    expect(tx.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: "t-1",
          userId: null,
          action: SOURCE_DELETED_ACTION,
          entityType: "CreditNote",
          entityId: "cn-1",
          meta: { invoiceId: "inv-1", invoiceNumber: "INV-7" },
        },
      ],
    });
    expect(tx.creditNote.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["cn-1"] } },
      data: { invoiceId: null },
    });
    expect(tx.invoice.delete).toHaveBeenCalledWith({ where: { id: "inv-1" } });
    expect(calls.indexOf("unlink")).toBeGreaterThan(-1);
    expect(calls.indexOf("unlink")).toBeLessThan(calls.indexOf("delete"));
    expect(calls.indexOf("audit")).toBeLessThan(calls.indexOf("delete"));
  });

  it("REG-ROW259: an invoice that sourced no credit note is just deleted (no audit row, no unlink)", async () => {
    const { tx } = makeTx([]);

    await deleteOrderInvoice(tx, "inv-1", "t-1");

    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    expect(tx.creditNote.updateMany).not.toHaveBeenCalled();
    expect(tx.invoice.delete).toHaveBeenCalledTimes(1);
  });

  it("REG-ROW259: a failed unlink stops the call, so the invoice is never deleted", async () => {
    const { tx } = makeTx([{ id: "cn-1", invoiceId: "inv-1" }]);
    tx.creditNote.updateMany.mockRejectedValueOnce(new Error("boom"));

    await expect(deleteOrderInvoice(tx, "inv-1", "t-1")).rejects.toThrow("boom");

    expect(tx.invoice.delete).not.toHaveBeenCalled();
  });

  // SA-1000 §1: the unspent-credit refusal lives IN the helper, so no door can reach the delete without it.
  it("REG-ROW259: an invoice whose sourced credit note is still unspent is refused and nothing is written", async () => {
    const { tx } = makeTx([
      { id: "cn-1", invoiceId: "inv-1", amount: 50, amountUsed: 0, status: "ISSUED" } as never,
    ]);

    await expect(deleteOrderInvoice(tx, "inv-1", "t-1")).rejects.toMatchObject({
      response: { code: "INVOICE_HAS_UNSPENT_CREDIT" },
    });

    expect(tx.auditLog.createMany).not.toHaveBeenCalled();
    expect(tx.creditNote.updateMany).not.toHaveBeenCalled();
    expect(tx.invoice.delete).not.toHaveBeenCalled();
  });

  it("REG-ROW259: a fully spent sourced credit note does not block the delete", async () => {
    const { tx } = makeTx([
      { id: "cn-1", invoiceId: "inv-1", amount: 50, amountUsed: 50, status: "APPLIED" } as never,
    ]);

    await deleteOrderInvoice(tx, "inv-1", "t-1");

    expect(tx.invoice.delete).toHaveBeenCalledTimes(1);
  });

  it("REG-ROW259: assertNoUnspentSourcedCredits is the FIRST awaited call of deleteOrderInvoice, before any read or write", () => {
    const src = fs.readFileSync(path.join(__dirname, "order-invoice-delete.ts"), "utf8");
    const body = src
      .slice(src.indexOf("export async function deleteOrderInvoice("))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const awaits = [...body.matchAll(/await\s+(\w+)/g)].map((m) => m[1]);
    expect(awaits[0]).toBe("assertNoUnspentSourcedCredits");
  });
});
