import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createPaymentRefGuard } from "./payment-ref-dedupe";
import { keyedPayment, advancePaymentKey } from "./payment-idempotency";

// The advisory lock is a DB concern (DB lane): a pass-through here.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
}));

const ADV = {
  id: "adv-1",
  amount: 75,
  reference: "chk 4411",
  receivedAt: new Date("2026-10-01T00:00:00Z"),
};
const PAY = {
  id: "pay-1",
  amount: 75,
  paidAt: new Date("2026-10-01T00:00:00Z"),
  paymentNumber: "PAY-1",
  paymentGroupId: null,
  reference: "CHK-4411",
  invoiceId: "inv-1",
  invoice: { invoiceNumber: "INV-1" },
};

function tx(opts: { advances?: unknown[]; payments?: unknown[]; walkIn?: boolean } = {}) {
  return {
    invoicePayment: { findMany: jest.fn().mockResolvedValue(opts.payments ?? []) },
    advancePayment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(opts.advances ?? []),
    },
    customer: { findUnique: jest.fn().mockResolvedValue({ isWalkIn: !!opts.walkIn }) },
    invoice: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
  } as any;
}

const input = { method: "CHECK" as const, reference: "CHK 4411", amount: 75, customerId: "c1" };

describe("AdvancePayment joins the payment-reference dedupe (SA-837b item 2, G4)", () => {
  it("advance -> advance: a second advance with the same customer, method, reference and amount is a 409", async () => {
    const err = await createPaymentRefGuard(input)
      .check(tx({ advances: [ADV] }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().existingPayment).toMatchObject({ id: "adv-1", amount: 75 });
    expect(err.getResponse().existingPayment.invoiceId).toBeNull();
  });

  it("advance -> standalone/invoice payment: an invoice payment already carries the reference", async () => {
    const err = await createPaymentRefGuard(input)
      .check(tx({ payments: [PAY] }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().existingPayment).toMatchObject({ id: "pay-1" });
  });

  it("standalone -> advance: a standalone payment whose reference an advance already carries is a 409", async () => {
    const err = await createPaymentRefGuard({ ...input, invoiceId: "inv-9" })
      .check(tx({ advances: [ADV] }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().existingPayment.id).toBe("adv-1");
  });

  it("a different amount, or a walk-in, is not a duplicate", async () => {
    await expect(
      createPaymentRefGuard({ ...input, amount: 76 }).check(
        tx({ advances: [{ ...ADV, amount: 75 }] }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      createPaymentRefGuard(input).check(tx({ advances: [ADV], walkIn: true })),
    ).resolves.toBeUndefined();
  });

  it("staff recordAnyway records the advance with exactly one audit row naming the advance", async () => {
    const t = tx({ advances: [ADV] });
    const guard = createPaymentRefGuard({
      ...input,
      opts: { refDedupe: { actor: "u1", role: "OPERATOR", recordAnyway: true } },
    });
    await guard.check(t);
    await guard.recorded(t, ["adv-2"], null);
    expect(t.auditLog.create).toHaveBeenCalledTimes(1);
    expect(t.auditLog.create.mock.calls[0][0].data).toMatchObject({
      userId: "u1",
      entityType: "advancePayment",
      entityId: "adv-2",
    });
  });

  it("the advance writer's keyedPayment runs the guard (it was skipped before)", async () => {
    const t = tx({ advances: [ADV] });
    const keyed = advancePaymentKey("c1", { amount: 75, method: "CHECK", reference: "CHK 4411" });
    const deps: any = { getTenantId: () => "t1", forTenant: () => ({}) };
    const err = await keyedPayment(deps, keyed, undefined, async (o: any) => {
      await o.claim(t);
      return { id: "never" };
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });
});

describe("AdvancePayment has no status column (its dedupe set is 'every row')", () => {
  it("fails when a status-like column is added, so the new column must be classified here", () => {
    const fields = Object.values(Prisma.AdvancePaymentScalarFieldEnum);
    expect(fields.filter((f) => /status|void/i.test(f))).toEqual([]);
  });
});
