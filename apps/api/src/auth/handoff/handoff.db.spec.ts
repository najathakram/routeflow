/**
 * #2653 (SA-542a/b) sign-in handoff over a REAL Postgres, both realms. Drives the real
 * HandoffCodeService, StaffHandoffService, BuyerHandoffService and BuyerAuthService (real
 * JwtService, real BuyerRefreshToken rows). Only AuthService.login is stubbed for the staff pair
 * (the staff mint path is login() itself, pinned by its own specs); everything that touches the
 * AuthHandoffCode table is real. Throwaway `qa-*` tenants (assertTestTenant); afterAll deletes
 * everything it made.
 */
import { randomUUID } from "crypto";
import { PrismaClient, TenantClass, TenantStatus, UserRole } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { JwtService } from "@nestjs/jwt";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { hashSignedToken, mintSignedToken } from "../../common/signed-token";
import { HandoffCodeService } from "./handoff-code.service";
import { withReadBarrier } from "./read-barrier";
import { StaffHandoffService } from "./staff-handoff.service";
import { BuyerHandoffService } from "../../buyer/buyer-handoff.service";
import { BuyerAuthService } from "../../buyer/buyer-auth.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const SECRET = "d".repeat(48);

describeDb("#2653 sign-in handoff — both realms (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let codes: HandoffCodeService;
  let staff: StaffHandoffService;
  let buyer: BuyerHandoffService;
  const login = jest.fn(async () => ({
    accessToken: `A-${randomUUID()}`,
    refreshToken: `R-${randomUUID()}`,
    user: {},
  }));
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const buyerIds: string[] = [];
  const OLD = process.env.HANDOFF_TOKEN_SECRET;

  beforeAll(async () => {
    process.env.HANDOFF_TOKEN_SECRET = SECRET;
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    codes = new HandoffCodeService(prisma as any);
    staff = new StaffHandoffService(codes, prisma as any, { login } as any);
    const jwtConfig = {
      secret: "j".repeat(40),
      refreshSecret: "k".repeat(40),
      expiresIn: "15m",
      refreshExpiresIn: "7d",
    };
    const buyerAuth = new BuyerAuthService(
      prisma as any,
      new JwtService({}),
      { get: () => jwtConfig } as any,
      {} as any, // email (unused)
      {} as any, // appleOAuth (unused by the handoff exchange)
    );
    buyer = new BuyerHandoffService(codes, prisma as any, buyerAuth);
  });

  afterAll(async () => {
    await prisma.authHandoffCode.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { buyerAccountId: { in: buyerIds } }] },
    });
    await prisma.buyerRefreshToken.deleteMany({ where: { buyerAccountId: { in: buyerIds } } });
    await prisma.buyerAccount.deleteMany({ where: { id: { in: buyerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma?.$disconnect();
    await pool?.end();
    if (OLD === undefined) delete process.env.HANDOFF_TOKEN_SECRET;
    else process.env.HANDOFF_TOKEN_SECRET = OLD;
  });

  let seq = 0;
  async function tenant(): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(`qa-h2653-${run}-${seq}`, "handoff.db.spec.ts");
    const t = await prisma.tenant.create({
      data: { slug, name: slug, class: TenantClass.PRODUCTION, status: TenantStatus.ACTIVE },
    });
    tenantIds.push(t.id);
    return t.id;
  }
  async function operator(tenantId: string, role: UserRole = UserRole.OPERATOR) {
    const u = await prisma.user.create({
      data: {
        tenantId,
        username: `op-${run}-${++seq}`,
        email: `op-${run}-${seq}@acme.test`,
        role,
        status: "ACTIVE",
      } as any,
    });
    userIds.push(u.id);
    return u;
  }
  async function buyerAccount() {
    const b = await prisma.buyerAccount.create({
      data: {
        email: `buyer-${run}-${++seq}@acme.test`,
        name: "Acme Buyer",
        passwordHash: "x",
        status: "ACTIVE",
      } as any,
    });
    buyerIds.push(b.id);
    return b;
  }
  const staffJwt = (u: { id: string; role: UserRole; tenantId: string | null }) =>
    ({ sub: u.id, role: u.role, tenantId: u.tenantId, username: "op" }) as never;

  it("staff: one row, sha256 only; exchange once; the second exchange is 401 and the row is gone", async () => {
    const t = await tenant();
    const u = await operator(t);
    const { code } = await staff.mint(staffJwt(u), "ios-1");
    const rows = await prisma.authHandoffCode.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenHash: hashSignedToken(code),
      realm: "STAFF",
      tenantId: t,
    });
    expect(rows[0].buyerAccountId).toBeNull();

    await expect(staff.exchange(code, {})).resolves.toMatchObject({ realm: "STAFF" });
    expect(login).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: u.id }),
      expect.objectContaining({ deviceName: "hybrid-shell:ios-1" }),
    );
    await expect(staff.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(await prisma.authHandoffCode.count({ where: { userId: u.id } })).toBe(0);
  });

  it("single use under a FORCED interleave: both exchanges read the row before either deletes it, exactly one succeeds", async () => {
    const t = await tenant();
    const u = await operator(t);
    const { code } = await staff.mint(staffJwt(u), "ios-race");
    // Each consume's findFirst does its real read, then waits until the other has read too, so both
    // reach deleteMany holding the row; only the `count === 1` check separates one winner from two.
    const gatedCodes = new HandoffCodeService({
      authHandoffCode: withReadBarrier(prisma.authHandoffCode as never, 2),
    } as never);
    const gatedStaff = new StaffHandoffService(gatedCodes, prisma as any, { login } as any);
    login.mockClear();
    const results = await Promise.allSettled([
      gatedStaff.exchange(code, {}),
      gatedStaff.exchange(code, {}),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(login).toHaveBeenCalledTimes(1);
    expect(await prisma.authHandoffCode.count({ where: { userId: u.id } })).toBe(0);
  });

  it("TTL: a row past its expiresAt is refused (and left for the next mint to clear)", async () => {
    const t = await tenant();
    const u = await operator(t);
    const { code } = await staff.mint(staffJwt(u), "ios-ttl");
    await prisma.authHandoffCode.update({
      where: { tokenHash: hashSignedToken(code) },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(staff.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    // The next mint for the same user clears the expired row.
    await staff.mint(staffJwt(u), "ios-ttl-2");
    const left = await prisma.authHandoffCode.findMany({ where: { userId: u.id } });
    expect(left.map((r) => r.deviceId)).toEqual(["ios-ttl-2"]);
  });

  it("a forged code (right shape, wrong secret) is 401 and no row is read or written", async () => {
    const before = await prisma.authHandoffCode.count();
    await expect(staff.exchange(mintSignedToken("z".repeat(48)), {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(await prisma.authHandoffCode.count()).toBe(before);
  });

  it("cross-tenant: a user moved to another tenant after the mint is refused", async () => {
    const t1 = await tenant();
    const t2 = await tenant();
    const u = await operator(t1);
    const { code } = await staff.mint(staffJwt(u), "ios-x");
    await prisma.user.update({ where: { id: u.id }, data: { tenantId: t2 } });
    login.mockClear();
    await expect(staff.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(login).not.toHaveBeenCalled();
  });

  it("cross-realm: a STAFF code at the buyer exchange is 401 and the row survives", async () => {
    const t = await tenant();
    const u = await operator(t);
    const { code } = await staff.mint(staffJwt(u), "ios-realm");
    await expect(buyer.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(await prisma.authHandoffCode.count({ where: { userId: u.id } })).toBe(1);
    await expect(staff.exchange(code, {})).resolves.toMatchObject({ realm: "STAFF" });
  });

  it("buyer: bound to the account (tenantId null); the exchange issues a NEW buyer refresh row", async () => {
    const b = await buyerAccount();
    const app = await buyer.mint({ sub: b.id, type: "BUYER" } as never, "ios-b");
    const row = await prisma.authHandoffCode.findUniqueOrThrow({
      where: { tokenHash: hashSignedToken(app.code) },
    });
    expect(row).toMatchObject({
      realm: "BUYER",
      buyerAccountId: b.id,
      userId: null,
      tenantId: null,
    });

    const before = await prisma.buyerRefreshToken.findMany({ where: { buyerAccountId: b.id } });
    const out = await buyer.exchange(app.code, { userAgent: "RouteFlowShell/1" });
    expect(out).toMatchObject({ realm: "BUYER", buyer: { id: b.id } });
    const after = await prisma.buyerRefreshToken.findMany({ where: { buyerAccountId: b.id } });
    expect(after).toHaveLength(before.length + 1);
    const fresh = after.find((r) => !before.some((x) => x.tokenHash === r.tokenHash))!;
    expect(fresh.tokenHash).toBe(hashSignedToken(out.refreshToken));
    expect(fresh.deviceName).toBe("hybrid-shell:ios-b");
  });

  it("a BUYER code at the staff exchange is 401 and writes nothing", async () => {
    const b = await buyerAccount();
    const { code } = await buyer.mint({ sub: b.id, type: "BUYER" } as never, "ios-b2");
    await expect(staff.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(await prisma.authHandoffCode.count({ where: { buyerAccountId: b.id } })).toBe(1);
  });

  it("deleting the user cascades its pending codes", async () => {
    const t = await tenant();
    const u = await operator(t);
    await staff.mint(staffJwt(u), "ios-del");
    await prisma.user.delete({ where: { id: u.id } });
    expect(await prisma.authHandoffCode.count({ where: { userId: u.id } })).toBe(0);
  });
});
