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
 * follows SELLER_READ_ONLY_BUYER_GATE (dark: allowed + would-deny line; enforced: refused). A refusal writes
 * nothing, leaves the invite token on the row (so it can be accepted after reactivation), and answers the
 * callback's existing way: a redirect carrying a fixed error code.
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

  it.each(["SUSPENDED", "CANCELLED"])(
    "%s seller: no link write, the invite stays on the row, the callback is refused",
    async (status) => {
      const { prisma, service } = boot(status);
      await expect(service.findOrCreateUser(profile as any)).rejects.toThrow("seller_unavailable");
      expect(prisma.customerLink.update).not.toHaveBeenCalled();
      expect(prisma.buyerRefreshToken.upsert).not.toHaveBeenCalled();
    },
  );

  it("READ_ONLY seller + gate enforced: refused, nothing written", async () => {
    process.env.SELLER_READ_ONLY_BUYER_GATE = "enforced";
    const { prisma, service } = boot("READ_ONLY");
    await expect(service.findOrCreateUser(profile as any)).rejects.toThrow("seller_unavailable");
    expect(prisma.customerLink.update).not.toHaveBeenCalled();
  });

  it("READ_ONLY seller + gate dark (default): accepted as before, and one would-deny line is logged", async () => {
    const { prisma, service } = boot("READ_ONLY");
    await service.findOrCreateUser(profile as any);
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
    await service.findOrCreateUser(profile as any);
    expect(prisma.customerLink.update).toHaveBeenCalledTimes(1);
    expect(wouldDeny()).toHaveLength(0);
  });

  describe("both callbacks answer a refusal with a redirect carrying a fixed error code", () => {
    const webConfig = {
      get: jest.fn((k: string) => (k === "WEB_URL" ? "http://localhost:3001" : undefined)),
    };

    it.each(["SUSPENDED", "CANCELLED"])(
      "tenant callback, %s seller: error=seller_unavailable, no write, nothing internal in the URL",
      async (status) => {
        const { prisma, service } = boot(status);
        jest.spyOn(service, "verifyCallback").mockResolvedValue(profile as any);
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
        expect(prisma.customerLink.update).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledTimes(1);
        const url = String(res.redirect.mock.calls[0][0]);
        expect(url).toContain("error=seller_unavailable");
        expect(url).not.toMatch(/tok-invite|accessToken|code=/);
      },
    );

    it.each(["SUSPENDED", "CANCELLED"])(
      "platform callback, %s seller: error=seller_unavailable, no write",
      async (status) => {
        const { prisma, service } = boot(status);
        jest.spyOn(service, "verifyCallback").mockResolvedValue(profile as any);
        const controller = new PlatformGoogleAuthController(service, webConfig as any);
        const res = { redirect: jest.fn() } as any;
        await controller.handleCallback("code", "state", "", { headers: {} } as any, res);
        expect(prisma.customerLink.update).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledTimes(1);
        expect(String(res.redirect.mock.calls[0][0])).toContain("error=seller_unavailable");
      },
    );
  });
});
