import { Test } from "@nestjs/testing";
import * as fs from "fs";
import * as path from "path";
import { TrackedCategoriesService } from "./tracked-categories.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import {
  OLD_WRITER_MATCHER,
  auditFollowsOnSameTx,
  trackedCategoryWriterSites,
  trackedDelegateWrites,
  type WriterShape,
} from "./tracked-category-writers";

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
 * The writer inventory (SA-958 §3.2): every write to the TrackedCategory table in production code sits in a file that
 * audits it ON THE SAME transaction, and the sites are exactly these. A new writer fails here until it is audited and
 * listed. The scanner (`tracked-category-writers.ts`) reuses the products tripwire's `trackedDelegateWrites` (every write
 * method: createMany, createManyAndReturn, updateManyAndReturn ...) and adds the shapes a plain `.create(` search misses.
 */
describe("TrackedCategory writer inventory (Row 430)", () => {
  const SRC = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.ts$/.test(e.name) && !/(\.spec|\.db\.spec)\.ts$/.test(e.name) ? [p] : [];
    });
  /** Not production code: the shared Prisma mock (src/testing) and one DB-spec cleanup harness, each with its reason. */
  const NOT_PRODUCTION: Record<string, string> = {
    "inventory/testing/count-db-harness.ts":
      "DB-spec fixture cleanup (deleteMany of the throwaway tenant's rows)",
    "tracked-categories/tracked-category-writers.ts":
      "the scanner itself (its docs and patterns spell the shapes)",
    "products/tripwire-scan.ts":
      "the scanner the writers tripwire shares (its docs spell the shapes)",
  };
  const production = () =>
    walk(SRC).filter((f) => {
      const rel = path.relative(SRC, f);
      return !rel.startsWith(`testing${path.sep}`) && !(rel in NOT_PRODUCTION);
    });
  const sitesOf = (f: string) => trackedCategoryWriterSites(fs.readFileSync(f, "utf8"));
  const inventory = () =>
    production()
      .map((f) => [path.relative(SRC, f), sitesOf(f)] as const)
      .filter(([, s]) => s.length > 0);

  it("exactly these writer sites, in these two files", () => {
    expect(
      inventory().map(([file, s]) => [file, s.map((x) => `${x.shape}:${x.delegate}`).sort()]),
    ).toEqual([
      [
        "products/products.service.ts",
        ["delegate:trackedCategory"], // the first-tobacco auto-seed (audited via: tobacco-autoseed)
      ],
      [
        "tracked-categories/tracked-categories.service.ts",
        [
          "delegate:trackedCategory", // create
          "delegate:trackedCategory", // update
          "delegate:trackedCategory", // toggle
          // Subcategory writes: a name and an active flag, no tax rate (schema TrackedSubcategory), so outside the rate
          // audit. Listed so a NEW subcategory writer still needs a decision here.
          "delegate:trackedSubcategory",
          "delegate:trackedSubcategory",
          "delegate:trackedSubcategory",
        ],
      ],
    ]);
  });

  it("every TrackedCategory write is followed by the audit helper on the SAME transaction handle", () => {
    for (const f of production()) {
      const src = fs.readFileSync(f, "utf8");
      for (const site of trackedCategoryWriterSites(src)) {
        if (site.delegate !== "trackedCategory") continue;
        expect({
          file: path.relative(SRC, f),
          receiver: site.receiver,
          audited: auditFollowsOnSameTx(src, site),
        }).toMatchObject({ audited: true });
      }
    }
  });

  it("the scan agrees with the shared tripwire counter (trackedDelegateWrites) on every production file", () => {
    for (const f of production()) {
      const src = fs.readFileSync(f, "utf8");
      const mine = trackedCategoryWriterSites(src).filter((x) => x.shape === "delegate").length;
      const shared =
        trackedDelegateWrites(src).length +
        (src.match(/\.tracked(Sub)?[Cc]ategory\.deleteMany\(/g) ?? []).length;
      expect({ file: path.relative(SRC, f), n: mine }).toEqual({
        file: path.relative(SRC, f),
        n: shared,
      });
    }
  });

  it("the controller hands the acting user to create, update and toggle", () => {
    const src = fs.readFileSync(path.join(__dirname, "tracked-categories.controller.ts"), "utf8");
    for (const m of ["create", "update", "toggle"]) {
      expect(src).toMatch(new RegExp(`this\\.service\\.${m}\\([^)]*user[^)]*\\)`));
    }
  });

  describe("scanner self-test: every bypass shape is seen (each was invisible to the old matcher)", () => {
    // [name, code, shape the scanner reports, did the OLD matcher miss it]
    const SHAPES: Array<[string, string, WriterShape, boolean]> = [
      ["createMany", "await tx.trackedCategory.createMany({ data: [] });", "delegate", true],
      [
        "createManyAndReturn",
        "await tx.trackedCategory.createManyAndReturn({ data: [] });",
        "delegate",
        true,
      ],
      [
        "updateManyAndReturn",
        "await tx.trackedCategory.updateManyAndReturn({ data: {} });",
        "delegate",
        true,
      ],
      ["alias", "const d = tx.trackedCategory;\nawait d.create({ data });", "alias", true],
      ["bracket access", 'await tx["trackedCategory"].create({ data });', "delegate", true],
      ["optional chaining", "await tx?.trackedCategory?.create({ data });", "delegate", true],
      [
        "destructured delegate",
        "const { trackedCategory } = tx;\nawait trackedCategory.create({ data });",
        "destructured",
        false,
      ],
      [
        "raw SQL insert",
        'await tx.$executeRaw`INSERT INTO "TrackedCategory" (id) VALUES (1)`;',
        "raw-sql",
        true,
      ],
      [
        "raw SQL update",
        "await tx.$executeRawUnsafe('UPDATE \"TrackedCategory\" SET rate = 0');",
        "raw-sql",
        true,
      ],
      [
        "nested relation write",
        "await tx.tenant.update({ where, data: { trackedCategories: { create: { name } } } });",
        "nested",
        true,
      ],
      [
        "nested createMany",
        "data: { subcategories: { createMany: { data: [] } } }",
        "nested",
        true,
      ],
    ];
    it.each(SHAPES)("%s: the scanner sees it", (_name, code, shape) => {
      expect(trackedCategoryWriterSites(code).map((s) => s.shape)).toContain(shape);
    });

    it.each(SHAPES.filter((x) => x[3]))("%s: the OLD matcher missed it", (_name, code) => {
      // The pre-fold pin only saw a literal `trackedCategory.create|update|upsert|delete|updateMany|deleteMany(`.
      expect(code.match(OLD_WRITER_MATCHER)).toBeNull();
    });

    it("a line-split call is seen (the old pattern allowed the whitespace too)", () => {
      expect(
        trackedCategoryWriterSites("await tx.trackedCategory\n  .update({ where });"),
      ).toHaveLength(1);
    });

    it("reads and relation selects are not writers", () => {
      const reads = [
        "await tx.trackedCategory.findMany({ where });",
        "const n = line.product.trackedCategory?.name;",
        "include: { trackedCategory: { select: { id: true } } },",
        "// await tx.trackedCategory.create({ data });",
        "/**\n * tx.trackedCategory.update({ data }) in a doc comment\n */",
      ].join("\n");
      expect(trackedCategoryWriterSites(reads)).toEqual([]);
    });

    it("the same-tx check fails when the audit uses a different handle", () => {
      const ok =
        "await tx.trackedCategory.create({ data });\nawait auditTrackedCategoryWrite(tx, {});";
      const bad =
        "await tx.trackedCategory.create({ data });\nawait auditTrackedCategoryWrite(this.prisma, {});";
      const [okSite] = trackedCategoryWriterSites(ok);
      const [badSite] = trackedCategoryWriterSites(bad);
      expect(auditFollowsOnSameTx(ok, okSite)).toBe(true);
      expect(auditFollowsOnSameTx(bad, badSite)).toBe(false);
    });
  });
});
