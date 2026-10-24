/**
 * SA-733 D8: ONE lock module for every writer of a tenant's Stripe price - one family constant, one
 * timeout -> HTTP mapping, a long wait for admin / cron and a short one for the tenant-facing upgrade.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: (...a: unknown[]) => mockWithAdvisoryLock(...a),
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

import * as fs from "fs";
import * as path from "path";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import {
  lockTenantPrice,
  TENANT_PRICE_LOCK_FAMILY,
  TENANT_PRICE_LOCK_SELF_SERVE_WAIT_MS,
  TENANT_PRICE_LOCK_WAIT_MS,
  underTenantPriceLock,
} from "./price-lock";

const { LockTimeoutError, LockUnavailableError } = jest.requireMock("../common/db-locks");

beforeEach(() => mockWithAdvisoryLock.mockReset());

describe("underTenantPriceLock", () => {
  it("takes the tenant-price family keyed on the tenant, in wait mode, with the long admin wait by default", async () => {
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    }));
    await expect(underTenantPriceLock("t1", async () => 7)).resolves.toBe(7);
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      { family: "tenant-price", key: "t1", mode: "wait", waitMs: 20_000 },
      expect.any(Function),
    );
    expect(TENANT_PRICE_LOCK_FAMILY).toBe("tenant-price");
    expect(TENANT_PRICE_LOCK_WAIT_MS).toBe(20_000);
  });

  it("the self-serve wait is short (a double-click burst must not pin the small pool)", () => {
    expect(TENANT_PRICE_LOCK_SELF_SERVE_WAIT_MS).toBeGreaterThanOrEqual(2_000);
    expect(TENANT_PRICE_LOCK_SELF_SERVE_WAIT_MS).toBeLessThanOrEqual(3_000);
  });

  it("a timeout is a coded retryable 409 CONCURRENT_UPDATE; the caller's copy replaces the admin default", async () => {
    mockWithAdvisoryLock.mockRejectedValue(new LockTimeoutError());
    const dflt: any = await underTenantPriceLock("t1", async () => 1).catch((e) => e);
    expect(dflt).toBeInstanceOf(ConflictException);
    expect(dflt.getResponse()).toMatchObject({ code: "CONCURRENT_UPDATE" });

    const safe: any = await underTenantPriceLock("t1", async () => 1, {
      waitMs: 2_500,
      busyMessage: "Your plan is already being changed.",
    }).catch((e) => e);
    expect(safe.getResponse()).toEqual({
      code: "CONCURRENT_UPDATE",
      message: "Your plan is already being changed.",
    });
    expect(mockWithAdvisoryLock.mock.calls[1][0].waitMs).toBe(2_500);
  });

  it("a lock that cannot be taken at all is a 503 LOCK_UNAVAILABLE", async () => {
    mockWithAdvisoryLock.mockRejectedValue(new LockUnavailableError());
    const e: any = await underTenantPriceLock("t1", async () => 1).catch((x) => x);
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
  });

  it("an error from the body passes through untouched", async () => {
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => ({
      acquired: true,
      value: await fn(),
    }));
    await expect(
      underTenantPriceLock("t1", async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
  });
});

describe("lockTenantPrice (acquire / release)", () => {
  it("holds the lock until released, on the same family and key", async () => {
    let bodyFinished = false;
    mockWithAdvisoryLock.mockImplementation(async (_o: unknown, fn: () => Promise<unknown>) => {
      const value = await fn();
      bodyFinished = true;
      return { acquired: true, value };
    });
    const unlock = await lockTenantPrice("t9");
    expect(mockWithAdvisoryLock.mock.calls[0][0]).toEqual({
      family: "tenant-price",
      key: "t9",
      mode: "wait",
      waitMs: 20_000,
    });
    expect(bodyFinished).toBe(false); // still held
    await unlock();
    expect(bodyFinished).toBe(true);
  });

  it("a timeout is the same coded 409 as underTenantPriceLock", async () => {
    mockWithAdvisoryLock.mockRejectedValue(new LockTimeoutError());
    const e: any = await lockTenantPrice("t1").catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse().code).toBe("CONCURRENT_UPDATE");
  });
});

describe("one lock module (source pin)", () => {
  it("the family literal lives in price-lock.ts alone - every other file imports the constant", () => {
    const SRC = path.resolve(__dirname, "..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(full);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) {
          const rel = path.relative(SRC, full).split(path.sep).join("/");
          if (/["']tenant-price["']/.test(fs.readFileSync(full, "utf8"))) hits.push(rel);
        }
      }
    };
    walk(SRC);
    // db-locks.ts owns the closed family list and its pool size; price-lock.ts owns the constant.
    expect(hits.sort()).toEqual(["billing/price-lock.ts", "common/db-locks.ts"]);
  });

  it("the old second module is gone", () => {
    expect(fs.existsSync(path.join(__dirname, "tenant-price-lock.ts"))).toBe(false);
  });
});
