import { BadRequestException } from "@nestjs/common";
import { cancelBlockedMessage, cancelBlockers, lockOrderForCancel } from "./order-cancel-impact";

// #2255 / SA-404d R1: the order-cancel tx locks Order → Invoices and re-runs the ONE blocking
// predicate on the locked rows before any write. Real two-connection proof: F2's DB lane.
describe("order cancel — lock then re-check (SA-404d R1)", () => {
  const cash = (amount: number, status = "PAID") => ({ method: "CASH", amount, status });

  it("cancelBlockers counts external money only (wallet CREDIT_NOTE / ADVANCE never blocks)", () => {
    expect(
      cancelBlockers([
        {
          invoiceNumber: "INV-1",
          payments: [cash(40), { method: "CREDIT_NOTE", amount: 10, status: "PAID" }],
        },
        { invoiceNumber: "INV-2", payments: [{ method: "ADVANCE", amount: 5, status: "PAID" }] },
      ]),
    ).toEqual([{ invoiceNumber: "INV-1", amount: 40 }]);
    expect(cancelBlockedMessage([{ invoiceNumber: "INV-1", amount: 40 }])).toMatch(
      /must be refunded before it can be cancelled: \$40\.00 on INV-1/,
    );
  });

  function tx(invoices: Array<{ id: string; invoiceNumber: string; payments: unknown[] }>) {
    const log: string[] = [];
    return {
      log,
      $executeRaw: jest.fn(async () => {
        log.push("lock Order");
      }),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        log.push(/"Invoice".*ORDER BY id FOR UPDATE/s.test(sql) ? "lock+list Invoices" : sql);
        return invoices.map((i) => ({ id: i.id }));
      }),
      invoice: {
        findMany: jest.fn(async () => {
          log.push("re-read payments");
          return invoices;
        }),
      },
    };
  }

  it("locks the Order, then the invoices (stable id order), THEN re-reads their payments", async () => {
    const t = tx([{ id: "i1", invoiceNumber: "INV-1", payments: [] }]);
    await lockOrderForCancel(t, "o1");
    expect(t.log).toEqual(["lock Order", "lock+list Invoices", "re-read payments"]);
  });

  it("a cash payment found under the lock refuses the cancel before any write", async () => {
    const t = tx([{ id: "i1", invoiceNumber: "INV-1", payments: [cash(20)] }]);
    await expect(lockOrderForCancel(t, "o1")).rejects.toThrow(BadRequestException);
  });

  it("an order with no live invoices locks only the Order", async () => {
    const t = tx([]);
    await lockOrderForCancel(t, "o1");
    expect(t.log).toEqual(["lock Order", "lock+list Invoices"]);
  });
});
