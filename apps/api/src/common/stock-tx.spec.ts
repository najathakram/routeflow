import * as fs from "fs";
import * as path from "path";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { boundedTenantTx, stockTxBounded } from "./stock-tx";
import { STOCK_TX_OPTIONS } from "./product-locks";

/**
 * SA-855 (row 232): ONE place owns the lock-wait bound. `boundedTenantTx` = `tenantTransaction` with
 * `setStockLockTimeout` as the tx's FIRST statement and the STOCK_TX_OPTIONS budget, a single attempt;
 * `stockTxBounded` = `retryStockTx` around it, unchanged for its callers.
 */
const lockTimeout = () => Object.assign(new Error("lock timeout"), { code: "55P03" });

function fakePrisma(failFirst = 0) {
  const calls: string[] = [];
  const opts: unknown[] = [];
  let attempts = 0;
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      calls.push(strings.join("?"));
      return 1;
    }),
  };
  const prisma = {
    tenantTransaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>, o?: unknown) => {
      attempts += 1;
      opts.push(o);
      const out = await fn(tx);
      if (attempts <= failFirst) throw lockTimeout();
      return out;
    }),
  };
  return { prisma, tx, calls, opts, attempts: () => attempts };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("boundedTenantTx (SA-855)", () => {
  it("REG-232-D: sets lock_timeout as the tx's FIRST statement, then runs the body", async () => {
    const { prisma, tx, calls } = fakePrisma();
    const out = await boundedTenantTx(prisma, async (t) => {
      calls.push("BODY");
      expect(t).toBe(tx);
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls[0]).toMatch(/set_config\('lock_timeout'/);
    expect(calls.indexOf("BODY")).toBe(1);
  });

  it("passes the STOCK_TX_OPTIONS budget, a caller's own options winning", async () => {
    const a = fakePrisma();
    await boundedTenantTx(a.prisma, async () => 1);
    expect(a.opts[0]).toEqual(STOCK_TX_OPTIONS);
    const b = fakePrisma();
    await boundedTenantTx(b.prisma, async () => 1, {
      timeout: 60_000,
      isolationLevel: "Serializable",
    });
    expect(b.opts[0]).toEqual({ timeout: 60_000, isolationLevel: "Serializable" });
  });

  it("is a single attempt: a 55P03 propagates as is (the filter answers it), never retried", async () => {
    const { prisma, attempts } = fakePrisma(1);
    const err = await boundedTenantTx(prisma, async () => 1).catch((e) => e);
    expect(err.code).toBe("55P03");
    expect(attempts()).toBe(1);
  });
});

describe("stockTxBounded after the extraction (REG-232-C)", () => {
  it("still retries a 55P03 and succeeds on the next attempt, each attempt bounded first", async () => {
    const { prisma, calls, attempts } = fakePrisma(1);
    const out = await stockTxBounded(prisma, "test.label", async () => "done");
    expect(out).toBe("done");
    expect(attempts()).toBe(2);
    expect(calls.filter((c) => /set_config\('lock_timeout'/.test(c))).toHaveLength(2);
  });

  it("still gives up after 3 attempts with the coded 503", async () => {
    const { prisma, attempts } = fakePrisma(99);
    const err = await stockTxBounded(prisma, "test.label", async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(attempts()).toBe(3);
  });
});

describe("product create goes through the bound (REG-232-D source pin)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../products/products.service.ts"), "utf8");
  const create = src.slice(src.indexOf("  async create("), src.indexOf("  async update("));

  it("create's one transaction is boundedTenantTx, never a bare tenantTransaction", () => {
    expect(create).toContain("boundedTenantTx(");
    expect(create).not.toContain("this.prisma.tenantTransaction(");
  });

  it("create is a single attempt: it does not use the retrying stockTxBounded", () => {
    expect(create).not.toContain("stockTxBounded(");
  });
});
