import type { PaymentMethod } from "@prisma/client";
import { toPrismaMethod } from "../orders/counter-sale/counter-sale-payment";
import {
  createPaymentRefGuard,
  isPaymentAlreadyRecorded,
  type PaymentRefInput,
} from "./payment-ref-dedupe";
import { keyedPayment, invoicePaymentKey, paymentRequestHash } from "./payment-idempotency";

// The advisory lock is a DB concern (DB lane); here it is a pass-through so the call ORDER is what is pinned.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

/** A transaction double that records the duplicate-candidate query. */
function txDouble(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const tx: any = {
    invoicePayment: { findMany },
    advancePayment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    customer: { findUnique: jest.fn().mockResolvedValue({ isWalkIn: false }) },
    invoice: { findUnique: jest.fn() },
  };
  return { tx, findMany };
}

describe("payment-ref dedupe receives the STORED PaymentMethod (D4)", () => {
  it("a CARD till tender reaches the guard query as CREDIT_CARD", async () => {
    const stored = toPrismaMethod("CARD")!;
    expect(stored).toBe("CREDIT_CARD");
    const { tx, findMany } = txDouble();
    await createPaymentRefGuard({
      method: stored,
      reference: "AUTH 1",
      amount: 10,
      customerId: "c1",
    }).check(tx);
    expect(findMany.mock.calls[0][0].where.method).toBe("CREDIT_CARD");
  });

  it("the guard's method type rejects a till string", () => {
    const bad: PaymentRefInput = {
      // @ts-expect-error "CARD" is a till method, not a stored PaymentMethod
      method: "CARD",
      amount: 1,
    };
    const ok: PaymentMethod = "CREDIT_CARD";
    expect(bad).toBeDefined();
    expect(ok).toBe("CREDIT_CARD");
  });
});

describe("a Stripe redelivery of the same intent settles idempotently", () => {
  it("a candidate row carrying the capture's own source reference throws PaymentAlreadyRecordedError", async () => {
    const { tx } = txDouble([
      {
        id: "p1",
        amount: 25,
        paidAt: new Date(),
        paymentNumber: "PAY-1",
        paymentGroupId: "g1",
        reference: "pi_123",
        invoiceId: "i1",
        invoice: { invoiceNumber: "INV-1" },
      },
    ]);
    const err = await createPaymentRefGuard({
      method: "CREDIT_CARD",
      reference: "pi_123",
      amount: 25,
      customerId: "c1",
      opts: { capturedExternally: { source: "STRIPE", sourceRef: "pi_123" } },
    })
      .check(tx)
      .catch((e) => e);
    expect(isPaymentAlreadyRecorded(err)).toBe(true);
  });
});

describe("a same-key second attempt replays and never meets the dedupe (T4)", () => {
  const dto = { amount: 120, method: "CASH" as const, reference: "receipt 9" };
  const keyed = invoicePaymentKey("inv-1", dto as never);
  const hash = paymentRequestHash(keyed.req);
  const completed = {
    state: "COMPLETED",
    scope: keyed.scope,
    requestHash: hash,
    result: { id: "inv-1", createdPaymentId: "pay-1" },
  };

  function deps(held: unknown[], tx: any) {
    const findFirst = jest.fn();
    for (const h of held) findFirst.mockResolvedValueOnce(h);
    return {
      getTenantId: () => "t1",
      forTenant: () => ({
        paymentIdempotencyKey: { findFirst },
        invoicePayment: { findMany: jest.fn().mockResolvedValue([]) },
        invoice: { findFirst: jest.fn().mockResolvedValue(null) },
      }),
      tx,
    } as any;
  }

  it("the loser of a claim race (claim inserts nothing) replays; the duplicate check never runs", async () => {
    const { tx, findMany } = txDouble([{ id: "p-winner", amount: 120 }]);
    tx.$queryRaw = jest.fn().mockResolvedValue([]); // ON CONFLICT DO NOTHING: the key is taken
    const write = jest.fn(async (o: any) => {
      await o.claim(tx);
      return { id: "never" };
    });
    const out: any = await keyedPayment(
      deps([null, completed], tx),
      keyed,
      { idempotencyKey: "k1" } as any,
      write,
    );
    expect(out.replayed).toBe(true);
    expect(out.createdPaymentId).toBe("pay-1");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a held key replays before the writer (and so the dedupe) is ever entered", async () => {
    const { tx, findMany } = txDouble([{ id: "p-winner", amount: 120 }]);
    const write = jest.fn();
    const out: any = await keyedPayment(
      deps([completed], tx),
      keyed,
      { idempotencyKey: "k1" } as any,
      write,
    );
    expect(out.replayed).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
