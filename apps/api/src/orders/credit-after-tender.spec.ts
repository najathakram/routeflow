import { CREDIT_LIMIT_ENFORCE_KEY, creditAfterTender } from "./credit-limit-guard";

/**
 * SA-849 rule 1-2 (S1 S-1): the ONE post-tender credit re-check. The gate counted till money (`netted`) that then did not
 * land; the sale is committed, so this never blocks: it re-runs the SAME derivation on live state (only the DB reads are
 * mocked here) and, on a breach, warns (DARK) or warns + writes ONE idempotent audit row + answers the figures (ENFORCED).
 * Red on master: `creditAfterTender` does not exist.
 */
type Mode = "true" | "dark" | null;
function deps(mode: Mode, opts: { limit?: number | null; audited?: boolean } = {}) {
  const audits: any[] = opts.audited ? [{ id: "a-1" }] : [];
  const db = {
    systemConfig: {
      findFirst: jest.fn(async ({ where }: any) =>
        where?.key === CREDIT_LIMIT_ENFORCE_KEY && mode ? { value: mode } : null,
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
  return {
    db,
    audits,
    d: {
      prisma: { getTenantId: () => "t-1", forTenant: () => db } as any,
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
  ...over,
});

describe("creditAfterTender (SA-849)", () => {
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

  it("R3 DARK: one warn line, no audit row, nothing answered", async () => {
    const { d, audits } = deps("dark");
    expect(await creditAfterTender(d, sale())).toBeNull();
    expect(d.logger.warn).toHaveBeenCalledTimes(1);
    expect(String(d.logger.warn.mock.calls[0][0])).toContain("after-tender");
    expect(audits).toHaveLength(0);
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
