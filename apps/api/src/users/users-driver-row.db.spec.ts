/**
 * B862 / SA-1171 K5 (b)(c)(d) — real Postgres, run by the prover on the compose DB (never by the builder): the
 * Driver row follows the role. (b) operator -> DRIVER writes one ACTIVE row; (c) DRIVER -> operator sets it INACTIVE,
 * or is a coded 409 with a SCHEDULED run; (d) two concurrent driver-permit enables leave one row and no error.
 *
 * Run via `npm run local:test:db`. The tenant is a throwaway `qa-drvrow-<run>` slug approved by `assertTestTenant`;
 * afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "./users.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "users-driver-row.db.spec.ts";
const RUN = randomUUID().slice(0, 8);

describeDb("users: the Driver row follows the role (B862, SA-1171)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let users: UsersService;
  let tenantId: string;
  let n = 0;

  const mkUser = (role: UserRole) => {
    const name = `u${++n}-${RUN}`;
    return prisma.user.create({
      data: {
        tenantId,
        username: name,
        email: `${name}@example.invalid`,
        role,
        status: UserStatus.ACTIVE,
        deniedPermissionGroups: [],
      },
    });
  };
  const rows = (userId: string) => prisma.driver.findMany({ where: { userId } });
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
    const slug = assertTestTenant(`qa-drvrow-${RUN}`, SPEC);
    tenantId = (await prisma.tenant.create({ data: { slug, name: `Driver row ${slug}` } })).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.routeRun.deleteMany({ where: { tenantId } });
      await prisma.route.deleteMany({ where: { tenantId } }); // the 409 case makes a route
      await prisma.driver.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.passwordResetToken.deleteMany({ where: { user: { tenantId } } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  });

  it("(b) operator -> DRIVER writes one ACTIVE Driver row", async () => {
    const u = await mkUser(UserRole.OPERATOR);
    await update(u.id, { role: UserRole.DRIVER });
    const r = await rows(u.id);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("ACTIVE");
  });

  it("(c) DRIVER -> operator sets the row INACTIVE", async () => {
    const u = await mkUser(UserRole.OPERATOR);
    await update(u.id, { role: UserRole.DRIVER });
    await update(u.id, { role: UserRole.OPERATOR });
    const r = await rows(u.id);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("INACTIVE");
  });

  it("(c) DRIVER -> operator with a SCHEDULED run is a coded 409 and nothing changes", async () => {
    const u = await mkUser(UserRole.OPERATOR);
    await update(u.id, { role: UserRole.DRIVER });
    const [d] = await rows(u.id);
    const route = await prisma.route.create({
      data: { tenantId, name: `Acme route ${RUN}` } as never,
    });
    await prisma.routeRun.create({
      data: {
        tenantId,
        routeId: route.id,
        driverId: d.id,
        scheduledDate: new Date(),
        status: "SCHEDULED",
      } as never,
    });
    await expect(update(u.id, { role: UserRole.OPERATOR })).rejects.toMatchObject({
      response: { code: "DRIVER_HAS_OPEN_RUN" },
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe(
      UserRole.DRIVER,
    );
    expect((await rows(u.id))[0].status).toBe("ACTIVE");
  });

  it("(e) a CUSTOMER login refuses a staff role: 400, role unchanged, no Driver row", async () => {
    const u = await mkUser(UserRole.CUSTOMER);
    await expect(update(u.id, { role: UserRole.DRIVER })).rejects.toMatchObject({ status: 400 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe(
      UserRole.CUSTOMER,
    );
    expect(await rows(u.id)).toHaveLength(0);
  });

  /** A buyer's login: a CUSTOMER user with its Customer row, moved to OPERATOR (legal, SA-1050 A5-2). */
  const mkBuyerNowOperator = async () => {
    const u = await mkUser(UserRole.CUSTOMER);
    await prisma.customer.create({
      data: {
        tenantId,
        userId: u.id,
        businessName: `Acme buyer ${u.username}`,
        contactName: "Pat",
      },
    });
    await update(u.id, { role: UserRole.OPERATOR });
    return u;
  };

  it("(f) a buyer's login moved to OPERATOR, then to DRIVER: 400, no Driver row, role stays OPERATOR", async () => {
    const u = await mkBuyerNowOperator();
    await expect(update(u.id, { role: UserRole.DRIVER })).rejects.toMatchObject({ status: 400 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).role).toBe(
      UserRole.OPERATOR,
    );
    expect(await rows(u.id)).toHaveLength(0);
  });

  it("(g) the same login with the driver permit enabled: 400 and no Driver row", async () => {
    const u = await mkBuyerNowOperator();
    await expect(
      ctx.run(tenantId, () => users.toggleDriverPermit(u.id, UserRole.TENANT_ADMIN)),
    ).rejects.toMatchObject({ status: 400 });
    expect(await rows(u.id)).toHaveLength(0);
  });

  it("(d) two concurrent permit enables leave one row and no error", async () => {
    const u = await mkUser(UserRole.OPERATOR);
    const toggle = () =>
      ctx.run(tenantId, () => users.toggleDriverPermit(u.id, UserRole.TENANT_ADMIN));
    const out = await Promise.allSettled([toggle(), toggle()]);
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await rows(u.id)).toHaveLength(1);
  });
});
