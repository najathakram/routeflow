import * as fs from "node:fs";
import * as path from "node:path";
import { Prisma, UserRole } from "@prisma/client";
import { decrementStockForSale, settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * SA-606c lock-order pin: the oversell policy is read BEFORE any `FOR UPDATE`; the locked stock
 * section only receives the resolved boolean. A policy read under product row locks would hold
 * them across an extra query and can deadlock against the policy write lock.
 */

describe("order-stock.ts is policy-free (structural)", () => {
  const src = fs.readFileSync(path.join(__dirname, "order-stock.ts"), "utf8");
  // strip comments so prose mentioning the policy does not trip the scan
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports no policy module, PolicyService or oversell reader", () => {
    expect(code).not.toMatch(/from\s+["'][^"']*policy[^"']*["']/i);
    expect(code).not.toMatch(/\bPolicyService\b|\bPolicyOversellReader\b|OversellPolicyReader/);
  });

  it("references no policy read", () => {
    expect(code).not.toMatch(/policyValue|policies\s*\.\s*resolve|policy\s*\.\s*resolve/i);
  });
});

const D = (n: number) => new Prisma.Decimal(n);
const deps: OrderStockDeps = { logger: { warn: jest.fn() }, tenantId: "t-1" };

/** A fake tx that records ANY policy access (delegate or raw SQL naming PolicyValue). */
function spyTx(stock: number) {
  let locked = false;
  const policyAccesses: string[] = [];
  const mentionsPolicy = (v: unknown) => JSON.stringify(v ?? "").includes("PolicyValue");
  const tx: any = {
    $executeRaw: jest.fn(async (s: TemplateStringsArray) => {
      const text = s.join("?");
      if (mentionsPolicy(text)) policyAccesses.push("executeRaw");
      if (/FOR UPDATE/.test(text)) locked = true;
      return 0;
    }),
    $queryRaw: jest.fn(async (s: TemplateStringsArray, ...values: unknown[]) => {
      if (mentionsPolicy(s.join("?")) || mentionsPolicy(values)) policyAccesses.push("queryRaw");
      return [{ id: "p", currentStock: D(stock) }];
    }),
    product: {
      findMany: jest.fn(async () => [
        { id: "p", name: "P", unit: "ea", currentStock: D(stock), unitsPerBox: null },
      ]),
      findFirst: jest.fn(async () => ({
        costingMethod: "AVCO",
        averageCost: D(1),
        standardCost: null,
      })),
      update: jest.fn(async () => ({ id: "p", currentStock: D(stock) })),
    },
    stockLot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { create: jest.fn(async () => ({ id: "m" })) },
  };
  Object.defineProperty(tx, "policyValue", {
    get() {
      policyAccesses.push("policyValue delegate");
      return {};
    },
  });
  return { tx, policyAccesses, wasLocked: () => locked };
}

describe("stock paths issue zero policy queries (behavioural)", () => {
  it("decrementStockForSale", async () => {
    const { tx, policyAccesses, wasLocked } = spyTx(10);
    await decrementStockForSale(deps, tx, [{ productId: "p", qty: 3 }], false, {
      orderId: "o-1",
      notes: "CREATE",
      performedById: "u-1",
    });
    expect(wasLocked()).toBe(true);
    expect(policyAccesses).toEqual([]);
  });

  it("settleStockForEdit", async () => {
    const { tx, policyAccesses, wasLocked } = spyTx(10);
    const line = (qty: number) => ({
      productId: "p",
      qty,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
    });
    await settleStockForEdit(deps, tx, { id: "o-1", status: "PENDING" }, [line(1)], [line(4)], {
      role: UserRole.CUSTOMER,
    } as any);
    expect(wasLocked()).toBe(true);
    expect(policyAccesses).toEqual([]);
  });
});
