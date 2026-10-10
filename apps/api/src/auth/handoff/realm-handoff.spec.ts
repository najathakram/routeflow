/**
 * #2653 (SA-542a/b): both realms' mint + exchange over the REAL HandoffCodeService (fake DB),
 * red-first.
 */
import { UnauthorizedException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { HandoffCodeService } from "./handoff-code.service";
import { StaffHandoffService } from "./staff-handoff.service";
import { BuyerHandoffService } from "../../buyer/buyer-handoff.service";

const SECRET = "h".repeat(40);

function db() {
  const rows: Array<Record<string, unknown>> = [];
  const match = (r: Record<string, unknown>, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const c = v as { gt?: Date; lte?: Date };
        if (c.gt) return (r[k] as Date) > c.gt;
        if (c.lte) return (r[k] as Date) <= c.lte;
      }
      return r[k] === v;
    });
  return {
    rows,
    authHandoffCode: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        rows.push({ ...data }),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => match(r, where)) ?? null,
      ),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1);
        return { count: before - rows.length };
      }),
    },
    buyerAccount: { findUnique: jest.fn() },
  };
}

const staffJwt = (over: Record<string, unknown> = {}) =>
  ({ sub: "u1", role: UserRole.OPERATOR, tenantId: "t1", username: "op", ...over }) as never;
const staffUser = (over: Record<string, unknown> = {}) => ({
  id: "u1",
  role: UserRole.OPERATOR,
  tenantId: "t1",
  status: "ACTIVE",
  deletedAt: null,
  lockedUntil: null,
  ...over,
});

describe("#2653 staff realm", () => {
  const OLD = process.env.HANDOFF_TOKEN_SECRET;
  beforeEach(() => (process.env.HANDOFF_TOKEN_SECRET = SECRET));
  afterEach(() => {
    if (OLD === undefined) delete process.env.HANDOFF_TOKEN_SECRET;
    else process.env.HANDOFF_TOKEN_SECRET = OLD;
  });

  function staff(userOver: Record<string, unknown> = {}) {
    const prisma = db();
    const codes = new HandoffCodeService(prisma as never);
    const users = { user: { findUnique: jest.fn().mockResolvedValue(staffUser(userOver)) } };
    const auth = {
      login: jest.fn().mockResolvedValue({ accessToken: "A2", refreshToken: "R2", user: {} }),
    };
    const svc = new StaffHandoffService(codes, users as never, auth as never);
    return { prisma, svc, auth, users };
  }

  it.each([UserRole.SUPER_ADMIN, UserRole.DRIVER, UserRole.CUSTOMER])(
    "%s cannot mint (403 HANDOFF_ROLE_NOT_ALLOWED)",
    async (role) => {
      const { svc, prisma } = staff();
      await expect(svc.mint(staffJwt({ role }), "d1")).rejects.toMatchObject({
        response: { code: "HANDOFF_ROLE_NOT_ALLOWED", statusCode: 403 },
      });
      expect(prisma.authHandoffCode.create).not.toHaveBeenCalled();
    },
  );

  it("an impersonation session cannot mint", async () => {
    const { svc } = staff();
    await expect(svc.mint(staffJwt({ impersonatedBy: "sa-1" }), "d1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("OPERATOR and TENANT_ADMIN mint; the exchange returns a FRESH pair named hybrid-shell", async () => {
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN]) {
      const { svc, auth } = staff({ role });
      const { code } = await svc.mint(staffJwt({ role }), "ios-1");
      const out = await svc.exchange(code, {
        userAgent: "RouteFlowShell/1",
        ipAddress: "10.0.0.1",
      });
      expect(out).toMatchObject({ realm: "STAFF", accessToken: "A2", refreshToken: "R2" });
      expect(auth.login).toHaveBeenCalledWith(
        expect.objectContaining({ id: "u1" }),
        expect.objectContaining({
          deviceName: "hybrid-shell:ios-1",
          userAgent: "RouteFlowShell/1",
        }),
      );
    }
  });

  it.each([
    ["moved to another tenant", { tenantId: "t2" }],
    ["deactivated", { status: "INACTIVE" }],
    ["deleted", { deletedAt: new Date() }],
    ["locked", { lockedUntil: new Date(Date.now() + 7 * 86_400_000) }],
    ["demoted to DRIVER", { role: UserRole.DRIVER }],
  ])("a user %s since the mint is the same 401", async (_why, over) => {
    const { svc, auth, users } = staff();
    const { code } = await svc.mint(staffJwt(), "d1");
    users.user.findUnique.mockResolvedValue(staffUser(over));
    await expect(svc.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("a code minted by a buyer is refused at the staff exchange (realm in the where)", async () => {
    const prisma = db();
    const codes = new HandoffCodeService(prisma as never);
    const buyer = new BuyerHandoffService(codes, prisma as never, {} as never);
    const { code } = await buyer.mint({ sub: "b1", type: "BUYER" } as never, "d1");
    const auth = { login: jest.fn() };
    const svc = new StaffHandoffService(
      codes,
      { user: { findUnique: jest.fn() } } as never,
      auth as never,
    );
    await expect(svc.exchange(code, {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.rows).toHaveLength(1); // untouched
    expect(auth.login).not.toHaveBeenCalled();
  });
});

describe("#2653 buyer realm", () => {
  const OLD = process.env.HANDOFF_TOKEN_SECRET;
  beforeEach(() => (process.env.HANDOFF_TOKEN_SECRET = SECRET));
  afterEach(() => {
    if (OLD === undefined) delete process.env.HANDOFF_TOKEN_SECRET;
    else process.env.HANDOFF_TOKEN_SECRET = OLD;
  });

  function buyer(accountOver: Record<string, unknown> = {}) {
    const prisma = db();
    prisma.buyerAccount.findUnique.mockResolvedValue({
      id: "b1",
      email: "buyer@acme.test",
      name: "Acme Buyer",
      passwordSet: true,
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      ...accountOver,
    });
    const codes = new HandoffCodeService(prisma as never);
    const buyerAuth = {
      issueHandoffPair: jest
        .fn()
        .mockResolvedValue({ accessToken: "BA2", refreshToken: "BR2", buyer: {} }),
    };
    return {
      prisma,
      buyerAuth,
      svc: new BuyerHandoffService(codes, prisma as never, buyerAuth as never),
    };
  }

  it("binds to the BuyerAccount alone (tenantId null)", async () => {
    const { svc, prisma } = buyer();
    await svc.mint({ sub: "b1", type: "BUYER" } as never, "d1");
    expect(prisma.rows[0]).toMatchObject({
      realm: "BUYER",
      buyerAccountId: "b1",
      userId: null,
      tenantId: null,
    });
  });

  it("an impersonated buyer session cannot mint", async () => {
    const { svc, prisma } = buyer();
    await expect(
      svc.mint({ sub: "b1", type: "BUYER", impersonatedBy: "sa-1" } as never, "d1"),
    ).rejects.toMatchObject({ response: { code: "HANDOFF_ROLE_NOT_ALLOWED" } });
    expect(prisma.authHandoffCode.create).not.toHaveBeenCalled();
  });

  it("exchange mints a FRESH buyer pair named hybrid-shell", async () => {
    const { svc, buyerAuth } = buyer();
    const { code } = await svc.mint({ sub: "b1", type: "BUYER" } as never, "ios-9");
    await expect(svc.exchange(code, {})).resolves.toMatchObject({
      realm: "BUYER",
      accessToken: "BA2",
    });
    expect(buyerAuth.issueHandoffPair).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b1" }),
      expect.objectContaining({ deviceName: "hybrid-shell:ios-9" }),
    );
  });

  it.each([
    ["suspended", { status: "SUSPENDED" }],
    ["deleted", { deletedAt: new Date() }],
    ["locked", { lockedUntil: new Date(Date.now() + 7 * 86_400_000) }],
  ])("a %s account is the same 401", async (_why, over) => {
    const { svc, buyerAuth } = buyer(over);
    const { code } = await svc.mint({ sub: "b1", type: "BUYER" } as never, "d1");
    await expect(svc.exchange(code, {})).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(buyerAuth.issueHandoffPair).not.toHaveBeenCalled();
  });
});
