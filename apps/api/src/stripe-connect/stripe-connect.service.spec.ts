/**
 * Unit tests for StripeConnectService — the rework's WP2 slice: the OAuth
 * single-use jti (invariant 12), the webhook anti-spoof cross-check
 * (invariant 2), and the account.updated ledger-ordering guard (invariant 3).
 *
 * All collaborators are mocked at the module boundary via the standard
 * createMockPrisma() helper. Neither `tenantStripeConnect` nor
 * `stripeConnectEvent` are in the shared mock's model list, so — mirroring
 * the graftBuyerPaymentRequest pattern in payment-requests.service.spec.ts —
 * both are grafted on locally.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { StripeConnectService } from "./stripe-connect.service";
import { PrismaService } from "../prisma/prisma.service";
import { CONNECT_OAUTH_PROVIDER } from "./provider/connect-oauth.interface";
import { createMockPrisma } from "../testing/prisma-mock";

function graftModel() {
  return {
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn().mockResolvedValue({}),
  };
}

const STRIPE_CONFIG = {
  secretKey: "sk_test",
  connectClientId: "ca_test",
  connectWebhookSecret: "whsec_test",
};

describe("StripeConnectService", () => {
  let service: StripeConnectService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tenantStripeConnect: ReturnType<typeof graftModel>;
  let stripeConnectEvent: ReturnType<typeof graftModel>;

  const mockJwt = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  };
  // The CONNECT_OAUTH_PROVIDER port, not the Stripe SDK: the adapter behind it
  // owns every SDK call and every snake_case field (invariant 4), and has its
  // own spec — see provider/stripe-connect-oauth.provider.spec.ts.
  const mockOauth = {
    isConfigured: true,
    exchangeCode: jest.fn(),
    retrieveAccount: jest.fn(),
    deauthorize: jest.fn(),
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    tenantStripeConnect = graftModel();
    stripeConnectEvent = graftModel();
    (prisma as any).tenantStripeConnect = tenantStripeConnect;
    (prisma as any).stripeConnectEvent = stripeConnectEvent;

    mockJwt.signAsync.mockReset().mockResolvedValue("signed-state-token");
    mockJwt.verifyAsync.mockReset();
    mockOauth.exchangeCode.mockReset();
    mockOauth.retrieveAccount.mockReset();
    mockOauth.deauthorize.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeConnectService,
        { provide: PrismaService, useValue: prisma },
        { provide: CONNECT_OAUTH_PROVIDER, useValue: mockOauth },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(STRIPE_CONFIG) },
        },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get<StripeConnectService>(StripeConnectService);
  });

  // ─── buildAuthorizeUrl — single-use jti issuance (invariant 12) ────────────

  describe("buildAuthorizeUrl", () => {
    it("stashes a fresh pendingJti on the row before returning the authorize URL", async () => {
      const url = await service.buildAuthorizeUrl("tenant-1", "alice");

      expect(url).toContain("https://connect.stripe.com/oauth/authorize");
      expect(tenantStripeConnect.upsert).toHaveBeenCalledTimes(1);
      const arg = tenantStripeConnect.upsert.mock.calls[0]![0];
      expect(arg.where).toEqual({ tenantId: "tenant-1" });
      expect(arg.create.pendingJti).toBeDefined();
      expect(arg.update.pendingJti).toBe(arg.create.pendingJti);
      // A pre-completion "link started" shell never sets stripeAccountId.
      expect(arg.create.stripeAccountId).toBeUndefined();
    });
  });

  // ─── completeOAuth — jti single-use + curated error codes (invariant 12) ──

  describe("completeOAuth", () => {
    const statePayload = { purpose: "stripe-connect", tid: "tenant-1", by: "alice", jti: "jti-1" };

    it("consumes the jti once — a replay of the same state finds nothing to consume and is rejected", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      // First call: the atomic consume succeeds.
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-1", slug: "acme" } as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: "acct_1", livemode: false });
      mockOauth.retrieveAccount.mockResolvedValue({
        chargesEnabled: true,
        detailsSubmitted: true,
      });
      tenantStripeConnect.upsert.mockResolvedValue({
        stripeAccountId: "acct_1",
        livemode: false,
        chargesEnabled: true,
      });

      const first = await service.completeOAuth("code-1", "state-token");
      expect(first.accountId).toBe("acct_1");
      expect(tenantStripeConnect.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", pendingJti: "jti-1" },
        data: { pendingJti: null, pendingJtiIssuedAt: null },
      });

      // Second exchange of the identical state token: the jti is already
      // cleared, so the conditional update claims nothing.
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.completeOAuth("code-2", "state-token")).rejects.toMatchObject({
        response: { message: "state_replayed" },
      });
    });

    it("throws state_expired when the JWT itself fails verification", async () => {
      mockJwt.verifyAsync.mockRejectedValue(new Error("jwt expired"));
      await expect(service.completeOAuth("code", "bad-state")).rejects.toMatchObject({
        response: { message: "state_expired" },
      });
      expect(tenantStripeConnect.updateMany).not.toHaveBeenCalled();
    });

    it("throws state_invalid when the payload is missing purpose/tid/jti", async () => {
      mockJwt.verifyAsync.mockResolvedValue({ purpose: "stripe-connect", tid: "tenant-1" }); // no jti
      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "state_invalid" },
      });
    });

    it("throws tenant_not_found when the jti consumes cleanly but the tenant row is gone", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "tenant_not_found" },
      });
    });

    it("throws stripe_exchange_failed when Stripe rejects the code", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-1", slug: "acme" } as any);
      mockOauth.exchangeCode.mockRejectedValue(new Error("invalid_grant"));
      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "stripe_exchange_failed" },
      });
    });

    it("throws account_missing when the exchange yields no account id", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue({ id: "tenant-1", slug: "acme" } as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: null, livemode: false });
      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "account_missing" },
      });
    });
  });

  // ─── assertEventAccount — anti-spoof cross-check (invariant 2) ────────────

  describe("assertEventAccount", () => {
    it("returns true when the event's account matches the tenant's connected, non-disconnected account", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_1",
        disconnectedAt: null,
      });
      await expect(service.assertEventAccount("tenant-1", "acct_1")).resolves.toBe(true);
    });

    it("returns false and logs CRITICAL on an account mismatch — nothing is written by the caller", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_1",
        disconnectedAt: null,
      });
      await expect(service.assertEventAccount("tenant-1", "acct_EVIL")).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("CRITICAL"));
      errorSpy.mockRestore();
    });

    it("returns false when the tenant's row is disconnected", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_1",
        disconnectedAt: new Date(),
      });
      await expect(service.assertEventAccount("tenant-1", "acct_1")).resolves.toBe(false);
    });

    it("returns false when the tenant has no connected-account row at all", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue(null);
      await expect(service.assertEventAccount("tenant-1", "acct_1")).resolves.toBe(false);
    });
  });

  // ─── applyAccountUpdate — ledger-ordering guard (invariant 3) ─────────────

  describe("applyAccountUpdate", () => {
    it("applies the capability flags when no prior account.updated has been applied", async () => {
      stripeConnectEvent.findFirst.mockResolvedValue(null);
      const applied = await service.applyAccountUpdate(
        "acct_1",
        { chargesEnabled: true, detailsSubmitted: true },
        new Date("2026-08-21T12:00:00Z"),
      );
      expect(applied).toBe(true);
      expect(tenantStripeConnect.updateMany).toHaveBeenCalledWith({
        where: { stripeAccountId: "acct_1", disconnectedAt: null },
        data: { chargesEnabled: true, detailsSubmitted: true },
      });
    });

    it("skips a delivery that is not newer than the last-applied one (stale/out-of-order)", async () => {
      stripeConnectEvent.findFirst.mockResolvedValue({
        createdAt: new Date("2026-08-21T12:00:00Z"),
      });
      const applied = await service.applyAccountUpdate(
        "acct_1",
        { chargesEnabled: false, detailsSubmitted: false },
        new Date("2026-08-21T11:00:00Z"), // older than last-applied
      );
      expect(applied).toBe(false);
      expect(tenantStripeConnect.updateMany).not.toHaveBeenCalled();
    });

    it("applies a delivery strictly newer than the last-applied one", async () => {
      stripeConnectEvent.findFirst.mockResolvedValue({
        createdAt: new Date("2026-08-21T12:00:00Z"),
      });
      const applied = await service.applyAccountUpdate(
        "acct_1",
        { chargesEnabled: true, detailsSubmitted: true },
        new Date("2026-08-21T13:00:00Z"), // newer
      );
      expect(applied).toBe(true);
      expect(tenantStripeConnect.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  // ─── markDeauthorized (invariant 11) ───────────────────────────────────────

  describe("markDeauthorized", () => {
    it("disconnects every tenant row on that account and returns their tenant ids", async () => {
      tenantStripeConnect.findMany.mockResolvedValue([
        { tenantId: "tenant-1" },
        { tenantId: "tenant-2" },
      ]);
      const tenantIds = await service.markDeauthorized("acct_1");
      expect(tenantIds).toEqual(["tenant-1", "tenant-2"]);
      expect(tenantStripeConnect.updateMany).toHaveBeenCalledWith({
        where: { stripeAccountId: "acct_1", disconnectedAt: null },
        data: { disconnectedAt: expect.any(Date), chargesEnabled: false },
      });
    });

    it("is a no-op when nothing matches (already disconnected, or unknown account)", async () => {
      tenantStripeConnect.findMany.mockResolvedValue([]);
      const tenantIds = await service.markDeauthorized("acct_unknown");
      expect(tenantIds).toEqual([]);
      expect(tenantStripeConnect.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── getStatus — a pending (not-yet-completed) link never reads as connected ──

  describe("getStatus", () => {
    it("reports connected: false for a link-started row with no stripeAccountId yet", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: null,
        disconnectedAt: null,
        chargesEnabled: false,
        detailsSubmitted: false,
        livemode: false,
        connectedAt: new Date(),
      });
      const status = await service.getStatus("tenant-1");
      expect(status.connected).toBe(false);
      expect(status.stripeAccountId).toBeNull();
    });

    it("reports connected: true once stripeAccountId is set and the row isn't disconnected", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_1",
        disconnectedAt: null,
        chargesEnabled: true,
        detailsSubmitted: true,
        livemode: false,
        connectedAt: new Date(),
      });
      const status = await service.getStatus("tenant-1");
      expect(status.connected).toBe(true);
      expect(status.stripeAccountId).toBe("acct_1");
    });
  });

  // ─── disconnect — guards a never-completed (null stripeAccountId) link ────

  describe("disconnect", () => {
    it("skips the Stripe deauthorize call when the link never completed", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: null,
        disconnectedAt: null,
      });
      const result = await service.disconnect("tenant-1");
      expect(result).toEqual({ disconnected: true });
      expect(mockOauth.deauthorize).not.toHaveBeenCalled();
      expect(tenantStripeConnect.update).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1" },
        data: {
          disconnectedAt: expect.any(Date),
          chargesEnabled: false,
          pendingJti: null,
          pendingJtiIssuedAt: null,
        },
      });
    });

    it("calls Stripe deauthorize when a real account is linked", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_1",
        disconnectedAt: null,
      });
      await service.disconnect("tenant-1");
      expect(mockOauth.deauthorize).toHaveBeenCalledWith("ca_test", "acct_1");
    });
  });
});
