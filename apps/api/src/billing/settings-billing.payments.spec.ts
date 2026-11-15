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
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { BillingPaymentsService } from "./billing-payments.service";
import { BillingService } from "./billing.service";
import { ProrationService } from "./proration.service";
import { SettingsBillingController } from "./settings-billing.controller";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { SubscriptionService } from "./subscription.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/** SA-1146 B-4: GET /billing/payments - TENANT_ADMIN only, tenant from the token, cursor passed through. */
describe("GET /billing/payments (SA-1146 B-4)", () => {
  let app: INestApplication;
  const payments = { list: jest.fn() };
  const fakeJwt: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers["x-role"];
      if (!role) throw new UnauthorizedException();
      req.user = { sub: "u-1", role, tenantId: "t-1" };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SettingsBillingController],
      providers: [
        { provide: SubscriptionService, useValue: {} },
        { provide: ProrationService, useValue: {} },
        { provide: SubscriptionMutationService, useValue: {} },
        { provide: BillingService, useValue: {} },
        { provide: BillingPaymentsService, useValue: payments },
        { provide: AuditService, useValue: { log: jest.fn() } },
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
    payments.list.mockReset();
    payments.list.mockResolvedValue({ rows: [], nextCursor: null, stripeUnavailable: false });
  });

  const get = (path: string, role?: string) => {
    const req = request(app.getHttpServer()).get(path);
    if (role) req.set("x-role", role);
    return req;
  };

  it("a TENANT_ADMIN gets 200 with the page shape", async () => {
    payments.list.mockResolvedValue({
      rows: [{ id: "in_1", source: "stripe" }],
      nextCursor: "abc",
      stripeUnavailable: false,
    });
    const res = await get("/billing/payments", "TENANT_ADMIN");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rows: [{ id: "in_1", source: "stripe" }],
      nextCursor: "abc",
      stripeUnavailable: false,
    });
  });

  it("an OPERATOR gets 403 and the service never runs", async () => {
    const res = await get("/billing/payments", "OPERATOR");
    expect(res.status).toBe(403);
    expect(payments.list).not.toHaveBeenCalled();
  });

  it("no token gets 401", async () => {
    expect((await get("/billing/payments")).status).toBe(401);
  });

  it("the tenant is the token's, never a query value; the cursor passes through", async () => {
    await get("/billing/payments?cursor=c1&tenantId=t-other", "TENANT_ADMIN");
    expect(payments.list).toHaveBeenCalledWith("t-1", "c1");
  });

  it("no cursor means the first page", async () => {
    await get("/billing/payments", "TENANT_ADMIN");
    expect(payments.list).toHaveBeenCalledWith("t-1", null);
  });
});
