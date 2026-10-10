/**
 * DB-lane proof for the per-operator feature-group columns on "User" (real Postgres, throwaway `qa-*`
 * tenants).
 *
 * Run through the DB lane (`npm run local:test:db`; collected only by `jest.db.config.js`). Needs the
 * 20261009120000_operator_permission_groups migration applied. `requireLocalDatabaseUrl()` refuses any
 * non-local host; every tenant is a `qa-*` slug approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { OperatorPermissionsService } from "../auth/permissions/operator-permissions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
const ALL = Object.values(OperatorPermissionGroup);

describeDb("User feature-group columns — real Postgres", () => {
  let prisma: PrismaService;
  let service: OperatorPermissionsService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    service = new OperatorPermissionsService(prisma);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
      // eslint-disable-next-line no-await-in-loop
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  async function seedTenant(label: string): Promise<string> {
    const slug = assertTestTenant(
      `qa-opperm-${RUN_SUFFIX}-${tenantIds.length}-${label}`,
      "users-permissions.columns.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `opperm ${slug}` } });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  const seedUser = (tenantId: string, name: string, role: UserRole) =>
    prisma.user.create({
      data: { tenantId, role, username: name, email: `${name}-${RUN_SUFFIX}@example.test` },
    });

  it("a new User row defaults to no denied groups and version 0", async () => {
    const tenantId = await seedTenant("defaults");
    const created = await seedUser(tenantId, "op-default", UserRole.OPERATOR);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deniedPermissionGroups).toEqual([]);
    expect(row.permissionsVersion).toBe(0);
  });

  it("every role gets the same defaults (the columns are not role-specific)", async () => {
    const tenantId = await seedTenant("roles");
    for (const role of [UserRole.TENANT_ADMIN, UserRole.DRIVER]) {
      // eslint-disable-next-line no-await-in-loop
      const created = await seedUser(tenantId, `u-${role.toLowerCase()}`, role);
      expect(created.deniedPermissionGroups).toEqual([]);
      expect(created.permissionsVersion).toBe(0);
    }
  });

  it("stores and returns a deny list as the enum array, and an integer version", async () => {
    const tenantId = await seedTenant("roundtrip");
    const created = await seedUser(tenantId, "op-denied", UserRole.OPERATOR);
    await prisma.user.update({
      where: { id: created.id },
      data: { deniedPermissionGroups: ["FINANCE", "PRICING"], permissionsVersion: 1 },
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.deniedPermissionGroups).toEqual(["FINANCE", "PRICING"]);
    expect(row.permissionsVersion).toBe(1);
  });

  it("the database enum carries exactly the nine groups", async () => {
    const rows = await prisma.$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'OperatorPermissionGroup'
       ORDER BY e.enumsortorder`;
    expect(rows.map((r) => r.label)).toEqual(ALL);
  });

  it("effective() reads the real row: all minus denied for an operator, scoped to the caller's tenant", async () => {
    const tenantId = await seedTenant("effective");
    const otherTenantId = await seedTenant("effective-other");
    const op = await seedUser(tenantId, "op-effective", UserRole.OPERATOR);
    await prisma.user.update({
      where: { id: op.id },
      data: { deniedPermissionGroups: ["REPORTS"], permissionsVersion: 2 },
    });

    const mine = await service.effective({ sub: op.id, tenantId, role: UserRole.OPERATOR });
    expect(mine.version).toBe(2);
    expect(mine.groups).toEqual(ALL.filter((g) => g !== "REPORTS"));

    // The same id presented with another tenant's id finds no row: no groups.
    const crossTenant = await service.effective({
      sub: op.id,
      tenantId: otherTenantId,
      role: UserRole.OPERATOR,
    });
    expect(crossTenant).toEqual({ groups: [], version: 0 });
  });

  it("effective() gives a soft-deleted operator no groups", async () => {
    const tenantId = await seedTenant("deleted");
    const op = await seedUser(tenantId, "op-deleted", UserRole.OPERATOR);
    await prisma.user.update({ where: { id: op.id }, data: { deletedAt: new Date() } });
    const out = await service.effective({ sub: op.id, tenantId, role: UserRole.OPERATOR });
    expect(out).toEqual({ groups: [], version: 0 });
  });
});
