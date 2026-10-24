/**
 * SA #3412 must 3 — real Postgres: two tenant admins deactivate EACH OTHER at the same moment. The active-admin
 * rows are read FOR UPDATE inside the write's transaction, so the two writes serialize: exactly one goes through
 * and the other is refused with LAST_TENANT_ADMIN. The workspace keeps exactly one active admin.
 *
 * A read barrier makes the race deterministic: after its admin read, each transaction waits (up to 1 s) for the
 * other's read. With the row lock the second read blocks until the first commits, so the barrier times out and
 * the writes serialize; without it both reads see two admins and both writes land (proved red that way).
 *
 * Run via `npm run local:test:db`. The tenant is a throwaway `qa-lastadmin-<run>` slug approved by
 * `assertTestTenant`, and afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "./users.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "users-last-admin.db.spec.ts";
const RUN = randomUUID().slice(0, 8);

describeDb("users: the last active admin survives a cross-deactivation race", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let users: UsersService;
  let tenantId: string;

  const mkAdmin = (name: string) =>
    prisma.user.create({
      data: {
        tenantId,
        username: `${name}-${RUN}`,
        email: `${name}-${RUN}@example.invalid`,
        role: UserRole.TENANT_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    users = new UsersService(prisma, {} as never, { get: () => ({}) } as never);
    const slug = assertTestTenant(`qa-lastadmin-${RUN}`, SPEC);
    tenantId = (await prisma.tenant.create({ data: { slug, name: `Last admin ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  /** Hold every admin read until `parties` reads have returned, or `maxMs` passes. */
  const installReadBarrier = (parties: number, maxMs: number) => {
    let arrived = 0;
    let release!: () => void;
    const allArrived = new Promise<void>((r) => (release = r));
    const original = prisma.tenantTransaction.bind(prisma);
    jest.spyOn(prisma, "tenantTransaction").mockImplementation(((
      fn: (tx: any) => Promise<unknown>,
      opts?: any,
    ) =>
      original(
        (tx: any) =>
          fn(
            new Proxy(tx, {
              get(target, key, recv) {
                if (key !== "$queryRaw") return Reflect.get(target, key, recv);
                return async (...args: unknown[]) => {
                  const rows = await target.$queryRaw(...args);
                  if (++arrived >= parties) release();
                  await Promise.race([allArrived, new Promise((r) => setTimeout(r, maxMs))]);
                  return rows;
                };
              },
            }),
          ),
        opts,
      )) as never);
  };

  it("two admins deactivating each other at once: one passes, one gets LAST_TENANT_ADMIN", async () => {
    const a = await mkAdmin("admin-a");
    const b = await mkAdmin("admin-b");
    installReadBarrier(2, 1_000);
    const results = await ctx.run(tenantId, () =>
      Promise.allSettled([
        users.changeStatus(b.id, { status: UserStatus.INACTIVE }, UserRole.TENANT_ADMIN, a.id),
        users.changeStatus(a.id, { status: UserStatus.INACTIVE }, UserRole.TENANT_ADMIN, b.id),
      ]),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    expect((refused[0].reason as ConflictException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.LAST_TENANT_ADMIN,
    });
    const active = await prisma.user.count({
      where: { tenantId, role: UserRole.TENANT_ADMIN, status: UserStatus.ACTIVE },
    });
    expect(active).toBe(1);
  });
});
