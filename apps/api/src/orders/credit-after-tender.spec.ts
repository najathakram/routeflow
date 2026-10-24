import {
  CREDIT_LIMIT_DELIVERY_ENFORCE_KEY,
  CREDIT_LIMIT_ENFORCE_KEY,
  creditAfterTender,
} from "./credit-limit-guard";

/**
 * SA-849 rule 1-2 (S1 S-1): the ONE post-tender credit re-check. The gate counted till money (`netted`) that then did not
 * land; the sale is committed, so this never blocks: it re-runs the SAME derivation on live state (only the DB reads are
 * mocked here) and, on a breach, warns (DARK) or warns + writes ONE idempotent audit row + answers the figures (ENFORCED).
 * Red on master: `creditAfterTender` does not exist.
 */
type Mode = "true" | "dark" | null;
function deps(mode: Mode, opts: { limit?: number | null; audited?: boolean; key?: string } = {}) {
  const switchKey = opts.key ?? CREDIT_LIMIT_ENFORCE_KEY; // which switch the tenant has on
  const audits: any[] = opts.audited ? [{ id: "a-1" }] : [];
  const db = {
    systemConfig: {
      findFirst: jest.fn(async ({ where }: any) =>
        where?.key === switchKey && mode ? { value: mode } : null,
      ),
    },
    customer: {
      findFirst: jest.fn(async () => ({ creditLimit: opts.limit === undefined ? 50 : opts.limit })),
    },
    invoice: { findMany: jest.fn(async () => []) },
    order: { findMany: jest.fn(async () => []) },
    auditLog: {
      findFirst: jest.fn(async () => audits[0] ?? null),
      create: jest.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
    },
  };
  // The audit write's transaction: a per-key mutex stands in for pg_advisory_xact_lock (released when the tx ends).
  // SA-877 leaf: the tx exposes ONLY the lock and the audit table, and records every step it takes.
  const held = new Map<string, Promise<void>>();
  const locks: string[] = [];
  const ops: string[] = [];
  const lockFail: { err: Error | null } = { err: null };
  const tenantTransaction = jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
    let release = () => undefined as void;
    ops.push("tx");
    const tx = {
      auditLog: {
        findFirst: (...a: any[]) => (ops.push("findFirst"), (db.auditLog.findFirst as any)(...a)),
        create: (...a: any[]) => (ops.push("create"), (db.auditLog.create as any)(...a)),
      },
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const sql = strings.join("?");
        if (!sql.includes("pg_advisory_xact_lock")) {
          ops.push(sql.includes("lock_timeout") ? "lock_timeout" : `raw:${sql}`);
          return 0;
        }
        ops.push("lock");
        if (lockFail.err) throw lockFail.err;
        const key = `${vals[0]}:${vals[1]}`;
        locks.push(key);
        while (held.has(key)) await held.get(key);
        held.set(key, new Promise<void>((r) => (release = () => (held.delete(key), r()))));
        return 0;
      }),
    };
    try {
      return await fn(tx);
    } finally {
      release();
    }
  });
  return {
    db,
    audits,
    locks,
    ops,
    lockFail,
    tenantTransaction,
    d: {
      prisma: { getTenantId: () => "t-1", forTenant: () => db, tenantTransaction } as any,
      entitlements: { hasFlag: async () => true } as any,
      logger: { warn: jest.fn(), error: jest.fn() },
    },
  };
}
const sale = (over: Record<string, unknown> = {}) => ({
  tenantId: "t-1",
  customerId: "cust-1",
  orderId: "ord-1",
  total: 100, // the $100 sale was let through only because the till was to take it all now
  netted: 100,
  planError: "COUNTER_PAYMENT_NOT_RECORDED",
  actor: "op-1",
  action: "order" as const, // the counter sale's gate
  ...over,
});

describe("creditAfterTender (SA-849)", () => {
  // #3678 review MUST (SA-849 rule 1): the re-check reads the SAME switch as the gate that netted the tender.
  it("a hand-over (action delivery) reads enforce_delivery: ON there alerts, even with enforce_new_orders off (P3a)", async () => {
    const { d, audits } = deps("true", { key: CREDIT_LIMIT_DELIVERY_ENFORCE_KEY });
    expect(await creditAfterTender(d, sale({ action: "delivery" }))).toEqual({
      limit: 50,
      exposure: 100,
    });
    expect(audits).toHaveLength(1);
  });

  it("a hand-over never alerts off the order switch: enforce_new_orders ON, enforce_delivery off (P3c)", async () => {
    const { d, audits } = deps("true", { key: CREDIT_LIMIT_ENFORCE_KEY });
    expect(await creditAfterTender(d, sale({ action: "delivery" }))).toBeNull();
    expect(audits).toHaveLength(0);
  });

  it("R1 ENFORCED, a breach once the tender failed: one warn, ONE audit row, the figures answered", async () => {
    const { d, audits } = deps("true");
    const out = await creditAfterTender(d, sale());
    expect(out).toEqual({ limit: 50, exposure: 100 });
    expect(d.logger.warn).toHaveBeenCalledTimes(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "credit-limit.over-after-tender",
      entityType: "Order",
      entityId: "ord-1",
      userId: "op-1",
      meta: {
        customerId: "cust-1",
        limit: 50,
        exposure: 100,
        netted: 100,
        planError: "COUNTER_PAYMENT_NOT_RECORDED",
      },
    });
  });

  it("R7 a retried sale that fails again writes no second audit row (idempotent per order)", async () => {
    const { d, audits } = deps("true", { audited: true });
    expect(await creditAfterTender(d, sale())).toEqual({ limit: 50, exposure: 100 });
    expect(audits).toHaveLength(1); // the pre-existing row only
  });

  it("the row names an impersonating operator, like every other counter-sale audit row", async () => {
    const { d, audits } = deps("true");
    await creditAfterTender(d, sale({ impersonatedBy: "sa-9" }));
    expect(audits[0]).toMatchObject({ userId: "op-1", impersonatedBy: "sa-9" });
    const plain = deps("true");
    await creditAfterTender(plain.d, sale());
    expect(plain.audits[0].impersonatedBy).toBeNull();
  });

  it("R7b two concurrent re-checks of one order write ONE row: the check-then-insert runs under the order's xact lock", async () => {
    const { d, db, audits, locks } = deps("true");
    // the first check reads "none yet" and yields before inserting: without the lock the second would too
    db.auditLog.findFirst.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return audits[0] ?? null;
    });
    const out = await Promise.all([creditAfterTender(d, sale()), creditAfterTender(d, sale())]);
    expect(out).toEqual([
      { limit: 50, exposure: 100 },
      { limit: 50, exposure: 100 },
    ]);
    expect(audits).toHaveLength(1);
    expect(locks).toEqual([
      "counter-tender:after-tender:ord-1",
      "counter-tender:after-tender:ord-1",
    ]);
  });

  it("SA-877 (2): the audit tx is a pure leaf, lock -> findFirst -> create, opened only after the exposure read", async () => {
    const { d, db, ops } = deps("true");
    db.invoice.findMany.mockImplementation(async () => (ops.push("exposure"), []));
    await creditAfterTender(d, sale());
    expect(ops).toEqual(["exposure", "tx", "lock_timeout", "lock", "findFirst", "create"]);
  });

  it("SA-877 (4): a lock timeout (55P03) is swallowed: logged, no row, null; the sale is never failed by it", async () => {
    const { d, audits, lockFail } = deps("true");
    lockFail.err = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });
    await expect(creditAfterTender(d, sale())).resolves.toBeNull();
    expect(audits).toHaveLength(0);
    expect(d.logger.error).toHaveBeenCalledTimes(1);
  });

  it("W-736 readOnly (by-key): ENFORCED answers the figures with NO warn line, NO transaction, NO audit row", async () => {
    const { d, audits, tenantTransaction } = deps("true");
    expect(await creditAfterTender(d, sale({ readOnly: true }))).toEqual({
      limit: 50,
      exposure: 100,
    });
    expect(d.logger.warn).not.toHaveBeenCalled();
    expect(tenantTransaction).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("W-736 readOnly under DARK: nothing answered, nothing logged", async () => {
    const { d } = deps("dark");
    expect(await creditAfterTender(d, sale({ readOnly: true }))).toBeNull();
    expect(d.logger.warn).not.toHaveBeenCalled();
  });

  it("R3 DARK: one warn line, no audit row, nothing answered", async () => {
    const { d, audits, tenantTransaction } = deps("dark");
    expect(await creditAfterTender(d, sale())).toBeNull();
    expect(d.logger.warn).toHaveBeenCalledTimes(1);
    expect(String(d.logger.warn.mock.calls[0][0])).toContain("after-tender");
    expect(audits).toHaveLength(0);
    expect(tenantTransaction).not.toHaveBeenCalled(); // no transaction opened for a log-only breach
  });

  it("R4 OFF: returns before any other read (the exposure derivation never runs)", async () => {
    const { d, db } = deps(null);
    expect(await creditAfterTender(d, sale())).toBeNull();
    expect(db.customer.findFirst).not.toHaveBeenCalled();
    expect(db.invoice.findMany).not.toHaveBeenCalled();
  });

  it("R8 nothing was netted (on account / a post-dated check): no re-check at all", async () => {
    const { d, db } = deps("true");
    expect(await creditAfterTender(d, sale({ netted: 0 }))).toBeNull();
    expect(db.systemConfig.findFirst).not.toHaveBeenCalled();
  });

  it("within the limit even without the tender: no warn, no row", async () => {
    const { d, audits } = deps("true", { limit: 500 });
    expect(await creditAfterTender(d, sale())).toBeNull();
    expect(d.logger.warn).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it("no limit set (a walk-in, or no credit terms): no-op", async () => {
    const { d, audits } = deps("true", { limit: null });
    expect(await creditAfterTender(d, sale())).toBeNull();
    expect(audits).toHaveLength(0);
  });

  it("any other error is logged and swallowed: an alert never fails a finished sale", async () => {
    const { d, db } = deps("true");
    db.invoice.findMany.mockRejectedValueOnce(new Error("db hiccup"));
    await expect(creditAfterTender(d, sale())).resolves.toBeNull();
    expect(d.logger.error).toHaveBeenCalled();
  });
});
