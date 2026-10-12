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
import { UserRole } from "@prisma/client";
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
    retrievePlatformAccountId: jest.fn(),
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
    mockOauth.retrievePlatformAccountId.mockReset().mockResolvedValue("acct_platform_fake");
    mockOauth.deauthorize.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeConnectService,
        { provide: PrismaService, useValue: prisma },
        { provide: CONNECT_OAUTH_PROVIDER, useValue: mockOauth },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((k: string) =>
              k === "jwt" ? { secret: "stripe-connect-spec-secret-0123456789" } : STRIPE_CONFIG,
            ),
          },
        },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get<StripeConnectService>(StripeConnectService);
  });

  // ─── buildAuthorizeUrl — single-use jti issuance (invariant 12) ────────────

  describe("buildAuthorizeUrl", () => {
    it("stashes a fresh pendingJti on the row before returning the authorize URL", async () => {
      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");

      expect(url).toContain("https://connect.stripe.com/oauth/authorize");
      expect(tenantStripeConnect.upsert).toHaveBeenCalledTimes(1);
      const arg = tenantStripeConnect.upsert.mock.calls[0]![0];
      expect(arg.where).toEqual({ tenantId: "tenant-1" });
      expect(arg.create.pendingJti).toBeDefined();
      expect(arg.update.pendingJti).toBe(arg.create.pendingJti);
      // A pre-completion "link started" shell never sets stripeAccountId.
      expect(arg.create.stripeAccountId).toBeUndefined();
    });

    it("signs the state JWT's `by` claim as the given startedByName", async () => {
      await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");

      expect(mockJwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ by: "alice" }),
        expect.anything(),
      );
    });

    // REG-2441: Stripe pre-selects whichever account is signed in on the
    // browser unless told otherwise — on the owner's own browser that is
    // RouteFlow's platform account. The actual guard against that is the
    // refusal in `completeOAuth`; these params are only a best-effort nudge
    // toward Stripe's own account-picker instead of an auto-selected session
    // — they reduce the chance of picking the wrong account, they don't
    // prevent it.
    it("REG-2441: the authorize URL nudges toward the Stripe account picker (stripe_landing=register, always_prompt=true)", async () => {
      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");
      const params = new URL(url).searchParams;
      expect(params.get("stripe_landing")).toBe("register");
      expect(params.get("always_prompt")).toBe("true");
    });

    it("REG-2441: prefills stripe_user[business_name] from the tenant, tenant-scoped requester lookup", async () => {
      (prisma as any).user.findFirst.mockResolvedValueOnce({
        email: "admin@acme.test",
        role: UserRole.TENANT_ADMIN,
      });
      (prisma as any).tenant.findUnique.mockResolvedValue({ name: "Acme Wholesale" });

      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");
      const params = new URL(url).searchParams;
      expect(params.get("stripe_user[business_name]")).toBe("Acme Wholesale");
      // Tenant-scoped lookup, not a bare findUnique by id — see the PINs
      // below for why that matters.
      expect((prisma as any).user.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: "user-1", tenantId: "tenant-1", deletedAt: null },
        select: { email: true, role: true },
      });
    });

    // SA-458 PREFILL-EMAIL RULING pins ────────────────────────────────────

    it("SA-458: a TENANT_ADMIN requester gets their own email — no fallback lookup needed", async () => {
      (prisma as any).user.findFirst.mockResolvedValueOnce({
        email: "tenant-admin@acme.test",
        role: UserRole.TENANT_ADMIN,
      });

      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");
      const params = new URL(url).searchParams;
      expect(params.get("stripe_user[email]")).toBe("tenant-admin@acme.test");
      expect((prisma as any).user.findFirst).toHaveBeenCalledTimes(1);
    });

    it("SA-458: an OPERATOR requester with a TENANT_ADMIN present gets the ADMIN's email, not the operator's", async () => {
      (prisma as any).user.findFirst
        .mockResolvedValueOnce({ email: "operator@acme.test", role: UserRole.OPERATOR })
        .mockResolvedValueOnce({ email: "tenant-admin@acme.test" }); // fallback: oldest TENANT_ADMIN

      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");
      const params = new URL(url).searchParams;
      expect(params.get("stripe_user[email]")).toBe("tenant-admin@acme.test");
      expect((prisma as any).user.findFirst).toHaveBeenNthCalledWith(2, {
        where: { tenantId: "tenant-1", role: UserRole.TENANT_ADMIN, deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { email: true },
      });
    });

    it("SA-458: an OPERATOR requester with NO tenant admin gets the operator's own email", async () => {
      (prisma as any).user.findFirst
        .mockResolvedValueOnce({ email: "operator@acme.test", role: UserRole.OPERATOR })
        .mockResolvedValueOnce(null); // no TENANT_ADMIN exists for this tenant

      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");
      const params = new URL(url).searchParams;
      expect(params.get("stripe_user[email]")).toBe("operator@acme.test");
    });

    it("SA-458 / PIN: a requester id from another tenant is ignored — the fallback admin is used instead", async () => {
      (prisma as any).user.findFirst
        .mockResolvedValueOnce(null) // tenant-scoped requester lookup finds nothing for a cross-tenant id
        .mockResolvedValueOnce({ email: "fallback-admin@acme.test" });

      const url = await service.buildAuthorizeUrl("tenant-1", "user-from-other-tenant", "alice");
      const params = new URL(url).searchParams;
      expect(params.get("stripe_user[email]")).toBe("fallback-admin@acme.test");
      expect((prisma as any).user.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: "user-from-other-tenant", tenantId: "tenant-1", deletedAt: null },
        select: { email: true, role: true },
      });
    });

    it("REG-2441: omits stripe_user[email]/stripe_user[business_name] entirely when there is no value to prefill", async () => {
      (prisma as any).user.findFirst.mockResolvedValue(null);
      (prisma as any).tenant.findUnique.mockResolvedValue(null);

      const url = await service.buildAuthorizeUrl("tenant-1", "user-1", "alice");
      const params = new URL(url).searchParams;
      expect(params.has("stripe_user[email]")).toBe(false);
      expect(params.has("stripe_user[business_name]")).toBe(false);
    });
  });

  // ─── completeOAuth — jti single-use + curated error codes (invariant 12) ──

  describe("completeOAuth", () => {
    const statePayload = {
      purpose: "stripe-connect",
      tid: "tenant-1",
      by: "alice",
      jti: "jti-1",
      aud: "stripe-connect-state",
    };
    const liveTenant = { id: "tenant-1", slug: "acme", status: "ACTIVE" };

    // ── The workspace must accept changes when the callback lands ──────────────
    // The status is read live after the signed state checks out and BEFORE the code
    // exchange, so a refused callback never creates a Stripe grant or binds an account.

    it.each(["READ_ONLY", "SUSPENDED", "CANCELLED"])(
      "refuses a %s workspace before the code exchange and stores nothing",
      async (status) => {
        mockJwt.verifyAsync.mockResolvedValue(statePayload);
        tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.tenant.findUnique.mockResolvedValue({ ...liveTenant, status } as any);
        mockOauth.exchangeCode.mockResolvedValue({ accountRef: "acct_1", livemode: false });

        await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
          response: { message: "workspace_read_only" },
        });
        expect(prisma.tenant.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "tenant-1" },
            select: expect.objectContaining({ status: true }),
          }),
        );
        expect(mockOauth.exchangeCode).not.toHaveBeenCalled();
        expect(mockOauth.retrievePlatformAccountId).not.toHaveBeenCalled();
        expect(mockOauth.retrieveAccount).not.toHaveBeenCalled();
        expect(tenantStripeConnect.upsert).not.toHaveBeenCalled();
      },
    );

    it.each(["TRIAL", "ACTIVE"])("still completes for a %s workspace", async (status) => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue({ ...liveTenant, status } as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: "acct_1", livemode: false });
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      tenantStripeConnect.upsert.mockResolvedValue({
        stripeAccountId: "acct_1",
        livemode: false,
        chargesEnabled: true,
      });

      await expect(service.completeOAuth("code", "state")).resolves.toMatchObject({
        accountId: "acct_1",
      });
      expect(mockOauth.exchangeCode).toHaveBeenCalledTimes(1);
      expect(tenantStripeConnect.upsert).toHaveBeenCalledTimes(1);
    });

    it("consumes the jti once — a replay of the same state finds nothing to consume and is rejected", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      // First call: the atomic consume succeeds.
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
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
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.exchangeCode.mockRejectedValue(new Error("invalid_grant"));
      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "stripe_exchange_failed" },
      });
    });

    it("throws account_missing when the exchange yields no account id", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: null, livemode: false });
      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "account_missing" },
      });
    });

    // ── REG-2441: refuse a connect that resolves to the platform's own account ──

    it("REG-2441: refuses and stores nothing when the connected account IS the platform's own account", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.exchangeCode.mockResolvedValue({
        accountRef: "acct_platform_fake",
        livemode: false,
      });
      mockOauth.retrievePlatformAccountId.mockResolvedValue("acct_platform_fake");

      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "platform_account_not_allowed" },
      });
      expect(tenantStripeConnect.upsert).not.toHaveBeenCalled();
    });

    it("REG-2441: fails closed BEFORE the exchange — a throwing platform-id lookup never calls exchangeCode, stores nothing", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: "acct_tenant_fake", livemode: false });
      mockOauth.retrievePlatformAccountId.mockRejectedValue(new Error("stripe down"));

      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "platform_account_check_failed" },
      });
      // The platform-id lookup now runs BEFORE the code exchange (REG-2441
      // fold 1) so a failed lookup never creates a live, unrecorded Stripe
      // OAuth grant.
      expect(mockOauth.exchangeCode).not.toHaveBeenCalled();
      expect(tenantStripeConnect.upsert).not.toHaveBeenCalled();
    });

    it("REG-2441: fails closed — an empty/missing platform account id is never trusted or cached", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: "acct_tenant_fake", livemode: false });
      // A misbehaving provider resolving "" instead of throwing must still be
      // refused by the service's own defensive check — never cached as truth.
      mockOauth.retrievePlatformAccountId.mockResolvedValueOnce("");

      await expect(service.completeOAuth("code", "state")).rejects.toMatchObject({
        response: { message: "platform_account_check_failed" },
      });
      expect(mockOauth.exchangeCode).not.toHaveBeenCalled();
      expect(tenantStripeConnect.upsert).not.toHaveBeenCalled();

      // Nothing was cached from the empty result — the next callback retries
      // the lookup and, once it succeeds, the connect goes through normally.
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      mockOauth.exchangeCode.mockResolvedValueOnce({
        accountRef: "acct_tenant_fake",
        livemode: false,
      });
      mockOauth.retrievePlatformAccountId.mockResolvedValueOnce("acct_platform_fake");
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      tenantStripeConnect.upsert.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        livemode: false,
        chargesEnabled: true,
      });
      const result = await service.completeOAuth("code-2", "state");
      expect(result.accountId).toBe("acct_tenant_fake");
      expect(mockOauth.retrievePlatformAccountId).toHaveBeenCalledTimes(2);
    });

    it("PIN: a failed lookup is not cached — the next callback's successful lookup is used", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      tenantStripeConnect.upsert.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        livemode: false,
        chargesEnabled: true,
      });

      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      mockOauth.exchangeCode.mockResolvedValueOnce({
        accountRef: "acct_tenant_fake",
        livemode: false,
      });
      mockOauth.retrievePlatformAccountId.mockRejectedValueOnce(new Error("stripe down"));
      await expect(service.completeOAuth("code-1", "state")).rejects.toMatchObject({
        response: { message: "platform_account_check_failed" },
      });
      expect(mockOauth.exchangeCode).not.toHaveBeenCalled();
      expect(tenantStripeConnect.upsert).not.toHaveBeenCalled();

      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      mockOauth.exchangeCode.mockResolvedValueOnce({
        accountRef: "acct_tenant_fake",
        livemode: false,
      });
      mockOauth.retrievePlatformAccountId.mockResolvedValueOnce("acct_platform_fake");
      const result = await service.completeOAuth("code-2", "state");
      expect(result.accountId).toBe("acct_tenant_fake");
      expect(mockOauth.retrievePlatformAccountId).toHaveBeenCalledTimes(2);
    });

    it("PIN: a different (non-platform) account still connects exactly as today", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.exchangeCode.mockResolvedValue({ accountRef: "acct_tenant_fake", livemode: false });
      mockOauth.retrievePlatformAccountId.mockResolvedValue("acct_platform_fake");
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      tenantStripeConnect.upsert.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        livemode: false,
        chargesEnabled: true,
      });

      const result = await service.completeOAuth("code", "state");
      expect(result.accountId).toBe("acct_tenant_fake");
      expect(tenantStripeConnect.upsert).toHaveBeenCalledTimes(1);
    });

    it("PIN: the platform account id is retrieved at most once across two callbacks (in-memory cache)", async () => {
      mockJwt.verifyAsync.mockResolvedValue(statePayload);
      prisma.tenant.findUnique.mockResolvedValue(liveTenant as any);
      mockOauth.retrievePlatformAccountId.mockResolvedValue("acct_platform_fake");
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      tenantStripeConnect.upsert.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        livemode: false,
        chargesEnabled: true,
      });

      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      mockOauth.exchangeCode.mockResolvedValueOnce({
        accountRef: "acct_tenant_fake",
        livemode: false,
      });
      await service.completeOAuth("code-1", "state");

      tenantStripeConnect.updateMany.mockResolvedValueOnce({ count: 1 });
      mockOauth.exchangeCode.mockResolvedValueOnce({
        accountRef: "acct_tenant_fake",
        livemode: false,
      });
      await service.completeOAuth("code-2", "state");

      expect(mockOauth.retrievePlatformAccountId).toHaveBeenCalledTimes(1);
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

  // ─── applyAccountUpdate — retrieve current truth, never trust the event ────
  // (2026-08-22 incident: a Restricted-era account.updated retry, replayed
  // after the rawBody fix, disabled card payments for a fully-live account.
  // Ledger ordering can't close a cold-start hole; retrieving CURRENT state
  // is order-proof by construction.)

  describe("applyAccountUpdate", () => {
    it("persists the RETRIEVED account state, ignoring whatever the event carried", async () => {
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      const applied = await service.applyAccountUpdate("acct_1");
      expect(applied).toBe(true);
      expect(mockOauth.retrieveAccount).toHaveBeenCalledWith("acct_1");
      expect(tenantStripeConnect.updateMany).toHaveBeenCalledWith({
        where: { stripeAccountId: "acct_1", disconnectedAt: null },
        data: { chargesEnabled: true, detailsSubmitted: true },
      });
    });

    it("a stale replay HEALS the row rather than clobbering it — retrieve wins", async () => {
      // The delivery that triggers this may be a days-old Restricted snapshot;
      // the persisted values must still be the live account's.
      mockOauth.retrieveAccount.mockResolvedValue({ chargesEnabled: true, detailsSubmitted: true });
      const applied = await service.applyAccountUpdate("acct_1");
      expect(applied).toBe(true);
      expect(tenantStripeConnect.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { chargesEnabled: true, detailsSubmitted: true },
        }),
      );
    });

    it("propagates a retrieve failure so the webhook 500s and Stripe redelivers", async () => {
      mockOauth.retrieveAccount.mockRejectedValue(new Error("stripe down"));
      await expect(service.applyAccountUpdate("acct_1")).rejects.toThrow("stripe down");
      expect(tenantStripeConnect.updateMany).not.toHaveBeenCalled();
    });

    it("no-ops on a missing accountRef", async () => {
      const applied = await service.applyAccountUpdate("");
      expect(applied).toBe(false);
      expect(mockOauth.retrieveAccount).not.toHaveBeenCalled();
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

  // ─── chargeableAccount — REG-2441 also refuses the platform's own account ──

  describe("chargeableAccount", () => {
    it("returns the stored account when it is charge-ready and not the platform's own", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        disconnectedAt: null,
        chargesEnabled: true,
      });
      mockOauth.retrievePlatformAccountId.mockResolvedValue("acct_platform_fake");

      await expect(service.chargeableAccount("tenant-1")).resolves.toBe("acct_tenant_fake");
    });

    it("REG-2441: returns null when the stored account IS the platform's own account", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_platform_fake",
        disconnectedAt: null,
        chargesEnabled: true,
      });
      mockOauth.retrievePlatformAccountId.mockResolvedValue("acct_platform_fake");

      await expect(service.chargeableAccount("tenant-1")).resolves.toBeNull();
    });

    it("REG-2441: fails closed to null when the platform-id lookup throws", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        disconnectedAt: null,
        chargesEnabled: true,
      });
      mockOauth.retrievePlatformAccountId.mockRejectedValue(new Error("stripe down"));

      await expect(service.chargeableAccount("tenant-1")).resolves.toBeNull();
    });

    it("REG-2441: fails closed to null when the platform-id lookup resolves empty", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        disconnectedAt: null,
        chargesEnabled: true,
      });
      mockOauth.retrievePlatformAccountId.mockResolvedValue("");

      await expect(service.chargeableAccount("tenant-1")).resolves.toBeNull();
    });

    it("still returns null (unchanged) for a disconnected or not-charges-enabled row, without even reaching the platform check", async () => {
      tenantStripeConnect.findUnique.mockResolvedValue({
        stripeAccountId: "acct_tenant_fake",
        disconnectedAt: new Date(),
        chargesEnabled: true,
      });
      await expect(service.chargeableAccount("tenant-1")).resolves.toBeNull();
      expect(mockOauth.retrievePlatformAccountId).not.toHaveBeenCalled();
    });
  });
});
