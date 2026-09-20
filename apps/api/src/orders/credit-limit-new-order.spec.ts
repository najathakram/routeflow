import { ConflictException } from "@nestjs/common";
import {
  assertCreditAtEnforcementPoint,
  CREDIT_LIMIT_ENFORCE_KEY,
  creditEnforcementMode,
} from "./credit-limit-guard";

// B585 — the credit check for a NEW order behind the per-tenant DARK/ENFORCED switch.

const TENANT = "tenant-1";
const CUSTOMER = "cust-1";

const makeDeps = (
  over: {
    creditLimit?: number | null;
    switchValue?: string | null;
    invoices?: unknown[];
    orders?: unknown[];
    switchError?: Error;
  } = {},
) => {
  const db = {
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ creditLimit: "creditLimit" in over ? over.creditLimit : 100 }),
    },
    invoice: { findMany: jest.fn().mockResolvedValue(over.invoices ?? []) },
    order: { findMany: jest.fn().mockResolvedValue(over.orders ?? []) },
    systemConfig: {
      findFirst: over.switchError
        ? jest.fn().mockRejectedValue(over.switchError)
        : jest
            .fn()
            .mockResolvedValue(
              over.switchValue === undefined || over.switchValue === null
                ? null
                : { value: over.switchValue },
            ),
    },
  };
  return {
    db,
    prisma: { getTenantId: jest.fn().mockReturnValue(TENANT), forTenant: jest.fn(() => db) },
    entitlements: { hasFlag: jest.fn().mockResolvedValue(true) },
    logger: { error: jest.fn(), warn: jest.fn() },
  };
};
const sent = (total: number) => ({
  total,
  status: "SENT",
  orderId: null,
  order: null,
  payments: [],
});

describe("creditEnforcementMode (the per-tenant switch)", () => {
  it("absent = DARK; ONLY the exact value 'true' ENFORCES — never TRUE / ' true ' / True", async () => {
    const modes = await Promise.all(
      [null, "true", " TRUE ", "True", " true ", "false", "FALSE", "yes", "1", "", "enforce"].map(
        (v) => creditEnforcementMode(makeDeps({ switchValue: v }).prisma as never, TENANT),
      ),
    );
    expect(modes).toEqual([
      "DARK",
      "ENFORCED",
      "DARK",
      "DARK",
      "DARK",
      "DARK",
      "DARK",
      "DARK",
      "DARK",
      "DARK",
      "DARK",
    ]);
  });

  it("the read carries an EXPLICIT tenantId and the key (L-124: cron has no ambient tenant)", async () => {
    const d = makeDeps();
    await creditEnforcementMode(d.prisma as never, TENANT);
    expect(d.db.systemConfig.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, key: CREDIT_LIMIT_ENFORCE_KEY },
      select: { value: true },
    });
  });

  it("refuses a tenant that disagrees with the ambient one (the explicit id is not spread-overridden)", async () => {
    const d = makeDeps();
    await expect(creditEnforcementMode(d.prisma as never, "other-tenant")).rejects.toThrow();
    expect(d.db.systemConfig.findFirst).not.toHaveBeenCalled();
  });

  it("a DB error propagates from the read itself (the enforcement point decides what it means)", async () => {
    const d = makeDeps({ switchError: new Error("db down") });
    await expect(creditEnforcementMode(d.prisma as never, TENANT)).rejects.toThrow("db down");
  });
});

describe("assertCreditAtEnforcementPoint", () => {
  const run = (
    d: ReturnType<typeof makeDeps>,
    projectedTotal: number,
    tenantId = TENANT as string | null,
  ) =>
    assertCreditAtEnforcementPoint(d as never, { tenantId, customerId: CUSTOMER, projectedTotal });

  it("within the limit: resolves and the switch is never read (lazy)", async () => {
    const d = makeDeps({ creditLimit: 100, invoices: [sent(60)] });
    await expect(run(d, 40)).resolves.toBeUndefined(); // 100 = limit, not over
    expect(d.db.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("no credit limit configured: resolves without reading exposure", async () => {
    const d = makeDeps({ creditLimit: null });
    await expect(run(d, 1_000_000)).resolves.toBeUndefined();
    expect(d.db.invoice.findMany).not.toHaveBeenCalled();
  });

  it("DARK (switch absent): an over-limit order is ALLOWED and exactly one would-deny line is logged (ids + figures only)", async () => {
    const d = makeDeps({ creditLimit: 100, invoices: [sent(60)] });
    await expect(run(d, 40.01)).resolves.toBeUndefined();

    expect(d.logger.warn).toHaveBeenCalledTimes(1);
    const line = d.logger.warn.mock.calls[0][0] as string;
    expect(line).toContain("would DENY a new order (dark)");
    expect(line).toContain(`tenant=${TENANT}`);
    expect(line).toContain(`customer=${CUSTOMER}`);
    expect(line).toContain("exposure=100.01");
    expect(line).toContain("limit=100");
  });

  it("ENFORCED ('true'): the same order is refused with the 409 body — and nothing is logged as dark", async () => {
    const d = makeDeps({ creditLimit: 100, invoices: [sent(60)], switchValue: "true" });
    const attempt = run(d, 40.01);

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    const error = (await attempt.catch((e: unknown) => e)) as ConflictException;
    expect(error.getResponse()).toEqual({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        "This order would take the customer's exposure to 100.01, over their credit limit of 100.00.",
      limit: 100,
      exposure: 100.01,
    });
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("no tenant on the caller: DARK, and no switch read is attempted", async () => {
    const d = makeDeps({ creditLimit: 10, switchValue: "true" });
    await expect(run(d, 11, null)).resolves.toBeUndefined();
    expect(d.db.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(d.logger.warn.mock.calls[0][0]).toContain("tenant=none");
  });

  it("a new order excludes NOTHING: every existing invoice counts, including one that carries an order id", async () => {
    const d = makeDeps({
      creditLimit: 100,
      invoices: [
        { ...sent(90), orderId: "o-1", order: { id: "o-1", status: "CONFIRMED", total: 90 } },
      ],
      orders: [{ id: "o-1", total: 90 }],
    });
    await expect(run(d, 11)).resolves.toBeUndefined();
    expect(d.logger.warn).toHaveBeenCalledTimes(1); // 90 + 11 = 101 > 100
  });

  it("the plan-flag gate still applies: flag.credit_limits off means NO check and NO reads at all", async () => {
    const original = process.env.PLAN_FLAG_ENFORCEMENT;
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    try {
      const d = makeDeps({ creditLimit: 1, switchValue: "true" });
      d.entitlements.hasFlag.mockResolvedValue(false);
      await expect(run(d, 1_000_000)).resolves.toBeUndefined();
      expect(d.db.customer.findFirst).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = original;
    }
  });

  it("DARK never breaks a create: a failure to reach a verdict, or an unreadable switch, logs ERROR and ALLOWS", async () => {
    const noVerdict = makeDeps({ creditLimit: 100, switchValue: null });
    noVerdict.db.invoice.findMany.mockRejectedValue(new Error("invoice read failed"));
    await expect(run(noVerdict, 1)).resolves.toBeUndefined();
    expect(noVerdict.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("credit check unavailable, allowing (dark)"),
      expect.any(Error),
    );

    const noSwitch = makeDeps({ creditLimit: 10, switchError: new Error("config down") });
    await expect(run(noSwitch, 11)).resolves.toBeUndefined(); // would-deny AND an unreadable switch
    expect(noSwitch.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("switch unreadable (treated as dark)"),
      expect.any(Error),
    );
  });

  it("ENFORCED: a failure to reach a verdict propagates (a tenant that opted in never gets a silent allow)", async () => {
    const d = makeDeps({ creditLimit: 100, switchValue: "true" });
    d.db.invoice.findMany.mockRejectedValue(new Error("invoice read failed"));
    await expect(run(d, 1)).rejects.toThrow("invoice read failed");
    expect(d.logger.error).not.toHaveBeenCalled();
  });
});
