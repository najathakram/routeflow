import { Test } from "@nestjs/testing";
import * as fs from "fs";
import * as path from "path";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";

/**
 * Row 430 (SA-958 §3.2): a tracked category holds regulated tax rates, so every write leaves an AuditLog row in the SAME
 * transaction (a failed audit insert rolls the write back; AuditService.log would swallow it). Before/after carry the
 * rate fields. No migration: the existing AuditLog table.
 */
const ACTOR = { sub: "u-op", impersonatedBy: null };
const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  tenantId: "test-tenant",
  name: "Tobacco",
  taxType: "PERCENT_OF_SALE",
  rate: "0.0500",
  unitBasis: null,
  priceIncludesTax: false,
  invoiceTreatment: "SEPARATE_INVOICE",
  requiresLicense: false,
  active: true,
  _count: { products: 0 },
  ...over,
});

describe("TrackedCategoriesService audit rows (Row 430)", () => {
  let service: TrackedCategoriesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tx: { trackedCategory: Record<string, jest.Mock>; auditLog: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = createMockPrisma();
    tx = {
      trackedCategory: { create: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
    const mod = await Test.createTestingModule({
      providers: [TrackedCategoriesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(TrackedCategoriesService);
  });

  const audits = () => tx.auditLog.create.mock.calls.map((c) => c[0].data);

  it("create: writes the row and its audit row through the SAME transaction", async () => {
    tx.trackedCategory.create.mockResolvedValue(row());
    await service.create(
      { name: "Tobacco", taxType: "PERCENT_OF_SALE", rate: 0.05 } as never,
      ACTOR,
    );
    expect(prisma.trackedCategory.create).not.toHaveBeenCalled(); // not the ambient client
    expect(audits()).toEqual([
      expect.objectContaining({
        tenantId: "test-tenant",
        userId: "u-op",
        action: AUDIT_ACTIONS.TRACKED_CATEGORY_CREATED,
        entityType: "TrackedCategory",
        entityId: "c1",
        meta: expect.objectContaining({
          before: null,
          after: expect.objectContaining({ taxType: "PERCENT_OF_SALE", rate: "0.05" }),
        }),
      }),
    ]);
  });

  it("update: before and after carry the rate fields that changed", async () => {
    prisma.trackedCategory.findUnique.mockResolvedValue(row());
    tx.trackedCategory.update.mockResolvedValue(row({ rate: "0.1000" }));
    await service.update("c1", { rate: 0.1 } as never, ACTOR);
    const [a] = audits();
    expect(a.action).toBe(AUDIT_ACTIONS.TRACKED_CATEGORY_UPDATED);
    expect(a.meta.before.rate).toBe("0.05");
    expect(a.meta.after.rate).toBe("0.1");
  });

  it("toggle: an active flip is audited too", async () => {
    prisma.trackedCategory.findUnique.mockResolvedValue(row());
    tx.trackedCategory.update.mockResolvedValue(row({ active: false }));
    await service.toggle("c1", ACTOR);
    const [a] = audits();
    expect(a.action).toBe(AUDIT_ACTIONS.TRACKED_CATEGORY_UPDATED);
    expect([a.meta.before.active, a.meta.after.active]).toEqual([true, false]);
  });

  it("a support session is named on the row", async () => {
    tx.trackedCategory.create.mockResolvedValue(row());
    await service.create({ name: "Tobacco" } as never, { sub: "sa-1", impersonatedBy: "sa-1" });
    expect(audits()[0]).toMatchObject({ userId: "sa-1", impersonatedBy: "sa-1" });
  });

  it("a failed audit insert fails the write (it is not swallowed)", async () => {
    tx.trackedCategory.create.mockResolvedValue(row());
    tx.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(service.create({ name: "Tobacco" } as never, ACTOR)).rejects.toThrow("audit down");
  });
});

/**
 * The writer inventory (SA-958 §3.2): every `trackedCategory.create|update|upsert|delete` in production code sits in a
 * file that audits it, and the sites are exactly these. A new writer fails here until it is audited and listed.
 */
describe("TrackedCategory writer inventory (Row 430)", () => {
  const SRC = path.resolve(__dirname, "..");
  const WRITER = /trackedCategory\s*\.\s*(create|update|upsert|delete|updateMany|deleteMany)\s*\(/g;
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.ts$/.test(e.name) && !/(\.spec|\.db\.spec)\.ts$/.test(e.name) ? [p] : [];
    });
  const sites = () =>
    walk(SRC)
      .filter((f) => !f.includes(`${path.sep}testing${path.sep}`))
      .map(
        (f) =>
          [path.relative(SRC, f), (fs.readFileSync(f, "utf8").match(WRITER) ?? []).length] as const,
      )
      .filter(([, n]) => n > 0)
      .sort();

  it("exactly four writer sites, in these two files", () => {
    expect(sites()).toEqual([
      ["products/products.service.ts", 1],
      ["tracked-categories/tracked-categories.service.ts", 3],
    ]);
  });

  it("each writer file calls the audit helper once per writer", () => {
    for (const [file, n] of sites()) {
      const src = fs.readFileSync(path.join(SRC, file), "utf8");
      expect((src.match(/auditTrackedCategoryWrite\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(n);
    }
  });

  it("the controller hands the acting user to create, update and toggle", () => {
    const src = fs.readFileSync(path.join(__dirname, "tracked-categories.controller.ts"), "utf8");
    for (const m of ["create", "update", "toggle"]) {
      expect(src).toMatch(new RegExp(`this\\.service\\.${m}\\([^)]*user[^)]*\\)`));
    }
  });
});
