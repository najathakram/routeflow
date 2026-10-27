import { ConflictException } from "@nestjs/common";
import { RegulatedFilingService } from "./regulated-filing.service";

jest.mock("../common/tenant-time-zone", () => ({ tenantTimeZone: async () => null }));
jest.mock("./filing-lock-ready", () => ({
  ...jest.requireActual("./filing-lock-ready"),
  assertFilingLockReady: () => undefined, // SA-997: this spec exercises the lock itself
}));

/**
 * B297 PR5, Opus review of #3726 (MUST 4): `lockFiling` claims the GENERATED -> LOCKED transition and writes its
 * audit row in ONE tenant transaction, so a lock can never commit without its audit row, nor the reverse. The
 * audit row goes through `tx.auditLog.create` (not `AuditService.log`, which swallows errors and uses its own
 * client, so it could not roll back with the claim).
 */
describe("lockFiling: the claim and the audit row are one transaction", () => {
  const generated = {
    id: "f-1",
    status: "GENERATED",
    trackedCategoryId: "cat-1",
    cadence: "MONTHLY",
    periodKey: "2020-01",
    periodStart: new Date("2020-01-01T00:00:00Z"),
    periodEnd: new Date("2020-02-01T00:00:00Z"),
    totalCategoryTax: 0,
    totalQty: 0,
    totalUnitBasisQty: 0,
    totalNetSales: 0,
    rows: [],
    generationCount: 2,
  };

  function build(
    opts: { claimCount?: number; auditFails?: boolean; stored?: Record<string, unknown> } = {},
  ) {
    // a tiny transactional store: writes inside the tx are buffered and only "committed" when the callback resolves
    const committed: string[] = [];
    const outerUpdateMany = jest.fn();
    const forTenant = {
      regulatedFiling: {
        findUnique: jest.fn().mockResolvedValue(generated),
        updateMany: outerUpdateMany, // must never be used for the claim
      },
      trackedCategory: {
        findUnique: jest.fn().mockResolvedValue({ id: "cat-1", name: "Tobacco" }),
      },
      regulatedLedgerParkedReversal: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const txClients: any[] = [];
    const tenantTransaction = jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const pending: string[] = [];
      const tx = {
        regulatedFiling: {
          updateMany: jest.fn(async (a: any) => {
            pending.push(`claim:${a.where.id}`);
            return { count: opts.claimCount ?? 1 };
          }),
          findUnique: jest
            .fn()
            .mockResolvedValue({ ...generated, ...opts.stored, status: "LOCKED" }),
        },
        auditLog: {
          create: jest.fn(async (a: any) => {
            if (opts.auditFails) throw new Error("audit insert failed");
            pending.push(`audit:${a.data.action}`);
            return {};
          }),
        },
      };
      txClients.push(tx);
      const out = await fn(tx); // a throw here discards `pending`: the rollback
      committed.push(...pending);
      return out;
    });
    const prisma = { getTenantId: () => "t1", forTenant: () => forTenant, tenantTransaction };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new (RegulatedFilingService as any)(
      prisma,
      {},
      audit,
      { getLedger: jest.fn().mockResolvedValue({ rows: [] }) }, // no ledger change since the filing: not stale
      {},
    );
    return { svc, committed, txClients, outerUpdateMany, audit, tenantTransaction };
  }

  it("runs the claim and the audit write on the SAME tx client, and commits both", async () => {
    const { svc, committed, txClients, outerUpdateMany, audit, tenantTransaction } = build();
    const out = await svc.lockFiling("f-1", { userId: "u1", reason: "Filed with the state" });
    expect(tenantTransaction).toHaveBeenCalledTimes(1);
    expect(txClients).toHaveLength(1);
    expect(txClients[0].regulatedFiling.updateMany).toHaveBeenCalledTimes(1);
    expect(txClients[0].auditLog.create).toHaveBeenCalledTimes(1);
    expect(txClients[0].auditLog.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      action: "regulated_filing.locked",
      entityType: "RegulatedFiling",
      entityId: "f-1",
    });
    expect(outerUpdateMany).not.toHaveBeenCalled(); // never claimed outside the tx
    expect(audit.log).not.toHaveBeenCalled(); // the swallowing, non-tx audit path is not used
    expect(committed).toEqual(["claim:f-1", "audit:regulated_filing.locked"]);
    expect(out.status).toBe("LOCKED");
  });

  it("an audit failure rolls the claim back: the lock is not left committed", async () => {
    const { svc, committed } = build({ auditFails: true });
    await expect(
      svc.lockFiling("f-1", { userId: "u1", reason: "Filed with the state" }),
    ).rejects.toThrow("audit insert failed");
    expect(committed).toEqual([]); // neither the claim nor an audit row survived
  });

  it("a lost claim (count 0) is a 409 and writes no audit row", async () => {
    const { svc, committed, txClients } = build({ claimCount: 0 });
    await expect(
      svc.lockFiling("f-1", { userId: "u1", reason: "Filed with the state" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(txClients[0].auditLog.create).not.toHaveBeenCalled();
    expect(committed).toEqual([]); // the lost claim throws inside the tx: nothing is committed
  });

  it("SA-995: figures that no longer match the ledger roll the claim back with 409 FILING_STALE", async () => {
    const { svc, committed } = build({ stored: { totalNetSales: 10 } });
    await expect(
      svc.lockFiling("f-1", { userId: "u1", reason: "Filed with the state" }),
    ).rejects.toMatchObject({ response: { code: "FILING_STALE" } });
    expect(committed).toEqual([]); // no claim, no audit row
  });

  it("SA-995: the audit row carries the impersonator", async () => {
    const { svc, txClients } = build();
    await svc.lockFiling("f-1", {
      userId: "u1",
      reason: "Filed with the state",
      impersonatedBy: "sa-1",
    });
    expect(txClients[0].auditLog.create.mock.calls[0][0].data.impersonatedBy).toBe("sa-1");
  });
});
