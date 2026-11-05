/**
 * SA-1101 A-6 Part 2 (B1279), row RO-39: the customer-scoped returns lock key has ONE definition.
 * `returnCustomerLockKey(c, t)` equals the old `idempotency.hashFor(c, t, "returns.customer")` for sample inputs, and the
 * scope literal appears in `return-customer-lock.ts` only (the three lock sites and the live-return guard derive through
 * it). A second literal is a second key, which silently stops two of them excluding each other.
 */
import fs from "node:fs";
import path from "node:path";
import { IdempotencyService } from "../common/idempotency.service";
import { lockReturnCustomersOf, returnCustomerLockKey } from "./return-customer-lock";

const SRC = path.join(__dirname, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(path.join(dir, e.name));
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)
      ? [path.join(dir, e.name)]
      : [];
  });
}

describe("RO-39: returnCustomerLockKey is the one key", () => {
  const idem = new IdempotencyService();
  const samples: [string, string | null][] = [
    ["cust-1", "tenant-1"],
    ["cust-1", "tenant-2"],
    ["cust-2", "tenant-1"],
    ["cust-3", null],
  ];

  it("equals the old hashFor(customerId, tenantId, 'returns.customer') for sample inputs", () => {
    for (const [c, t] of samples) {
      expect(returnCustomerLockKey(c, t)).toBe(idem.hashFor(c, t, "returns.customer"));
    }
  });

  it("separates customers and tenants", () => {
    const keys = samples.map(([c, t]) => returnCustomerLockKey(c, t));
    expect(new Set(keys).size).toBe(samples.length);
  });

  it("derives through an injected keys service when given one (the lock sites keep their fakes)", () => {
    const keys = { hashFor: jest.fn(() => "fake") };
    expect(returnCustomerLockKey("c", "t", keys)).toBe("fake");
    expect(keys.hashFor).toHaveBeenCalledWith("c", "t", "returns.customer");
  });

  it('the scope literal "returns.customer" appears in return-customer-lock.ts only (grep census)', () => {
    const holders = walk(SRC)
      .filter((f) => {
        const code = fs
          .readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        return /["'`]returns\.customer["'`]/.test(code);
      })
      .map((f) => path.relative(SRC, f).replace(/\\/g, "/"))
      .sort();
    expect(holders).toEqual(["returns/return-customer-lock.ts"]);
  });
});

describe("lockReturnCustomersOf", () => {
  it("locks each distinct customer once, in key order, on the caller's own tx", async () => {
    const taken: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (_q: TemplateStringsArray, ...v: unknown[]) => {
        taken.push(String(v[1]));
      }),
      order: {
        findMany: jest.fn(async () => [
          { customerId: "c2", tenantId: "t1" },
          { customerId: "c1", tenantId: "t1" },
          { customerId: "c2", tenantId: "t1" },
        ]),
      },
    };
    const customers = await lockReturnCustomersOf(tx, ["o1", "o2", "o3"]);
    const expected = ["c1", "c2"].map((c) => returnCustomerLockKey(c, "t1")).sort();
    expect(taken).toEqual(expected);
    expect([...customers].sort()).toEqual(["c1", "c2"]);
  });

  it("takes nothing for no orders", async () => {
    const tx = { $executeRaw: jest.fn(), order: { findMany: jest.fn() } };
    expect(await lockReturnCustomersOf(tx, [])).toEqual([]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
