/**
 * Row 752 (#3635 review B): withPaymentEditRef's lock re-derivation and the guard's inputs, on a fake prisma (no DB).
 *  - NIT 1: a REAL stale key (a concurrent edit moved the reference this edit relies on) is the retryable 503; a
 *    double-clicked Save whose first save already landed (the locked row now needs no check) is NOT.
 *  - NIT 2: a grouped row's own group and its excess advance are seeded as "this attempt", so they never collide.
 *  - SA-865: a grouped row is judged on the group's NEW total.
 */
jest.mock("../common/db-locks", () => require("../common/testing/pass-through-locks").locks());

const guardInputs: any[] = [];
jest.mock("./payment-ref-dedupe", () => {
  const actual = jest.requireActual("./payment-ref-dedupe");
  return {
    ...actual,
    createPaymentRefGuard: jest.fn((p: unknown) => {
      guardInputs.push(p);
      return { check: jest.fn(async () => undefined), recorded: jest.fn(async () => undefined) };
    }),
  };
});

import { withPaymentEditRef } from "./payment-edit-ref";

type Row = {
  id: string;
  method: string;
  reference: string | null;
  amount: number;
  status: string;
  paidAt: Date;
  paymentGroupId: string | null;
};
const PAID_AT = new Date("2026-10-01T12:00:00Z");

/** A fake prisma: `stored` is what the unlocked pre-read sees; `tx` is what the locked transaction sees. */
function fake(stored: Row, tx: Record<string, unknown> = {}) {
  return {
    getTenantId: () => "tenant-a",
    invoice: { findUnique: jest.fn(async () => ({ payments: [stored] })) },
    tenantTransaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        advancePayment: { findMany: jest.fn(async () => []) },
        invoicePayment: { findMany: jest.fn(async () => []) },
        ...tx,
      }),
    ),
  } as any;
}
const row = (over: Partial<Row> = {}): Row => ({
  id: "pay-b",
  method: "CHECK",
  reference: "X1",
  amount: 50,
  status: "PAID",
  paidAt: PAID_AT,
  paymentGroupId: null,
  ...over,
});
const run = (prisma: any, dto: Record<string, unknown>, locked: Row) =>
  withPaymentEditRef(
    prisma,
    { invoiceId: "inv-1", paymentId: "pay-b" },
    dto as never,
    undefined,
    (t, _a, edit) => edit.check(t, locked as never, "cust-1"),
  );

beforeEach(() => (guardInputs.length = 0));

describe("NIT 1: the stale-key check", () => {
  it("a REAL stale key is the 503: no reference in the body, and a concurrent edit moved the stored one", async () => {
    // pre-read: stored "A" -> the lock is taken on CHECK:A; under the lock the row now says "B" -> key CHECK:B
    const prisma = fake(row({ reference: "A", amount: 50 }));
    const err: any = await run(
      prisma,
      { amount: 100, method: "CHECK" },
      row({ reference: "B", amount: 50 }),
    ).catch((e) => e);
    expect(err?.getStatus?.()).toBe(503);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(guardInputs).toHaveLength(0);
  });

  it("a double-clicked Save whose first save landed needs no check under the lock: no 503", async () => {
    // pre-read: stored X1/$50 -> the edit to NEW/$100 locks CHECK:NEW; the first save then landed (row = NEW/$100)
    const prisma = fake(row({ reference: "X1", amount: 50 }));
    const dto = { amount: 100, method: "CHECK", reference: "NEW" };
    await expect(run(prisma, dto, row({ reference: "NEW", amount: 100 }))).resolves.toBeNull();
    expect(guardInputs).toHaveLength(0);
  });
});

describe("NIT 2 + SA-865: a grouped row's guard inputs", () => {
  const grouped = (over: Partial<Row> = {}) =>
    row({ paymentGroupId: "g-1", reference: "R9", amount: 30, ...over });
  const txFor = (
    siblings: Array<{ id: string; amount: number }>,
    advances: Array<Record<string, unknown>>,
  ) => {
    // one payment date for the group; the advances are unlinked (legacy) at that date, so the date rule finds them
    const at = new Date("2026-10-01T12:00:00Z");
    return {
      invoicePayment: {
        findMany: jest.fn(async () => siblings.map((r) => ({ ...r, paidAt: at }))),
      },
      advancePayment: {
        findMany: jest.fn(async () =>
          advances.map((a) => ({ method: "CHECK", receivedAt: at, sourcePaymentId: null, ...a })),
        ),
      },
    };
  };

  it("seeds the row id and its group's excess advance (same method, normalised reference, receivedAt = paidAt)", async () => {
    const prisma = fake(
      grouped(),
      txFor(
        [
          { id: "pay-b", amount: 30 },
          { id: "pay-a", amount: 60 },
        ],
        [
          { id: "adv-own", amount: 10, reference: "r-9" },
          { id: "adv-other", amount: 10, reference: "Z1" },
        ],
      ),
    );
    await run(prisma, { amount: 31, method: "CHECK", reference: "R9" }, grouped());
    expect(guardInputs).toHaveLength(1);
    const attempt: Set<string> = guardInputs[0].opts.paymentAttempt.ids;
    expect([...attempt].sort()).toEqual(["adv-own", "pay-b"]);
    expect(guardInputs[0].opts.paymentGroupId).toBe("g-1");
  });

  it("SA-865: the guard's amount is the group's NEW total (siblings + the edited row's new amount + its advance)", async () => {
    const prisma = fake(
      grouped(),
      txFor(
        [
          { id: "pay-b", amount: 30 },
          { id: "pay-a", amount: 60 },
        ],
        [{ id: "adv-own", amount: 10, reference: "R9" }],
      ),
    );
    await run(prisma, { amount: 40, method: "CHECK", reference: "R9" }, grouped());
    expect(guardInputs[0].amount).toBe(110); // 60 + 40 + 10
  });

  it("an ungrouped row keeps its own amount", async () => {
    const prisma = fake(row());
    await run(prisma, { amount: 100, method: "CHECK", reference: "NEW" }, row());
    expect(guardInputs[0].amount).toBe(100);
  });
});
