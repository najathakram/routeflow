import { RegulatedFilingService } from "./regulated-filing.service";

/**
 * B297 PR5 review H2: a regeneration that races a lock must never flip a LOCKED filing back to GENERATED or
 * overwrite its artifact. The row write is conditional on status != LOCKED and the stored row is returned.
 */
describe("prepareFiling vs a concurrent lock", () => {
  const category = {
    id: "cat-1",
    name: "Tobacco",
    reportCadence: "MONTHLY",
    reportTemplate: "GENERIC",
    unitBasis: null,
  };
  const lockedRow = {
    id: "f-1",
    status: "LOCKED",
    generationCount: 2,
    trackedCategoryId: "cat-1",
    periodKey: "2026-09",
  };

  function build(opts: { earlyStatus: string; lateStatus: string }) {
    const update = jest.fn().mockResolvedValue({ ...lockedRow, status: "GENERATED" });
    let finds = 0;
    const regulatedFiling = {
      // 1st: the early LOCKED check; 2nd: the re-read right before the upload; 3rd+: the upsert's existing lookup
      findFirst: jest.fn(async () => {
        finds += 1;
        const status = finds === 1 ? opts.earlyStatus : opts.lateStatus;
        return status === "NONE" ? null : { ...lockedRow, status };
      }),
      update,
      findUniqueOrThrow: jest.fn(async () => ({ ...lockedRow, status: opts.lateStatus })),
      create: jest.fn(),
    };
    const prisma = {
      getTenantId: () => "t1",
      forTenant: () => ({
        trackedCategory: { findUnique: jest.fn().mockResolvedValue(category) },
        regulatedFiling,
        regulatedLedgerParkedReversal: { findMany: jest.fn().mockResolvedValue([]) },
        regulatedSalesLedger: { findMany: jest.fn().mockResolvedValue([]) },
      }),
    };
    const storage = { upload: jest.fn().mockResolvedValue(undefined) };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const regulated = { getLedger: jest.fn().mockResolvedValue({ rows: [] }) };
    const svc = new (RegulatedFilingService as any)(prisma, storage, audit, regulated, {});
    return { svc, regulatedFiling, storage, audit };
  }

  it("a lock that commits between the early check and the upload stops the overwrite", async () => {
    const { svc, storage, audit } = build({ earlyStatus: "GENERATED", lateStatus: "LOCKED" });
    const out = await svc.prepareFiling({
      trackedCategoryId: "cat-1",
      cadence: "MONTHLY",
      year: 2020,
      index: 1,
    });
    expect(out.status).toBe("LOCKED");
    expect(storage.upload).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a lock that commits AFTER the upload still cannot be flipped back: the write is conditional", async () => {
    const { svc, regulatedFiling, storage, audit } = build({
      earlyStatus: "GENERATED",
      lateStatus: "GENERATED",
    });
    // the upsert's conditional update finds the row LOCKED by then: no row matches (Prisma P2025)
    regulatedFiling.update.mockRejectedValue({ code: "P2025" });
    regulatedFiling.findUniqueOrThrow.mockResolvedValue({ ...lockedRow, status: "LOCKED" });
    const out = await svc.prepareFiling({
      trackedCategoryId: "cat-1",
      cadence: "MONTHLY",
      year: 2020,
      index: 1,
    });
    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(regulatedFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "f-1", status: { not: "LOCKED" } } }),
    );
    expect(out.status).toBe("LOCKED"); // the stored locked row, not a regenerated one
    expect(audit.log).not.toHaveBeenCalled();
  });
});
