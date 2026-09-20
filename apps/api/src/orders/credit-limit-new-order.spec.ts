import { ConflictException } from "@nestjs/common";
import {
  assertCreditAtEnforcementPoint,
  CREDIT_LIMIT_DELIVERY_ENFORCE_KEY,
  CREDIT_LIMIT_ENFORCE_KEY,
  creditEnforcementMode,
} from "./credit-limit-guard";

// B585 — the credit check for a NEW order behind the per-tenant OFF / DARK / ENFORCED switch.

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
  it("absent = OFF; exactly 'dark' OBSERVES and exactly 'true' ENFORCES — never TRUE / ' true ' / Dark", async () => {
    const values = [
      null,
      "true",
      "dark",
      " TRUE ",
      "True",
      " true ",
      "Dark",
      "DARK",
      "false",
      "1",
      "",
    ];
    const modes = await Promise.all(
      values.map((v) =>
        creditEnforcementMode(makeDeps({ switchValue: v }).prisma as never, TENANT),
      ),
    );
    expect(modes).toEqual([
      "OFF",
      "ENFORCED",
      "DARK",
      "OFF",
      "OFF",
      "OFF",
      "OFF",
      "OFF",
      "OFF",
      "OFF",
      "OFF",
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

  it("each point reads ITS OWN key and there is no fallback: create ignores enforce_delivery, delivery ignores enforce_new_orders", async () => {
    const onlyKey = (key: string) => {
      const d = makeDeps();
      d.db.systemConfig.findFirst.mockImplementation(
        async ({ where }: { where: { key: string } }) =>
          where.key === key ? { value: "true" } : null,
      );
      return d.prisma as never;
    };
    const mode = (key: string, action?: "order" | "delivery") =>
      creditEnforcementMode(onlyKey(key), TENANT, action);
    expect(await mode(CREDIT_LIMIT_ENFORCE_KEY)).toBe("ENFORCED");
    expect(await mode(CREDIT_LIMIT_ENFORCE_KEY, "delivery")).toBe("OFF");
    expect(await mode(CREDIT_LIMIT_DELIVERY_ENFORCE_KEY, "delivery")).toBe("ENFORCED");
    expect(await mode(CREDIT_LIMIT_DELIVERY_ENFORCE_KEY)).toBe("OFF");
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
    principal: { role: string } | null = { role: "OPERATOR" },
  ) =>
    assertCreditAtEnforcementPoint(d as never, {
      tenantId,
      customerId: CUSTOMER,
      projectedTotal,
      principal,
    });

  it("OFF (switch absent) is FREE: one switch read and NOTHING else — no entitlement, customer or exposure read", async () => {
    const d = makeDeps({ creditLimit: 100, invoices: [sent(60)] });
    await expect(run(d, 1_000_000)).resolves.toBeUndefined();
    expect(d.db.systemConfig.findFirst).toHaveBeenCalledTimes(1);
    expect(d.entitlements.hasFlag).not.toHaveBeenCalled();
    expect(d.db.customer.findFirst).not.toHaveBeenCalled();
    expect(d.db.invoice.findMany).not.toHaveBeenCalled();
    expect(d.db.order.findMany).not.toHaveBeenCalled();
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("within the limit (observing): resolves, nothing logged", async () => {
    const d = makeDeps({ creditLimit: 100, invoices: [sent(60)], switchValue: "dark" });
    await expect(run(d, 40)).resolves.toBeUndefined(); // 100 = limit, not over
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("no credit limit configured: resolves without reading exposure", async () => {
    const d = makeDeps({ creditLimit: null, switchValue: "dark" });
    await expect(run(d, 1_000_000)).resolves.toBeUndefined();
    expect(d.db.invoice.findMany).not.toHaveBeenCalled();
  });

  it("DARK ('dark'): an over-limit order is ALLOWED and exactly one would-deny line is logged (ids + figures only)", async () => {
    const d = makeDeps({ creditLimit: 100, invoices: [sent(60)], switchValue: "dark" });
    await expect(run(d, 40.01)).resolves.toBeUndefined();

    expect(d.logger.warn).toHaveBeenCalledTimes(1);
    const line = d.logger.warn.mock.calls[0][0] as string;
    expect(line).toContain("would DENY a new order (dark)");
    expect(line).toContain(`tenant=${TENANT}`);
    expect(line).toContain(`customer=${CUSTOMER}`);
    expect(line).toContain("exposure=100.01");
    expect(line).toContain("limit=100");
  });

  it("ENFORCED ('true'), STAFF: the same order is refused with the full 409 body — and nothing is logged as dark", async () => {
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

  it.each([
    ["a CUSTOMER", { role: "CUSTOMER" }],
    ["the buyer pseudo-user", { role: "CUSTOMER", type: "BUYER" }],
    ["an unknown role", { role: "SALES_AGENT" }],
    ["no principal at all", null],
  ])(
    "ENFORCED, %s: refused with the code but NO limit and NO exposure (a buyer never sees the figures)",
    async (_who, principal) => {
      const d = makeDeps({ creditLimit: 100, invoices: [sent(60)], switchValue: "true" });
      const error = (await run(d, 40.01, TENANT, principal).catch(
        (e: unknown) => e,
      )) as ConflictException;
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toEqual({
        code: "CREDIT_LIMIT_EXCEEDED",
        message: "This order can't be placed right now. Please contact your account manager.",
      });
    },
  );

  it("no tenant on the caller: OFF, and neither the switch nor anything else is read", async () => {
    const d = makeDeps({ creditLimit: 10, switchValue: "true" });
    await expect(run(d, 11, null)).resolves.toBeUndefined();
    expect(d.db.systemConfig.findFirst).not.toHaveBeenCalled();
    expect(d.db.customer.findFirst).not.toHaveBeenCalled();
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("a new order excludes NOTHING: every existing invoice counts, including one that carries an order id", async () => {
    const d = makeDeps({
      creditLimit: 100,
      switchValue: "dark",
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

  it("DARK never breaks a create: a failure to reach a verdict logs ERROR and ALLOWS; an unreadable switch is OFF with an ERROR", async () => {
    const noVerdict = makeDeps({ creditLimit: 100, switchValue: "dark" });
    noVerdict.db.invoice.findMany.mockRejectedValue(new Error("invoice read failed"));
    await expect(run(noVerdict, 1)).resolves.toBeUndefined();
    expect(noVerdict.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("credit check unavailable, allowing (dark)"),
      expect.any(Error),
    );

    const noSwitch = makeDeps({ creditLimit: 10, switchError: new Error("config down") });
    await expect(run(noSwitch, 11)).resolves.toBeUndefined();
    expect(noSwitch.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("switch unreadable (treated as off)"),
      expect.any(Error),
    );
    expect(noSwitch.db.invoice.findMany).not.toHaveBeenCalled(); // and nothing else ran
  });

  it("ENFORCED: a failure to reach a verdict propagates (a tenant that opted in never gets a silent allow)", async () => {
    const d = makeDeps({ creditLimit: 100, switchValue: "true" });
    d.db.invoice.findMany.mockRejectedValue(new Error("invoice read failed"));
    await expect(run(d, 1)).rejects.toThrow("invoice read failed");
    expect(d.logger.error).not.toHaveBeenCalled();
  });
});
