/**
 * REG-B79 T17 — DB-lane round-trip: the read path returns the persisted `issueDate`.
 * Design of record: `.claude/pipeline/2026-09-13-F27-build/build-plan.md` (task rt-b79-db),
 * `.claude/pipeline/2026-09-13-F27-build/tasks/rc-b79/brief.md`.
 *
 * WHY THE DB LANE: a mocked `prisma.estimate.create` can prove the WRITE call shape, but it
 * cannot prove the column is actually persisted AND survives an explicit `select`/`include`
 * projection on the way back out. This spec drives the REAL `EstimatesService.create()`,
 * `findOne()`, and `findAll()` through a NestJS TestingModule wired with a REAL `PrismaService`
 * (bound to the compose Postgres) — every other collaborator (`EntitlementsService`,
 * `NumberingService` stays real since it only needs `PrismaService`) is otherwise untouched.
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 *
 * SAFETY: every tenant this file creates is a throwaway `qa-b79-<run>-<n>` slug, approved by
 * `assertTestTenant` (`scripts/lib/test-tenants.cjs`); `afterAll` deletes exactly the rows this
 * run created, in FK order (Estimate -> Customer -> User -> Tenant), never anyone else's.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { EstimatesService } from "./estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);

describeDb("REG-B79 estimates issueDate — real Postgres round-trip (T17)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let estimatesService: EstimatesService;
  const createdTenantIds: string[] = [];

  // flag.msrp OFF: create()'s MSRP branch no-ops, same as estimates.service.spec.ts's default.
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane.db.spec.ts's rule): the real
    // connection is built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EstimatesService,
        // REAL NumberingService over the REAL PrismaService above — nextEstNumber() must
        // actually mint through the tenant-scoped NumberingSequence primitive.
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: mockEntitlements },
      ],
    }).compile();

    estimatesService = module.get(EstimatesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: a failed cleanup must never mask the test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.estimate.deleteMany({ where: { tenantId } });
    await prisma.numberingSequence.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(): Promise<{ id: string; slug: string }> {
    const slug = assertTestTenant(
      `qa-b79-${RUN_SUFFIX}-${createdTenantIds.length + 1}`,
      "estimates.issue-date.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B79 ${slug}` } });
    createdTenantIds.push(tenant.id);
    return { id: tenant.id, slug };
  }

  async function seedCustomer(tenantId: string): Promise<{ id: string }> {
    const idBase = `${tenantId}-cust`;
    const user = await prisma.user.create({
      data: {
        email: `${idBase}@example.invalid`,
        username: idBase,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "B79 customer",
        contactName: "B79 contact",
        tenantId,
      },
    });
    return { id: customer.id };
  }

  it(
    "T17 read path returns the persisted issueDate (DB lane): findOne and findAll both " +
      "return issueDate=2026-09-01T00:00:00.000Z for an estimate created with issueDate " +
      '"2026-09-01"',
    async () => {
      const tenant = await seedTenant();
      const customer = await seedCustomer(tenant.id);

      const created = await tenantCtx.run(tenant.id, () =>
        estimatesService.create({
          customerId: customer.id,
          issueDate: "2026-09-01",
          items: [{ description: "widget", qty: 1, unitPrice: 10 }],
        } as any),
      );

      const expected = new Date("2026-09-01T00:00:00.000Z");

      const viaFindOne = await tenantCtx.run(tenant.id, () =>
        estimatesService.findOne((created as any).id),
      );
      expect((viaFindOne as any).issueDate).toEqual(expected);

      const viaFindAll = await tenantCtx.run(tenant.id, () => estimatesService.findAll());
      const fromList = (viaFindAll as any).data.find((e: any) => e.id === (created as any).id);
      expect(fromList).toBeDefined();
      expect(fromList.issueDate).toEqual(expected);
    },
    30_000,
  );
});
