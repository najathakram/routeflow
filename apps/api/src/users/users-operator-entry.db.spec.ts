/**
 * SA-1050 A-5 — real Postgres: a row that ENTERS the operator role starts without the groups the owner keeps off
 * by default (BAD_DEBT), and the version bumps in the same write. A5-1 (DRIVER -> OPERATOR) and A5-2 (CUSTOMER ->
 * OPERATOR) are the rows that were red before `updateUser` stamped the list; A5-3..A5-5 are the guards that a row
 * which already denies the group, a move OUT of OPERATOR and an email-only edit change neither the list nor the
 * version.
 *
 * Run via `npm run local:test:db`. The tenant is a throwaway `qa-opentry-<run>` slug approved by
 * `assertTestTenant`, and afterAll deletes exactly what it made. Every fixture row sets its deny list EXPLICITLY:
 * the generated client stamps its own schema default on create, which is not what a row from before the deploy holds.
 */
import { randomUUID } from "crypto";
import { OperatorPermissionGroup, UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "./users.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "users-operator-entry.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
const BAD_DEBT = OperatorPermissionGroup.BAD_DEBT;

describeDb(
  "users: a row entering OPERATOR starts with the default-denied groups (SA-1050 A-5)",
  () => {
    let prisma: PrismaService;
    let ctx: TenantContextService;
    let users: UsersService;
    let tenantId: string;
    let n = 0;

    const mkUser = (role: UserRole, denied: OperatorPermissionGroup[]) => {
      const name = `u${++n}-${RUN}`;
      return prisma.user.create({
        data: {
          tenantId,
          username: name,
          email: `${name}@example.invalid`,
          role,
          status: UserStatus.ACTIVE,
          deniedPermissionGroups: denied,
        },
      });
    };
    const stored = (id: string) =>
      prisma.user.findUniqueOrThrow({
        where: { id },
        select: { role: true, deniedPermissionGroups: true, permissionsVersion: true },
      });
    const update = (id: string, dto: Record<string, unknown>) =>
      ctx.run(tenantId, () => users.updateUser(id, dto as never, "admin", UserRole.TENANT_ADMIN));

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      ctx = new TenantContextService();
      prisma = new PrismaService(ctx);
      await prisma.$connect();
      const email = {
        sendEmailChangedNotice: jest.fn().mockResolvedValue({ delivered: true }),
        sendEmailChangeConfirmation: jest.fn().mockResolvedValue({ delivered: true }),
        send: jest.fn().mockResolvedValue(undefined),
      };
      users = new UsersService(prisma, email as never, { get: () => undefined } as never);
      const slug = assertTestTenant(`qa-opentry-${RUN}`, SPEC);
      tenantId = (await prisma.tenant.create({ data: { slug, name: `Operator entry ${slug}` } }))
        .id;
    }, 120_000);

    afterAll(async () => {
      if (tenantId) {
        await prisma.passwordResetToken.deleteMany({ where: { user: { tenantId } } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma?.$disconnect();
    }, 120_000);

    it("A5-1: DRIVER with {} moved to OPERATOR ends with {BAD_DEBT} and the version up by one", async () => {
      const u = await mkUser(UserRole.DRIVER, []);
      const before = await stored(u.id);
      await update(u.id, { role: UserRole.OPERATOR });
      const after = await stored(u.id);
      expect(after.role).toBe(UserRole.OPERATOR);
      expect(after.deniedPermissionGroups).toEqual([BAD_DEBT]);
      expect(after.permissionsVersion).toBe(before.permissionsVersion + 1);
    });

    it("A5-2: CUSTOMER with {} moved to OPERATOR ends with {BAD_DEBT} and the version up by one", async () => {
      const u = await mkUser(UserRole.CUSTOMER, []);
      const before = await stored(u.id);
      await update(u.id, { role: UserRole.OPERATOR });
      const after = await stored(u.id);
      expect(after.role).toBe(UserRole.OPERATOR);
      expect(after.deniedPermissionGroups).toEqual([BAD_DEBT]);
      expect(after.permissionsVersion).toBe(before.permissionsVersion + 1);
    });

    it("A5-3: DRIVER already denying BAD_DEBT moved to OPERATOR keeps one BAD_DEBT, version unchanged", async () => {
      const u = await mkUser(UserRole.DRIVER, [BAD_DEBT]);
      const before = await stored(u.id);
      await update(u.id, { role: UserRole.OPERATOR });
      const after = await stored(u.id);
      expect(after.role).toBe(UserRole.OPERATOR);
      expect(after.deniedPermissionGroups).toEqual([BAD_DEBT]);
      expect(after.permissionsVersion).toBe(before.permissionsVersion);
    });

    it("A5-4: OPERATOR with {BAD_DEBT} moved to DRIVER keeps the list and the version", async () => {
      const u = await mkUser(UserRole.OPERATOR, [BAD_DEBT]);
      const before = await stored(u.id);
      await update(u.id, { role: UserRole.DRIVER });
      const after = await stored(u.id);
      expect(after.role).toBe(UserRole.DRIVER);
      expect(after.deniedPermissionGroups).toEqual(before.deniedPermissionGroups);
      expect(after.permissionsVersion).toBe(before.permissionsVersion);
    });

    it("A5-5: OPERATOR with {} given an email edit only keeps the list and the version", async () => {
      const u = await mkUser(UserRole.OPERATOR, []);
      const before = await stored(u.id);
      await update(u.id, { email: `edited-${RUN}-${n}@example.invalid` });
      const after = await stored(u.id);
      expect(after.role).toBe(UserRole.OPERATOR);
      expect(after.deniedPermissionGroups).toEqual([]);
      expect(after.permissionsVersion).toBe(before.permissionsVersion);
    });
  },
);
