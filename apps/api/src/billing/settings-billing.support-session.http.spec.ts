import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuditService } from "../audit/audit.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { BillingService } from "./billing.service";
import { ProrationService } from "./proration.service";
import { SettingsBillingController } from "./settings-billing.controller";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { SubscriptionService } from "./subscription.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * SA-778: the HTTP edge of the tenant billing routes in a support session. The real RolesGuard and the real
 * NoImpersonationGuard run over the real controller metadata; only the JWT strategy is replaced by a stand-in
 * that stamps `request.user` from headers (the verified-user shape JwtStrategy returns).
 */

const MESSAGE = "This action isn't available in a support session. Ask the account admin to do it.";

const MUTATIONS: Array<[string, string]> = [
  ["subscribe", "/billing/subscribe"],
  ["upgrade", "/billing/subscription"],
  ["downgrade", "/billing/subscription/downgrade"],
  ["cancel", "/billing/subscription/cancel"],
  ["resume", "/billing/subscription/resume"],
  ["checkout", "/billing/subscription/checkout"],
  ["portal", "/billing/portal"],
  ["add-on enable", "/billing/addons/sku_x/enable"],
  ["add-on disable", "/billing/addons/sku_x/disable"],
];

describe("tenant billing routes in a support session (SA-778)", () => {
  let app: INestApplication;
  const subscription = {
    getSubscription: jest.fn(),
    getUsage: jest.fn(),
    getRecommendation: jest.fn(),
    getExport: jest.fn(),
    openInvoiceUrl: jest.fn(),
  };
  const mutations = {
    subscribe: jest.fn(),
    upgrade: jest.fn(),
    downgrade: jest.fn(),
    cancel: jest.fn(),
    resume: jest.fn(),
    enableAddon: jest.fn(),
    disableAddon: jest.fn(),
    planChangePreview: jest.fn(),
  };
  const billing = { createBillingPortalSession: jest.fn(), createCheckoutSession: jest.fn() };
  const proration = { quote: jest.fn() };
  const audit = { log: jest.fn() };
  const allMocks = [
    ...Object.values(subscription),
    ...Object.values(mutations),
    ...Object.values(billing),
    ...Object.values(proration),
  ];

  /** Stand-in for the JWT strategy: x-role is the token's role (absent = no token), x-impersonated-by the claim. */
  const fakeJwt: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers["x-role"];
      if (!role) throw new UnauthorizedException();
      req.user = {
        sub: "u-admin",
        role,
        tenantId: "t-1",
        impersonatedBy: req.headers["x-impersonated-by"] || undefined,
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SettingsBillingController],
      providers: [
        { provide: SubscriptionService, useValue: subscription },
        { provide: ProrationService, useValue: proration },
        { provide: SubscriptionMutationService, useValue: mutations },
        { provide: BillingService, useValue: billing },
        { provide: AuditService, useValue: audit },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwt)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const m of [...allMocks, audit.log]) m.mockReset();
    audit.log.mockResolvedValue(undefined);
    subscription.getSubscription.mockResolvedValue({ status: "ACTIVE", planKey: "TEAM" });
    subscription.getUsage.mockResolvedValue({ seats: 1 });
    subscription.getExport.mockResolvedValue({ rows: [] });
    subscription.openInvoiceUrl.mockResolvedValue("https://invoice.example/i/1");
    billing.createBillingPortalSession.mockResolvedValue({
      portalUrl: "https://billing.example/p/1",
    });
    mutations.cancel.mockResolvedValue({ ok: true });
    mutations.planChangePreview.mockResolvedValue(null);
    proration.quote.mockResolvedValue({ total: 1 });
  });

  const call = (verb: "get" | "post", path: string, role?: string, supportSession = false) => {
    const req = request(app.getHttpServer())[verb](path);
    if (role) req.set("x-role", role);
    if (supportSession) req.set("x-impersonated-by", "sa-1");
    return req;
  };

  it.each(MUTATIONS)(
    "a support session on %s is refused 403 with the coded body; the handler never runs; one audit row",
    async (_name, path) => {
      const res = await call("post", path, "TENANT_ADMIN", true).send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(API_ERROR_CODES.IMPERSONATION_NOT_ALLOWED);
      expect(res.body.message).toBe(MESSAGE);
      for (const m of allMocks) expect(m).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log.mock.calls[0][0]).toMatchObject({
        action: "impersonation.action-refused",
        tenantId: "t-1",
        impersonatedBy: "sa-1",
        meta: { superAdminId: "sa-1", tenantId: "t-1", method: "POST" },
      });
    },
  );

  it("the portal refusal records the route that was asked for", async () => {
    await call("post", "/billing/portal", "TENANT_ADMIN", true).send({});
    expect(audit.log.mock.calls[0][0].meta).toEqual({
      superAdminId: "sa-1",
      tenantId: "t-1",
      method: "POST",
      route: "/billing/portal",
    });
  });

  it.each(["/billing/subscription", "/billing/usage", "/billing/export"])(
    "a support session can still read GET %s",
    async (path) => {
      const res = await call("get", path, "TENANT_ADMIN", true);
      expect(res.status).toBe(200);
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it("a support session can still price a plan (POST quote is read-like)", async () => {
    const res = await call("post", "/billing/quote", "TENANT_ADMIN", true).send({});
    expect(res.status).toBe(200);
    expect(proration.quote).toHaveBeenCalledTimes(1);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a real TENANT_ADMIN is unchanged: the portal opens and cancel runs", async () => {
    const portal = await call("post", "/billing/portal", "TENANT_ADMIN").send({});
    expect(portal.status).toBe(200);
    expect(portal.body).toEqual({
      portalUrl: "https://billing.example/p/1",
      hostedInvoiceUrl: "https://invoice.example/i/1",
    });

    const cancel = await call("post", "/billing/subscription/cancel", "TENANT_ADMIN").send({});
    expect(cancel.status).toBe(200);
    expect(mutations.cancel).toHaveBeenCalledWith("t-1", "u-admin");
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("an operator is still refused by the role gate first (no support-session audit row, no coded body)", async () => {
    const res = await call("post", "/billing/portal", "OPERATOR", true).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("no token: 401, nothing audited", async () => {
    await call("post", "/billing/portal").send({}).expect(401);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
