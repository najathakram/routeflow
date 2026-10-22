import { ConflictException } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import { assertCreditAtEnforcementPoint } from "./credit-limit-guard";
import { creditProjectedTotal } from "./order-create-options";
import { counterCreditPaidNow } from "./counter-sale/counter-sale-payment";

// S1 (C42): the credit gate at order create counts only what STAYS OWED after this request's tender.
// Limit 100, exposure 90 (one sent invoice), a $50 counter sale. Real gate, mocked db.

const TENANT = "tenant-1";
const CUSTOMER = "cust-1";

const deps = (switchValue: string) => {
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue({ creditLimit: 100 }) },
    invoice: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { total: 90, status: "SENT", orderId: null, order: null, payments: [] },
        ]),
    },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    systemConfig: { findFirst: jest.fn().mockResolvedValue({ value: switchValue }) },
  };
  return {
    prisma: { getTenantId: jest.fn().mockReturnValue(TENANT), forTenant: jest.fn(() => db) },
    entitlements: { hasFlag: jest.fn().mockResolvedValue(true) },
    logger: { error: jest.fn(), warn: jest.fn() },
  };
};

type Pay = { method: "CASH" | "CARD" | "CHECK" | "ON_ACCOUNT"; amount?: number };

/** What create() does for a counter sale: the gate judges creditProjectedTotal(total, options). */
const gate = (d: ReturnType<typeof deps>, payment: Pay, total = 50) =>
  assertCreditAtEnforcementPoint(
    d as never,
    {
      tenantId: TENANT,
      customerId: CUSTOMER,
      projectedTotal: creditProjectedTotal(total, {
        creditPaidNow: (t) => counterCreditPaidNow(payment, t),
      }),
      principal: { role: "OPERATOR" },
    } as never,
  );

const codeOf = async (p: Promise<unknown>) => {
  const e = (await p.catch((x: unknown) => x)) as ConflictException;
  expect(e).toBeInstanceOf(ConflictException);
  return e.getResponse() as { code: string; exposure?: number };
};

describe("S1: the credit gate counts only what stays owed after the tender", () => {
  it("CASH $50 on a $50 sale clears the gate (master: 409 CREDIT_LIMIT_EXCEEDED)", async () => {
    await expect(gate(deps("true"), { method: "CASH", amount: 50 })).resolves.toBeUndefined();
  });

  it("CASH with no amount stated (= the exact balance) clears the gate", async () => {
    await expect(gate(deps("true"), { method: "CASH" })).resolves.toBeUndefined();
  });

  it("CARD $50 clears the gate", async () => {
    await expect(gate(deps("true"), { method: "CARD", amount: 50 })).resolves.toBeUndefined();
  });

  it("ON_ACCOUNT is refused (unchanged): exposure 140", async () => {
    const r = await codeOf(gate(deps("true"), { method: "ON_ACCOUNT" }));
    expect(r.code).toBe("CREDIT_LIMIT_EXCEEDED");
    expect(r.exposure).toBe(140);
  });

  it("a pending CHECK does not lower exposure: refused", async () => {
    const r = await codeOf(gate(deps("true"), { method: "CHECK", amount: 50 }));
    expect(r.exposure).toBe(140);
  });

  it("partial: CASH $20 on a $50 sale, the gate sees $30 (exposure 120)", async () => {
    const r = await codeOf(gate(deps("true"), { method: "CASH", amount: 20 }));
    expect(r.exposure).toBe(120);
  });

  it("partial that fits: CASH $40 on a $50 sale leaves $10 owed (exposure 100, not over)", async () => {
    await expect(gate(deps("true"), { method: "CASH", amount: 40 })).resolves.toBeUndefined();
  });

  it("cash with change (paid $100 on $50) is capped at the total: never a negative projection", async () => {
    expect(
      creditProjectedTotal(50, {
        creditPaidNow: (t) => counterCreditPaidNow({ method: "CASH", amount: 100 }, t),
      }),
    ).toBe(0);
    await expect(gate(deps("true"), { method: "CASH", amount: 100 })).resolves.toBeUndefined();
  });

  it("a CARD stated over the total takes no money (the planner refuses it): the gate keeps the whole total", async () => {
    const r = await codeOf(gate(deps("true"), { method: "CARD", amount: 80 }));
    expect(r.exposure).toBe(140);
  });

  it("DARK with the CASH case logs no would-deny line (master logs one)", async () => {
    const d = deps("dark");
    await gate(d, { method: "CASH", amount: 50 });
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("DARK with ON_ACCOUNT still logs the would-deny line", async () => {
    const d = deps("dark");
    await gate(d, { method: "ON_ACCOUNT" });
    expect(d.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("creditProjectedTotal", () => {
  it("no creditPaidNow (every non-counter caller) = the whole total", () => {
    expect(creditProjectedTotal(50, {})).toBe(50);
  });
  it("rounds in cents", () => {
    expect(creditProjectedTotal(50.1, { creditPaidNow: () => 0.2 })).toBe(49.9);
  });
  it("clamps a garbage figure into [0, total]: it can never loosen past the total or tighten above it", () => {
    for (const bad of [NaN, Infinity, -5]) {
      expect(creditProjectedTotal(50, { creditPaidNow: () => bad })).toBe(50);
    }
    expect(creditProjectedTotal(50, { creditPaidNow: () => 80 })).toBe(0);
  });
});

describe("S1 wiring pins", () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");
  it("create() hands the B585 gate creditProjectedTotal(total, options), not the bare total", () => {
    expect(src("orders.service.ts")).toMatch(
      /projectedTotal:\s*creditProjectedTotal\(total,\s*options\)/,
    );
  });
  it("only the counter sale sets creditPaidNow", () => {
    const hits = ["counter-sale/counter-sale.service.ts", "orders.controller.ts"].map((f) =>
      /creditPaidNow/.test(src(f)),
    );
    expect(hits).toEqual([true, false]);
  });
});
