import { ConflictException } from "@nestjs/common";
import { assertWithinCreditLimit, isCreditLimitCheckEnabled } from "./credit-limit-guard";

/**
 * B585 prefactor — characterization of the credit-limit guard AFTER it moved out of OrdersService
 * (behaviour identical). The service-level behaviour (updateOrderItems / change-request paths, the
 * exposure basis) stays pinned by `orders.credit-limit-exposure.spec.ts` and the WP3 block in
 * `orders.service.spec.ts`; this file pins the two extracted functions directly.
 */

describe("isCreditLimitCheckEnabled (WP3 plan-flag gate)", () => {
  const original = process.env.PLAN_FLAG_ENFORCEMENT;
  afterEach(() => {
    if (original === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = original;
  });

  const deps = (over: { tenantId?: string | null; hasFlag?: jest.Mock } = {}) => ({
    prisma: {
      getTenantId: jest.fn().mockReturnValue(over.tenantId === undefined ? "t-1" : over.tenantId),
    },
    entitlements: { hasFlag: over.hasFlag ?? jest.fn().mockResolvedValue(true) },
    logger: { error: jest.fn() },
  });

  it("kill switch off (the default): the check ALWAYS runs and entitlements are never consulted", async () => {
    delete process.env.PLAN_FLAG_ENFORCEMENT;
    const d = deps();
    await expect(isCreditLimitCheckEnabled(d as any)).resolves.toBe(true);
    expect(d.entitlements.hasFlag).not.toHaveBeenCalled();

    for (const value of ["off", "garbage"]) {
      process.env.PLAN_FLAG_ENFORCEMENT = value;
      const each = deps();
      await expect(isCreditLimitCheckEnabled(each as any)).resolves.toBe(true);
      expect(each.entitlements.hasFlag).not.toHaveBeenCalled(); // not consulted-then-ignored
    }
  });

  it("enforcement on, no tenant context: the check runs", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const d = deps({ tenantId: null });
    await expect(isCreditLimitCheckEnabled(d as any)).resolves.toBe(true);
    expect(d.entitlements.hasFlag).not.toHaveBeenCalled();
  });

  it("enforcement on: follows flag.credit_limits for the tenant", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const granted = deps({ hasFlag: jest.fn().mockResolvedValue(true) });
    const denied = deps({ hasFlag: jest.fn().mockResolvedValue(false) });

    await expect(isCreditLimitCheckEnabled(granted as any)).resolves.toBe(true);
    await expect(isCreditLimitCheckEnabled(denied as any)).resolves.toBe(false);
    expect(denied.entitlements.hasFlag).toHaveBeenCalledWith("t-1", "flag.credit_limits");
  });

  it("enforcement on and entitlement resolution FAILS: degrades to the guard staying ON, and logs", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const d = deps({ hasFlag: jest.fn().mockRejectedValue(new Error("catalog down")) });
    await expect(isCreditLimitCheckEnabled(d as any)).resolves.toBe(true);
    expect(d.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("running the credit check (legacy)"),
      expect.any(Error),
    );
  });
});

describe("assertWithinCreditLimit (the hard block)", () => {
  const makeDb = (
    over: {
      creditLimit?: unknown;
      customer?: unknown;
      invoices?: unknown[];
      orders?: unknown[];
    } = {},
  ) => ({
    customer: {
      findFirst: jest.fn().mockResolvedValue(
        // `in`, not `??`: an explicit `creditLimit: null` must stay null (no limit), not become 100
        "customer" in over
          ? over.customer
          : { creditLimit: "creditLimit" in over ? over.creditLimit : 100 },
      ),
    },
    invoice: { findMany: jest.fn().mockResolvedValue("invoices" in over ? over.invoices : []) },
    order: { findMany: jest.fn().mockResolvedValue("orders" in over ? over.orders : []) },
  });
  const sent = (total: number, orderId: string | null = null) => ({
    total,
    status: "SENT",
    orderId,
    order: null,
    payments: [],
  });

  it("disabled by the plan flag: resolves and touches NOTHING", async () => {
    const db = makeDb();
    await expect(
      assertWithinCreditLimit(db, "c-1", "o-1", 1_000_000, false),
    ).resolves.toBeUndefined();
    expect(db.customer.findFirst).not.toHaveBeenCalled();
    expect(db.invoice.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["no limit configured (null)", { creditLimit: null }],
    ["customer row not found", { customer: null }],
  ])("%s: no check — and no exposure read", async (_label, over) => {
    const db = makeDb(over);
    await expect(
      assertWithinCreditLimit(db, "c-1", "o-1", 1_000_000, true),
    ).resolves.toBeUndefined();
    expect(db.customer.findFirst).toHaveBeenCalledTimes(1); // the limit WAS looked up
    expect(db.invoice.findMany).not.toHaveBeenCalled();
    expect(db.order.findMany).not.toHaveBeenCalled();
  });

  it("reads the limit for THIS customer and exposure through the shared reader, excluding the edited order", async () => {
    const db = makeDb({
      invoices: [sent(40), sent(900, "o-1")], // o-1's own invoice is excluded
    });
    await assertWithinCreditLimit(db, "c-1", "o-1", 10, true);

    expect(db.customer.findFirst).toHaveBeenCalledWith({
      where: { id: "c-1" },
      select: { creditLimit: true },
    });
    expect(db.invoice.findMany.mock.calls[0][0].where.customerId).toBe("c-1");
    expect(db.order.findMany.mock.calls[0][0].where.customerId).toBe("c-1");
  });

  it("the two options are NAMED: invoicesSurviveEdit floors the edited order at its surviving invoices (the default caps it at the projected total) and `action` words the 409", async () => {
    const paid = {
      total: 1000,
      status: "PAID",
      orderId: "o-1",
      order: null,
      payments: [{ amount: 1000, status: "PAID" }],
    };
    const owing = { total: 1000, status: "OVERDUE", orderId: "o-1", order: null, payments: [] };
    const at = (creditLimit: number, projected: number, opts?: object) =>
      assertWithinCreditLimit(
        makeDb({ creditLimit, invoices: [paid, owing] }),
        "c-1",
        "o-1",
        projected,
        true,
        opts,
      );
    await expect(at(999, 1050, { invoicesSurviveEdit: true })).rejects.toMatchObject({
      response: { exposure: 1000 }, // the surviving OVERDUE batch, not the netted 50
    });
    await expect(at(600, 600)).resolves.toBeUndefined(); // default: never stricter than before
    await expect(at(600, 600, { invoicesSurviveEdit: true })).rejects.toMatchObject({
      response: { exposure: 1000, limit: 600 },
    });
    await expect(at(10, 11, { action: "delivery" })).rejects.toMatchObject({
      response: { message: expect.stringContaining("This delivery would") },
    });
  });

  it("passes at or under the limit (the block is strictly exposure > limit)", async () => {
    const db = makeDb({ creditLimit: 100, invoices: [sent(60)] });
    await expect(assertWithinCreditLimit(db, "c-1", "o-1", 40, true)).resolves.toBeUndefined(); // 100 = limit
    await expect(assertWithinCreditLimit(db, "c-1", "o-1", 39.99, true)).resolves.toBeUndefined();
  });

  it("over the limit: 409 CREDIT_LIMIT_EXCEEDED with the unchanged body", async () => {
    const db = makeDb({ creditLimit: 100, invoices: [sent(60)] });
    const attempt = assertWithinCreditLimit(db, "c-1", "o-1", 40.01, true);

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    const error = (await attempt.catch((e: unknown) => e)) as ConflictException;
    // the WHOLE body, exactly: an added or renamed field is a contract change
    expect(error.getResponse()).toEqual({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        "This edit would take the customer's exposure to 100.01, over their credit limit of 100.00.",
      limit: 100,
      exposure: 100.01,
    });
  });

  it("float dust in the sum never flips the verdict (roundMoney before the comparison)", async () => {
    const db = makeDb({ creditLimit: 0.3, invoices: [sent(0.1)] });
    await expect(assertWithinCreditLimit(db, "c-1", "o-1", 0.2, true)).resolves.toBeUndefined();
  });

  describe("an action that adds nothing owed is not judged against the limit (exposure 120, limit 100)", () => {
    const over = () => makeDb({ creditLimit: 100, invoices: [sent(120)] });

    it("projected 0 passes", async () => {
      await expect(assertWithinCreditLimit(over(), "c-1", null, 0, true)).resolves.toBeUndefined();
    });

    it("projected 0.01 is still 409 (the comparison itself is unchanged)", async () => {
      await expect(assertWithinCreditLimit(over(), "c-1", null, 0.01, true)).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", exposure: 120.01 },
      });
    });

    it("a negative projected total passes", async () => {
      await expect(assertWithinCreditLimit(over(), "c-1", null, -5, true)).resolves.toBeUndefined();
    });

    it("an over-limit customer's positive edit is still 409", async () => {
      await expect(assertWithinCreditLimit(over(), "c-1", "o-1", 15, true)).rejects.toMatchObject({
        response: { code: "CREDIT_LIMIT_EXCEEDED", exposure: 135 },
      });
    });

    it("a prepaid edit (total > 0, already paid >= total) passes", async () => {
      const db = makeDb({
        creditLimit: 100,
        invoices: [
          sent(120),
          {
            total: 50,
            status: "PAID",
            orderId: "o-1",
            order: null,
            payments: [{ amount: 50, status: "PAID" }],
          },
        ],
      });
      await expect(assertWithinCreditLimit(db, "c-1", "o-1", 50, true)).resolves.toBeUndefined();
    });
  });
});
