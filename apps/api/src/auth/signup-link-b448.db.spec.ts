/**
 * B448, real Postgres: a TENANT_ADMIN another admin deactivated, who never signed in, cannot get back in through the
 * sign-up verification link (resend or an old link). A pending sign-up still can, once.
 *
 * Why a DB spec: the link row is written and claimed with raw SQL through the REAL tenant transaction proxy and a
 * plain transaction (the typed client would throw `Unknown argument tenantId`, SA-1096), and the deactivation burns
 * the row in its own transaction. Mocks prove none of that.
 *
 * Run via `npm run local:test:db`. Throwaway `qa-b448-<run>` tenants (approved by `assertTestTenant`); afterAll
 * deletes exactly what it made. Registration itself refuses test slugs (row 195), so the sign-up's link row is
 * written with the same helper `register()` calls.
 */
import { randomUUID } from "crypto";
import { JwtService } from "@nestjs/jwt";
import { UserRole, UserStatus } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { UsersService } from "../users/users.service";
import { TenantsService } from "../tenants/tenants.service";
import { AuthService } from "./auth.service";
import { issueSignupLink } from "./verification-link-eligibility";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "signup-link-b448.db.spec.ts";
const RUN = randomUUID().slice(0, 8);
const SECRET = "qa-b448-secret-0123456789-abcdefghijklmnop";

describeDb("B448: the sign-up verification link on a real database", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let users: UsersService;
  let tenants: TenantsService;
  let auth: AuthService;
  const tenantIds: string[] = [];
  let mailed: string[] = [];
  let seq = 0;

  const mkTenant = async (tag: string) => {
    const slug = assertTestTenant(`qa-b448-${RUN}-${tag}`, SPEC);
    const id = (await prisma.tenant.create({ data: { slug, name: slug } })).id;
    tenantIds.push(id);
    return id;
  };
  const mkUser = (tenantId: string, name: string, status: UserStatus, createdAt?: Date) =>
    prisma.user.create({
      data: {
        ...(createdAt ? { createdAt } : {}),
        tenantId,
        username: `${name}_${RUN}_${++seq}`,
        email: `${name}-${RUN}-${seq}@example.invalid`,
        role: UserRole.TENANT_ADMIN,
        status,
      },
    });
  /** The token from the last mailed verification link. */
  const lastLinkToken = () => {
    const html = mailed[mailed.length - 1] ?? "";
    return html.match(/token=([\w-]+\.[\w-]+\.[\w-]+)/)?.[1] ?? "";
  };
  const liveRows = (userId: string) =>
    prisma.userEmailVerificationToken.count({ where: { userId, usedAt: null } });

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const email = {
      send: async (m: { html: string }) => {
        mailed.push(m.html);
        return { delivered: true, transport: "test" };
      },
    };
    const jwtConfig = {
      secret: SECRET,
      refreshSecret: "rs",
      expiresIn: "15m",
      refreshExpiresIn: "30d",
    };
    const config = {
      get: (k: string) =>
        k === "jwt"
          ? jwtConfig
          : k === "jwt.secret"
            ? SECRET
            : k === "WEB_URL"
              ? "https://web.test"
              : { web: "https://web.test", mobileWeb: "https://mobile.test" },
    };
    const jwt = new JwtService({ secret: SECRET });
    users = new UsersService(prisma, email as never, config as never);
    tenants = new TenantsService(
      prisma,
      {} as never,
      {} as never,
      email as never,
      config as never,
      jwt,
    );
    auth = new AuthService(
      prisma,
      {} as never,
      jwt,
      config as never,
      email as never,
      {
        claimsFor: async () => null,
      } as never,
    );
  }, 120_000);

  beforeEach(() => {
    mailed = [];
  });

  afterAll(async () => {
    for (const id of tenantIds) {
      await prisma.refreshToken.deleteMany({ where: { user: { tenantId: id } } });
      await prisma.auditLog.deleteMany({ where: { tenantId: id } });
      await prisma.user.deleteMany({ where: { tenantId: id } }); // link rows cascade
      await prisma.tenant.deleteMany({ where: { id } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  it("REG-B448: an admin another admin deactivated, never signed in, gets no link and stays INACTIVE", async () => {
    const tenantId = await mkTenant("a");
    const keeper = await mkUser(tenantId, "keeper", UserStatus.ACTIVE);
    const target = await mkUser(tenantId, "target", UserStatus.ACTIVE);
    await ctx.run(tenantId, () =>
      users.changeStatus(
        target.id,
        { status: UserStatus.INACTIVE },
        UserRole.TENANT_ADMIN,
        keeper.id,
      ),
    );

    expect(await tenants.resendVerification(target.email)).toBe(false);
    expect(mailed).toHaveLength(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      UserStatus.INACTIVE,
    );
  });

  it("REG-B448: a pending sign-up another admin deactivated loses its link: the old link and a resend are refused", async () => {
    const tenantId = await mkTenant("b");
    const keeper = await mkUser(tenantId, "keeper", UserStatus.ACTIVE);
    const pending = await mkUser(tenantId, "pending", UserStatus.INACTIVE);
    await issueSignupLink(prisma, pending.id);
    expect(await tenants.resendVerification(pending.email)).toBe(true);
    const oldLink = lastLinkToken();
    expect(oldLink).not.toBe("");

    await ctx.run(tenantId, () =>
      users.changeStatus(
        pending.id,
        { status: UserStatus.INACTIVE },
        UserRole.TENANT_ADMIN,
        keeper.id,
      ),
    );
    expect(await liveRows(pending.id)).toBe(0);

    await expect(auth.verifyEmailAndLogin(oldLink)).rejects.toMatchObject({ status: 400 });
    mailed = [];
    expect(await tenants.resendVerification(pending.email)).toBe(false);
    expect(mailed).toHaveLength(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
      UserStatus.INACTIVE,
    );
  });

  it("a pending sign-up alone in its business: resend rotates the row, the new link verifies once, the old one never", async () => {
    const tenantId = await mkTenant("c");
    const pending = await mkUser(tenantId, "solo", UserStatus.INACTIVE);
    await issueSignupLink(prisma, pending.id);
    expect(await tenants.resendVerification(pending.email)).toBe(true);
    const first = lastLinkToken();
    expect(await tenants.resendVerification(pending.email)).toBe(true);
    const second = lastLinkToken();
    expect(await liveRows(pending.id)).toBe(1);

    await expect(auth.verifyEmailAndLogin(first)).rejects.toMatchObject({ status: 400 });
    await expect(auth.verifyEmailAndLogin(second)).resolves.toHaveProperty("accessToken");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
      UserStatus.ACTIVE,
    );
    expect(await liveRows(pending.id)).toBe(0);
    await expect(auth.verifyEmailAndLogin(second)).rejects.toMatchObject({ status: 400 });
  });

  it("legacy: a row-less sign-up alone in its business can resend, which writes its first live row", async () => {
    const tenantId = await mkTenant("d");
    // a fixed date inside the legacy window, never the real clock (L-353)
    const pending = await mkUser(
      tenantId,
      "legacy",
      UserStatus.INACTIVE,
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(await tenants.resendVerification(pending.email)).toBe(true);
    expect(await liveRows(pending.id)).toBe(1);
    await expect(auth.verifyEmailAndLogin(lastLinkToken())).resolves.toHaveProperty("accessToken");
  });
});
