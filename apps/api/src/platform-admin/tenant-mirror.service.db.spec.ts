/**
 * DB-lane spec for `TenantMirrorService.upsert()` (test-plan.md T13-9, §2.1 "Expanded").
 *
 * Proves the create/update/rename mirror path against a REAL Postgres — the schema's own
 * required/unique/FK constraints are the oracle (a wrong field name or missing required field
 * throws `PrismaClientValidationError` / a DB constraint error, not merely a mock assertion;
 * L-113's runtime half). `PlatformConfigService.getHouseTenantId()` is mocked to return the
 * fixture HQ tenant's real id — T12's own `getHouseTenantId` persistence path is out of scope
 * here (covered by `platform-config.service.spec.ts` / its own DB-lane spec); this file only
 * needs a real id that satisfies the HQ Customer/User FK constraints.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
 * (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), which points
 * DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS. `requireLocalDatabaseUrl()`
 * refuses any non-local host.
 *
 * SAFETY: both fixture tenants use `assertTestTenant`-approved `qa-` slugs (`qa-hq-<rand>` /
 * `qa-mirror-<rand>`), unique per run so parallel db.spec.ts files never collide. `afterAll`
 * deletes only rows this file created (by id), never a whole-table sweep.
 */
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { PlatformConfigService } from "./platform-config.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/**
 * Guarded require, matching `tenant-mirror.service.spec.ts` — this file is a sibling
 * test-authoring package (TP-C) run in parallel with TP-B's unit spec, so the real
 * `upsert(tenantId)` may not exist yet. A no-op fallback keeps every assertion below failing
 * on its OWN oracle (a missing Customer/User row) instead of a TypeError.
 */
let mod: any = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  mod = require("./tenant-mirror.service");
} catch {
  mod = {};
}
interface TenantMirror {
  upsert(tenantId: string): Promise<void>;
}
class NotImplementedTenantMirrorService implements TenantMirror {
  async upsert(_tenantId: string): Promise<void> {
    return undefined;
  }
}
const TenantMirrorServiceCtor: new (...args: any[]) => TenantMirror =
  typeof mod.TenantMirrorService === "function"
    ? mod.TenantMirrorService
    : NotImplementedTenantMirrorService;

const RUN_SUFFIX = randomUUID().slice(0, 8);
const HQ_SLUG = assertTestTenant(`qa-hq-${RUN_SUFFIX}`, "tenant-mirror.service.db.spec.ts");
const MIRROR_SLUG = assertTestTenant(`qa-mirror-${RUN_SUFFIX}`, "tenant-mirror.service.db.spec.ts");

describeDb("TenantMirrorService.upsert() (db) — T13-9", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  let hqTenantId: string;
  let mirrorTenantId: string;

  beforeAll(async () => {
    const hqTenant = await prisma.tenant.create({
      data: { slug: HQ_SLUG, name: "RouteFlow HQ (QA)", status: "ACTIVE", class: "INTERNAL" },
    });
    hqTenantId = hqTenant.id;

    const mirrorTenant = await prisma.tenant.create({
      data: {
        slug: MIRROR_SLUG,
        name: "Acme Wholesale",
        status: "ACTIVE",
        class: "PRODUCTION",
      },
    });
    mirrorTenantId = mirrorTenant.id;

    await prisma.user.create({
      data: {
        tenantId: mirrorTenantId,
        email: `qa_owner+${RUN_SUFFIX}@placeholder.local`,
        username: "qa_owner",
        role: "TENANT_ADMIN",
      },
    });
  });

  afterAll(async () => {
    // Delete in FK-safe order: ContactPerson -> Customer (mirror) -> Users -> Tenants.
    const mirrorCustomer = await prisma.customer.findUnique({
      where: { representsTenantId: mirrorTenantId },
    });
    if (mirrorCustomer) {
      await prisma.contactPerson.deleteMany({ where: { customerId: mirrorCustomer.id } });
      const mirrorUserId = mirrorCustomer.userId;
      await prisma.customer.delete({ where: { id: mirrorCustomer.id } });
      await prisma.user.deleteMany({ where: { id: mirrorUserId } });
    }
    await prisma.user.deleteMany({ where: { tenantId: mirrorTenantId } });
    await prisma.user.deleteMany({ where: { tenantId: hqTenantId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [hqTenantId, mirrorTenantId] } } });
    await prisma.$disconnect();
    await pool.end();
  });

  async function buildService(): Promise<TenantMirror> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantMirrorServiceCtor,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PlatformConfigService,
          useValue: { getHouseTenantId: jest.fn().mockResolvedValue(hqTenantId) },
        },
      ],
    }).compile();
    return module.get(TenantMirrorServiceCtor);
  }

  it("T13-9 (R9, R10, R14): create writes exactly one mirror Customer+User in HQ, second upsert only refreshes businessName, rename updates businessName without touching contactName", async () => {
    const service = await buildService();

    // --- call 1: create path (R9, R11) ---
    await service.upsert(mirrorTenantId);

    const afterCreate = await prisma.customer.findMany({
      where: { representsTenantId: mirrorTenantId },
    });
    expect(afterCreate).toHaveLength(1);
    const mirrorCustomer = afterCreate[0];
    expect(mirrorCustomer.tenantId).toBe(hqTenantId);
    expect(mirrorCustomer.representsTenantId).toBe(mirrorTenantId);
    expect(mirrorCustomer.contactName).toBe("qa_owner");
    expect(mirrorCustomer.businessName).toBe("Acme Wholesale");

    const mirrorUser = await prisma.user.findUnique({ where: { id: mirrorCustomer.userId } });
    expect(mirrorUser).not.toBeNull();
    expect(mirrorUser!.tenantId).toBe(hqTenantId);
    expect(mirrorUser!.email).toBe(`mirror+${mirrorTenantId}@placeholder.local`);
    expect(mirrorUser!.role).toBe("CUSTOMER");

    // --- call 2: update path is a no-op when nothing changed (R10) ---
    await service.upsert(mirrorTenantId);

    const afterSecondUpsert = await prisma.customer.findMany({
      where: { representsTenantId: mirrorTenantId },
    });
    expect(afterSecondUpsert).toHaveLength(1); // exactly one — no duplicate mirror row
    expect(afterSecondUpsert[0].id).toBe(mirrorCustomer.id);
    expect(afterSecondUpsert[0].contactName).toBe("qa_owner");
    expect(afterSecondUpsert[0].businessName).toBe("Acme Wholesale");

    // R14 dropped from this spec's coverage: WP-B leaves ContactPerson creation optional for the
    // mirror Customer, so no cardinality here can be a real oracle — `toBeLessThanOrEqual(1)` was
    // vacuously satisfied by zero rows and could never catch a missing OR duplicated row. If R14
    // is promoted to a hard requirement later, assert the exact expected shape here instead
    // (e.g. `expect(contactPersons).toHaveLength(1)` plus a field check) rather than reinstating
    // a bound that a deleted feature would still satisfy.

    // --- rename: businessName refreshes, contactName never does (R10) ---
    await prisma.tenant.update({
      where: { id: mirrorTenantId },
      data: { name: "Renamed" },
    });
    await service.upsert(mirrorTenantId);

    const afterRename = await prisma.customer.findUnique({ where: { id: mirrorCustomer.id } });
    expect(afterRename!.businessName).toBe("Renamed");
    expect(afterRename!.contactName).toBe("qa_owner");

    // Still exactly one mirror row after three upserts — no duplicates created along the way.
    const finalRows = await prisma.customer.findMany({
      where: { representsTenantId: mirrorTenantId },
    });
    expect(finalRows).toHaveLength(1);
  });
});
