import { createOpLogTx } from "../testing/op-log-tx";
import {
  lockCreditNotes,
  lockCreditsForSend,
  lockCustomerCreditsForSweep,
  lockInvoiceForCredit,
  lockOrderCreditSettle,
  lockOrderRow,
} from "./credit-note-locks";

/**
 * B1052 review fold-in: every credit-write row lock is tenant-scoped (as credit-notes.service
 * `create` and line-credit-headroom already are), so an id that belongs to another tenant — a
 * crafted creditNoteId / invoiceId / orderId — can never lock, and so stall, that tenant's rows.
 * `tenantId = null` is the documented unwrapped-tx case (settleOrderCreditsInTx's own default): it
 * locks on the id alone, exactly as orders.service's Order lock does.
 */
const TENANT = "tenant-1";
const lockStatements = (log: ReturnType<typeof createOpLogTx>["log"]) =>
  log.filter((e) => e.op === "$executeRaw" || e.op === "$queryRaw");

describe("credit-note-locks — every FOR UPDATE is tenant-scoped", () => {
  const cases: Array<[string, (tx: any, tenantId: string | null) => Promise<void>, number]> = [
    ["lockCreditNotes", (tx, t) => lockCreditNotes(tx, t, ["cn-b", "cn-a"]), 1],
    ["lockInvoiceForCredit", (tx, t) => lockInvoiceForCredit(tx, t, "inv-1"), 2],
    ["lockOrderRow", (tx, t) => lockOrderRow(tx, t, "ord-1"), 1],
    ["lockOrderCreditSettle", (tx, t) => lockOrderCreditSettle(tx, t, "ord-1"), 3],
    [
      "lockCustomerCreditsForSweep",
      (tx, t) => lockCustomerCreditsForSweep(tx, t, "inv-1", "cust-1"),
      3,
    ],
    [
      "lockCreditsForSend",
      (tx, t) => lockCreditsForSend(tx, t, { orderId: "ord-1", customerId: "cust-1" }),
      2,
    ],
  ];

  it.each(cases)("%s binds the session tenant into every lock", async (_name, run, count) => {
    const { tx, log } = createOpLogTx();
    await run(tx, TENANT);
    const locks = lockStatements(log);
    expect(locks).toHaveLength(count);
    for (const lock of locks) {
      // SA-706a: a CreditNote lock is FOR NO KEY UPDATE (its FK holders take KEY SHARE); Order and
      // Invoice locks stay FOR UPDATE.
      const table = /FROM "(\w+)"/.exec(lock.sql ?? "")?.[1];
      expect(lock.sql).toMatch(
        table === "CreditNote" ? / FOR NO KEY UPDATE$/ : /(?<!NO KEY) FOR UPDATE$/,
      );
      expect(lock.sql).toContain('"tenantId"');
      expect(lock.values).toContain(TENANT);
    }
  });

  it.each(cases)(
    "%s with no tenant still locks (on the id alone), never skips",
    async (_n, run, count) => {
      const { tx, log } = createOpLogTx();
      await run(tx, null);
      expect(lockStatements(log)).toHaveLength(count);
      for (const lock of lockStatements(log))
        expect(lock.sql).toMatch(/::text IS NULL OR "tenantId"/);
    },
  );

  it("lockCreditNotes locks nothing for an empty id list, and dedupes the ids", async () => {
    const empty = createOpLogTx();
    await lockCreditNotes(empty.tx, TENANT, [null, undefined]);
    expect(empty.log).toHaveLength(0);

    const { tx, log } = createOpLogTx();
    await lockCreditNotes(tx, TENANT, ["cn-b", "cn-a", "cn-b"]);
    // The id list is a nested Prisma.join: its values are the sorted, deduped ids.
    const joined = (log[0].values ?? []).find((v) => Array.isArray((v as any)?.values)) as {
      values: unknown[];
    };
    expect(joined.values).toEqual(["cn-a", "cn-b"]);
  });
});

describe("lockCreditsForSend — one pass, SA-214 order (Order → Invoices → every note, id order)", () => {
  it("locks the order's invoices, then the customer's notes AND the settle subset in ONE id-ordered statement", async () => {
    const { tx, log } = createOpLogTx();
    await lockCreditsForSend(tx, TENANT, { orderId: "ord-1", customerId: "cust-1" });
    const locks = lockStatements(log);
    expect(locks[0].sql).toMatch(/FROM "Invoice" WHERE "orderId" = \?/);
    expect(locks[1].sql).toMatch(/FROM "CreditNote"/);
    expect(locks[1].sql).toMatch(/"customerId" = \?/);
    expect(locks[1].sql).toMatch(/FROM "OrderCreditNote"/); // the settle subset rides along
    expect(locks[1].sql).toMatch(/ORDER BY id FOR NO KEY UPDATE$/);
    expect(locks[1].values).toEqual(expect.arrayContaining(["cust-1", "ord-1"]));
  });

  it("an invoice with no order locks only the customer's notes", async () => {
    const { tx, log } = createOpLogTx();
    await lockCreditsForSend(tx, TENANT, { orderId: null, customerId: "cust-1" });
    const locks = lockStatements(log);
    expect(locks).toHaveLength(1);
    expect(locks[0].sql).toMatch(/FROM "CreditNote"/);
    expect(locks[0].sql).not.toMatch(/OrderCreditNote/);
  });
});
