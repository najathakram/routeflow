/**
 * SA-1050 A-2, pure cases for `appendWriteOffEvent` (the one writer of the bad-debt ledger). The fake `tx` keeps the events
 * in memory and answers the three reads the function makes (aggregate, create, the invoice re-read). The DB cases (the
 * tenant, real DECIMAL columns) live in write-off-append.db.spec.ts.
 *
 *   G-a1: a REINSTATE has no amount (compile error); open {+10.67, preTax +10.00} makes -10.67 / -10.00; the invariant
 *         assert throws on a one-cent miss (review-b's -10.66 probe) and the row it had written is the caller's to roll back.
 *   G-c1: the stored figure is `roundMoney`'s value for an input JS carries with dust (10.97 - 0.10 - 0.20).
 */
import { InvoiceStatus } from "@prisma/client";
import { CONFIRMED_STATUS } from "@routeflow/pricing";
import {
  appendWriteOffEvent,
  WriteOffLedgerError,
  type WriteOffEventInput,
} from "./invoice-write-off";

interface Row {
  invoiceId: string;
  tenantId?: string;
  kind: string;
  amount: number;
  preTax: number;
}

const INVOICE = { id: "inv-1", tenantId: "ten-1" };
const deps = (tenant: string | null = "ten-1") => ({ prisma: { getTenantId: () => tenant } });
const WRITE_OFF = (amount: number, preTax: number): WriteOffEventInput => ({
  kind: "WRITE_OFF",
  amount,
  preTax,
  at: new Date("2026-10-28T12:00:00Z"),
  byId: "user-1",
  reason: "uncollectable",
});
const REINSTATE: WriteOffEventInput = {
  kind: "REINSTATE",
  at: new Date("2026-10-28T13:00:00Z"),
  byId: "user-1",
  reason: "paid after all",
};

/** An in-memory tx. `skew` adds cents to every stored amount: the "patched negation" alternative. */
function fakeTx(over: {
  events?: Row[];
  status?: InvoiceStatus;
  total?: number;
  payments?: Array<{ amount: number; status: string }>;
  skew?: number;
}) {
  const events: Row[] = [...(over.events ?? [])];
  const tx = {
    events,
    invoiceWriteOffEvent: {
      aggregate: jest.fn(async ({ where }: { where: { invoiceId: string } }) => {
        const mine = events.filter((e) => e.invoiceId === where.invoiceId);
        return {
          _sum: {
            amount: mine.reduce((s, e) => s + e.amount, 0),
            preTax: mine.reduce((s, e) => s + e.preTax, 0),
          },
        };
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { ...data, amount: data.amount + (over.skew ?? 0) };
        events.push(row);
        return row;
      }),
    },
    invoice: {
      findUnique: jest.fn(async () => ({
        status: over.status ?? InvoiceStatus.WRITTEN_OFF,
        total: over.total ?? 50,
        payments: over.payments ?? [],
      })),
    },
  };
  return tx;
}

describe("appendWriteOffEvent: (a) the exact negative", () => {
  it("G-a1: open {+10.67, preTax +10.00} makes a REINSTATE of -10.67 / -10.00 and nets to 0.00", async () => {
    const tx = fakeTx({
      events: [{ invoiceId: "inv-1", kind: "WRITE_OFF", amount: 10.67, preTax: 10 }],
      status: InvoiceStatus.SENT,
    });

    await appendWriteOffEvent(deps(), tx, INVOICE, REINSTATE);

    expect(tx.invoiceWriteOffEvent.create.mock.calls[0][0].data).toMatchObject({
      kind: "REINSTATE",
      amount: -10.67,
      preTax: -10,
      tenantId: "ten-1",
    });
    const sum = tx.events.reduce((s, e) => s + e.amount, 0);
    expect(Math.round(sum * 100)).toBe(0);
  });

  it("G-a1: a REINSTATE input has no amount or preTax (compile error)", () => {
    const bad: WriteOffEventInput = {
      kind: "REINSTATE",
      // @ts-expect-error a REINSTATE carries no amount: the function writes the exact negative itself
      amount: -10.66,
      at: new Date(),
      byId: null,
      reason: "x",
    };
    expect(bad.kind).toBe("REINSTATE");
  });

  it("G-a1: a one-cent miss on the negative (the -10.66 probe) trips the invariant assert", async () => {
    const tx = fakeTx({
      events: [{ invoiceId: "inv-1", kind: "WRITE_OFF", amount: 10.67, preTax: 10 }],
      status: InvoiceStatus.SENT,
      skew: 0.01,
    });

    await expect(appendWriteOffEvent(deps(), tx, INVOICE, REINSTATE)).rejects.toThrow(
      WriteOffLedgerError,
    );
    await expect(appendWriteOffEvent(deps(), tx, INVOICE, REINSTATE)).rejects.toThrow(
      /still carries/,
    );
  });

  it("a REINSTATE with nothing open is refused (no zero row)", async () => {
    const tx = fakeTx({ events: [], status: InvoiceStatus.SENT });
    await expect(appendWriteOffEvent(deps(), tx, INVOICE, REINSTATE)).rejects.toThrow(
      /nothing to reinstate/,
    );
    expect(tx.invoiceWriteOffEvent.create).not.toHaveBeenCalled();
  });

  it("a WRITE_OFF must equal the confirmed balance: 10.70 total with 0.03 confirmed owes 10.67", async () => {
    const payments = [
      { amount: 0.03, status: CONFIRMED_STATUS },
      { amount: 5, status: "PENDING" },
    ];
    const ok = fakeTx({ total: 10.7, payments });
    await appendWriteOffEvent(deps(), ok, INVOICE, WRITE_OFF(10.67, 10));
    expect(ok.events).toHaveLength(1);

    const off = fakeTx({ total: 10.7, payments });
    await expect(appendWriteOffEvent(deps(), off, INVOICE, WRITE_OFF(10.7, 10))).rejects.toThrow(
      /confirmed balance is 10.67/,
    );
  });

  it("a WRITE_OFF on an invoice that is not WRITTEN_OFF is refused (the caller sets the status first)", async () => {
    const tx = fakeTx({ status: InvoiceStatus.SENT });
    await expect(appendWriteOffEvent(deps(), tx, INVOICE, WRITE_OFF(50, 50))).rejects.toThrow(
      /not WRITTEN_OFF/,
    );
  });
});

describe("appendWriteOffEvent: (b) the tenant is the locked row's", () => {
  it("a locked row with no tenant is refused before anything is read or written", async () => {
    const tx = fakeTx({});
    await expect(
      appendWriteOffEvent(deps(null), tx, { id: "inv-1", tenantId: null }, WRITE_OFF(50, 50)),
    ).rejects.toThrow(/has no tenant/);
    expect(tx.invoiceWriteOffEvent.create).not.toHaveBeenCalled();
  });

  it("a tenant context that differs from the row's is refused", async () => {
    const tx = fakeTx({});
    await expect(
      appendWriteOffEvent(deps("ten-OTHER"), tx, INVOICE, WRITE_OFF(50, 50)),
    ).rejects.toThrow(/not in the calling tenant/);
    expect(tx.invoiceWriteOffEvent.create).not.toHaveBeenCalled();
  });

  it("with no context the row's tenant is the stored one", async () => {
    const tx = fakeTx({});
    await appendWriteOffEvent(deps(null), tx, INVOICE, WRITE_OFF(50, 50));
    expect(tx.invoiceWriteOffEvent.create.mock.calls[0][0].data.tenantId).toBe("ten-1");
  });
});

describe("appendWriteOffEvent: (c) cents", () => {
  it("G-c1: 10.97 - 0.10 - 0.20 (10.670000000000002 in JS) is stored as 10.67", async () => {
    const dusty = 10.97 - 0.1 - 0.2;
    expect(dusty).not.toBe(10.67); // the input really carries dust
    const tx = fakeTx({ total: 10.97, payments: [{ amount: 0.3, status: CONFIRMED_STATUS }] });

    await appendWriteOffEvent(deps(), tx, INVOICE, WRITE_OFF(dusty, 10));

    expect(tx.invoiceWriteOffEvent.create.mock.calls[0][0].data.amount).toBe(10.67);
  });

  it("G-c1: a half-cent input is stored as roundMoney's value", async () => {
    const tx = fakeTx({ total: 10.68 });
    await appendWriteOffEvent(deps(), tx, INVOICE, WRITE_OFF(10.675, 10));
    const stored = tx.invoiceWriteOffEvent.create.mock.calls[0][0].data.amount;
    expect(stored).toBe(10.68);
  });

  it.each([NaN, Infinity, -Infinity])(
    "a non-finite amount (%s) throws and writes nothing",
    async (bad) => {
      const tx = fakeTx({});
      await expect(appendWriteOffEvent(deps(), tx, INVOICE, WRITE_OFF(bad, 1))).rejects.toThrow(
        /finite/,
      );
      expect(tx.invoiceWriteOffEvent.create).not.toHaveBeenCalled();
    },
  );

  it("a blank reason is refused", async () => {
    const tx = fakeTx({});
    await expect(
      appendWriteOffEvent(deps(), tx, INVOICE, { ...WRITE_OFF(50, 50), reason: "  " }),
    ).rejects.toThrow(/reason is required/);
  });
});
