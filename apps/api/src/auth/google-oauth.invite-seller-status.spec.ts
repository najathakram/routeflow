import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Logger } from "@nestjs/common";
import { GoogleOAuthService } from "./google-oauth.service";
import { AuthController } from "./auth.controller";
import { PlatformGoogleAuthController } from "./platform-google-auth.controller";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(),
}));

/**
 * The invite acceptance on the Google callback follows the seller's workspace status, through the SAME rule the
 * buyer routes use (buyer/seller-status-gate.ts): a suspended or cancelled seller is refused, a read-only seller
 * follows SELLER_READ_ONLY_BUYER_GATE (dark: allowed + would-deny line; enforced: refused). A refusal skips only the
 * link: nothing is written to it, the invite token stays on the row (so it can be accepted after reactivation), the
 * sign-in itself completes, and the bundle says `linked: "false"` plus `invite: "seller_unavailable"`.
 */

const profile = {
  type: "tenant" as const,
  context: "buyer-standalone" as const,
  googleId: "google-1",
  email: "buyer@example.test",
  name: "Buyer",
  inviteToken: "tok-invite",
};

const inviteRow = (sellerStatus: string) => ({
  id: "link-1",
  tenantId: "tn-1",
  inviteToken: "tok-invite",
  status: "INVITED",
  inviteExpiresAt: null,
  customer: { id: "c-1", deletedAt: null },
  tenant: { id: "tn-1", status: sellerStatus },
});

function boot(sellerStatus: string) {
  const prisma = createMockPrisma();
  prisma.buyerAccount.findFirst.mockResolvedValue({
    id: "buyer-1",
    email: "buyer@example.test",
    name: "Buyer",
    googleId: "google-1",
    passwordSet: true,
    emailVerified: true,
    status: "ACTIVE",
    deletedAt: null,
  } as any);
  prisma.customerLink.count.mockResolvedValue(0 as any);
  prisma.buyerRefreshToken.upsert.mockResolvedValue({} as any);
  const row = inviteRow(sellerStatus);
  prisma.customerLink.findFirst.mockImplementation((async (args: any) =>
    args?.where?.inviteToken === row.inviteToken ? row : null) as any);
  const service = new GoogleOAuthService(
    prisma as any,
    {
      sign: jest.fn().mockReturnValue("tok"),
      decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService,
    {
      get: (key: string) =>
        key === "jwt"
          ? {
              secret: "test-jwt-secret-0123456789-abcdefghijklmnop",
              refreshSecret: "rs",
              expiresIn: "15m",
              refreshExpiresIn: "30d",
            }
          : undefined,
    } as unknown as ConfigService,
    { send: jest.fn().mockResolvedValue(undefined) } as any,
    { claimsFor: jest.fn().mockResolvedValue(null) } as any,
  );
  return { prisma, service };
}

describe("Google callback invite acceptance follows the seller's workspace status", () => {
  const saved = process.env.SELLER_READ_ONLY_BUYER_GATE;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.SELLER_READ_ONLY_BUYER_GATE;
    else process.env.SELLER_READ_ONLY_BUYER_GATE = saved;
  });
  const wouldDeny = () =>
    warn.mock.calls.map((c: any[]) => String(c[0])).filter((l: string) => /would_deny/.test(l));

  const refusedCases: Array<[string, string | undefined]> = [
    ["SUSPENDED", undefined],
    ["CANCELLED", undefined],
    ["READ_ONLY", "enforced"],
  ];

  it.each(refusedCases)(
    "%s seller (gate %s): the sign-in completes, no link write, the invite stays, outcome seller_unavailable",
    async (status, gate) => {
      if (gate) process.env.SELLER_READ_ONLY_BUYER_GATE = gate;
      const { prisma, service } = boot(status);
      const result: any = await service.findOrCreateUser(profile as any);
      expect(result.kind).toBe("buyer");
      expect(result.accessToken).toBeTruthy();
      expect(result.inviteOutcome).toBe("seller_unavailable");
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
      expect(prisma.buyerRefreshToken.upsert).toHaveBeenCalled(); // the session was minted
    },
  );

  it("portal context with an ACTIVE state tenant and an invite whose seller is SUSPENDED: no link", async () => {
    // The state's tenantSlug (the seller the buyer arrived from) is ACTIVE; the invite token belongs to ANOTHER,
    // suspended seller. The rule follows the INVITE's seller, never the state's.
    const { prisma, service } = boot("SUSPENDED");
    prisma.tenant.findFirst.mockResolvedValue({
      id: "tn-state",
      slug: "acme",
      status: "ACTIVE",
    } as any);
    const result: any = await service.findOrCreateUser({
      ...profile,
      context: "portal",
      tenantSlug: "acme",
    } as any);
    expect(result.kind).toBe("buyer");
    expect(result.inviteOutcome).toBe("seller_unavailable");
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
  });

  it("READ_ONLY seller + gate dark (the explicit rollback): accepted as before, and one would-deny line is logged", async () => {
    process.env.SELLER_READ_ONLY_BUYER_GATE = "dark"; // the explicit rollback (default is enforced)
    const { prisma, service } = boot("READ_ONLY");
    const result: any = await service.findOrCreateUser(profile as any);
    expect(result.inviteOutcome).toBe("accepted");
    expect(prisma.customerLink.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "link-1" },
        data: expect.objectContaining({
          buyerAccountId: "buyer-1",
          status: "ACTIVE",
          inviteToken: null,
        }),
      }),
    );
    expect(wouldDeny()).toHaveLength(1);
    expect(wouldDeny()[0]).toContain("seller=tn-1");
  });

  it.each(["ACTIVE", "TRIAL"])("%s seller: accepted as before, no would-deny line", async (s) => {
    const { prisma, service } = boot(s);
    process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
    const result: any = await service.findOrCreateUser(profile as any);
    expect(result.inviteOutcome).toBe("accepted");
    expect(prisma.customerLink.update).toHaveBeenCalledTimes(1);
    expect(wouldDeny()).toHaveLength(0);
  });

  it("a sign-in with no invite carries no outcome", async () => {
    const { service } = boot("SUSPENDED");
    const result: any = await service.findOrCreateUser({
      ...profile,
      inviteToken: undefined,
    } as any);
    expect(result.inviteOutcome).toBeUndefined();
  });

  describe("the callback bundle reports the outcome", () => {
    const webConfig = {
      get: jest.fn((k: string) => (k === "WEB_URL" ? "http://localhost:3001" : undefined)),
    };
    async function runTenantCallback(status: string, gate?: string) {
      if (gate) process.env.SELLER_READ_ONLY_BUYER_GATE = gate;
      const { prisma, service } = boot(status);
      jest.spyOn(service, "verifyCallback").mockResolvedValue(profile as any);
      const exchange = jest.spyOn(service, "createExchangeCode").mockResolvedValue("xchg-1");
      const controller = new AuthController(
        {} as any,
        webConfig as any,
        {} as any,
        service,
        {} as any,
        {} as any,
      );
      const res = { redirect: jest.fn() } as any;
      await controller.googleCallback("code", "state", "", { headers: {} } as any, res);
      return { prisma, res, bundle: exchange.mock.calls[0]?.[0] as Record<string, string> };
    }

    it.each(refusedCases)(
      "tenant callback, %s seller (gate %s): signed in, linked false, invite=seller_unavailable",
      async (status, gate) => {
        const { prisma, res, bundle } = await runTenantCallback(status, gate);
        expect(prisma.customerLink.update).not.toHaveBeenCalled();
        expect(bundle).toMatchObject({
          type: "BUYER",
          linked: "false",
          invite: "seller_unavailable",
        });
        expect(bundle.accessToken).toBeTruthy();
        expect(String(res.redirect.mock.calls[0][0])).toMatch(/\?code=xchg-1$/);
      },
    );

    it("tenant callback, an accepted invite: linked true and no invite flag", async () => {
      const { bundle } = await runTenantCallback("ACTIVE");
      expect(bundle.linked).toBe("true");
      expect(bundle).not.toHaveProperty("invite");
    });

    it("tenant callback, an invite that was skipped (expired): linked false, no invite flag", async () => {
      const { prisma, service } = boot("ACTIVE");
      prisma.customerLink.findFirst.mockResolvedValue({
        ...inviteRow("ACTIVE"),
        inviteExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
      } as any);
      jest.spyOn(service, "verifyCallback").mockResolvedValue(profile as any);
      const exchange = jest.spyOn(service, "createExchangeCode").mockResolvedValue("xchg-1");
      const controller = new AuthController(
        {} as any,
        webConfig as any,
        {} as any,
        service,
        {} as any,
        {} as any,
      );
      await controller.googleCallback(
        "code",
        "state",
        "",
        { headers: {} } as any,
        { redirect: jest.fn() } as any,
      );
      const bundle = exchange.mock.calls[0][0] as Record<string, string>;
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
      expect(bundle.linked).toBe("false");
      expect(bundle).not.toHaveProperty("invite");
    });

    it.each(["SUSPENDED", "CANCELLED"])(
      "platform callback, %s seller: no link write (the platform page takes no buyer session)",
      async (status) => {
        const { prisma, service } = boot(status);
        jest.spyOn(service, "verifyCallback").mockResolvedValue(profile as any);
        const controller = new PlatformGoogleAuthController(service, webConfig as any);
        const res = { redirect: jest.fn() } as any;
        await controller.handleCallback("code", "state", "", { headers: {} } as any, res);
        expect(prisma.customerLink.update).not.toHaveBeenCalled();
        expect(String(res.redirect.mock.calls[0][0])).toContain("error=unauthorized");
      },
    );
  });
});
