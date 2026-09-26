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
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        log.push(strings.join("?").includes('"Order"') ? "lock Order" : "lock Invoices");
      }),
      invoice: {
        findMany: jest.fn(async (args: any) => {
          log.push(args.select?.payments ? "re-read payments" : "list invoices");
          return args.select?.payments ? invoices : invoices.map((i) => ({ id: i.id }));
        }),
      },
    };
  }

  it("locks the Order, then the invoices (stable id order), THEN re-reads their payments", async () => {
    const t = tx([{ id: "i1", invoiceNumber: "INV-1", payments: [] }]);
    await lockOrderForCancel(t, "o1");
    expect(t.log).toEqual(["lock Order", "list invoices", "lock Invoices", "re-read payments"]);
    expect(t.invoice.findMany.mock.calls[0][0]).toMatchObject({ orderBy: { id: "asc" } });
  });

  it("a cash payment found under the lock refuses the cancel before any write", async () => {
    const t = tx([{ id: "i1", invoiceNumber: "INV-1", payments: [cash(20)] }]);
    await expect(lockOrderForCancel(t, "o1")).rejects.toThrow(BadRequestException);
  });

  it("an order with no live invoices locks only the Order", async () => {
    const t = tx([]);
    await lockOrderForCancel(t, "o1");
    expect(t.log).toEqual(["lock Order", "list invoices"]);
  });
});
