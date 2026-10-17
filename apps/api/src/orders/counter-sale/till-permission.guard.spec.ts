jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../app.module";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { STAFF_CAPABILITY_RULES } from "../../auth/permissions/staff-capabilities";
import { listenOnLoopback } from "../../common/testing/listen-loopback";
import { routeTableOf } from "../../common/testing/route-table";
import { PrismaService } from "../../prisma/prisma.service";
import { CounterDayCloseController } from "./day-close/day-close.controller";
import { CounterDayCloseService } from "./day-close/day-close.service";
import { CounterParkController } from "./counter-park.controller";
import { CounterParkService } from "./counter-park.service";
import { CounterSaleController } from "./counter-sale.controller";
import { CounterSaleService } from "./counter-sale.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import { CounterSaleVoidController } from "./counter-sale-void.controller";
import { CounterSaleVoidService } from "./counter-sale-void.service";
import { PickupCompleteController } from "./pickup-complete.controller";
import { PickupCompleteService } from "./pickup-complete.service";
import { QuickKeysService } from "./quick-keys.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * BO-07 (D3): an OPERATOR whose admin switched the ORDERS group off cannot reach the till. TENANT_ADMIN and
 * SUPER_ADMIN always pass. The refusal is a live read per request, never a JWT claim.
 */

const ID = "00000000-0000-4000-8000-000000000001";
const IDEM = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

/** The 15 till handlers, pinned: a counter handler added without the guard fails the census (L-202). */
const GUARDED = [
  "CounterSaleController.today",
  "CounterSaleController.quickKeysGrid",
  "CounterSaleController.byKey",
  "CounterSaleController.ring",
  "CounterParkController.park",
  "CounterParkController.list",
  "CounterParkController.resume",
  "CounterParkController.discard",
  "PickupCompleteController.complete",
  "CounterDayCloseController.state",
  "CounterDayCloseController.latest",
  "CounterDayCloseController.byId",
  "CounterDayCloseController.close",
  "CounterDayCloseController.reopen",
  "CounterDayCloseController.report",
];
const EXCLUDED = ["CounterSaleVoidController.voidSale"];

describe("the till guard is on every counter handler (route metadata)", () => {
  const isTill = (path: string) =>
    path.startsWith("/api/v1/orders/counter-sale") ||
    /\/orders\/:[^/]+\/pickup-complete$/.test(path);
  const discovered = routeTableOf(AppModule).filter((r) => isTill(r.path));
  const keyOf = (r: { controller: string; handler: string }) => `${r.controller}.${r.handler}`;

  it("discovers the route table (a zero-route pass would be vacuous)", () => {
    expect(discovered.length).toBeGreaterThanOrEqual(GUARDED.length);
  });

  it("the counter handlers are exactly the pinned fifteen plus the excluded void", () => {
    expect(discovered.map(keyOf).sort()).toEqual([...GUARDED, ...EXCLUDED].sort());
  });

  it.each(GUARDED)("%s carries TillPermissionGuard after RolesGuard", (key) => {
    const r = discovered.find((x) => keyOf(x) === key);
    expect(r).toBeDefined();
    const roles = r!.guards.indexOf("RolesGuard");
    const till = r!.guards.indexOf("TillPermissionGuard");
    expect(roles).toBeGreaterThanOrEqual(0);
    expect(till).toBeGreaterThan(roles);
  });

  it("the counter-sale void stays on VOID_SALE: no till guard", () => {
    const r = discovered.find((x) => keyOf(x) === EXCLUDED[0]);
    expect(r).toBeDefined();
    expect(r!.guards).not.toContain("TillPermissionGuard");
  });
});

describe("the till guard over HTTP", () => {
  let app: INestApplication;
  const findFirst = jest.fn();
  const ok = (v: unknown) => jest.fn().mockResolvedValue(v);
  const services = {
    sale: { ring: ok({ id: ID }) },
    today: { today: ok({}) },
    keys: { grid: ok({}), byKey: ok({}) },
    park: { park: ok({ id: ID }), list: ok({ data: [] }), resume: ok({}), discard: ok(undefined) },
    pickup: { complete: ok({ id: ID }) },
    close: { state: ok({}), latest: ok({}), byId: ok({}), close: ok({}), reopen: ok({}) },
    voidSvc: { voidSale: ok({ replayed: false }) },
  };

  /** Stand-in for the JWT strategy: x-role is the token's role; x-imp marks an impersonation token. */
  const fakeJwt: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers["x-role"];
      if (!role) throw new UnauthorizedException();
      req.user = {
        role,
        sub: "u-1",
        tenantId: req.headers["x-no-tenant"] ? null : "t-1",
        impersonatedBy: req.headers["x-imp"] ? "sa-1" : undefined,
      };
      return true;
    },
  };

  beforeAll(async () => {
    const proxy = (svc: object) =>
      new Proxy(svc, {
        get: (t, p) =>
          typeof p === "symbol" || p === "then"
            ? undefined
            : ((t as never)[p] ?? jest.fn().mockResolvedValue({})),
      });
    const moduleRef = await Test.createTestingModule({
      controllers: [
        CounterSaleController,
        CounterParkController,
        PickupCompleteController,
        CounterDayCloseController,
        CounterSaleVoidController,
      ],
      providers: [
        { provide: PrismaService, useValue: { user: { findFirst } } },
        { provide: CounterSaleService, useValue: proxy(services.sale) },
        { provide: CounterSaleTodayService, useValue: proxy(services.today) },
        { provide: QuickKeysService, useValue: proxy(services.keys) },
        { provide: CounterParkService, useValue: proxy(services.park) },
        { provide: PickupCompleteService, useValue: proxy(services.pickup) },
        { provide: CounterDayCloseService, useValue: proxy(services.close) },
        { provide: CounterSaleVoidService, useValue: proxy(services.voidSvc) },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwt)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    findFirst.mockReset();
    findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 1 });
  });

  const send = (verb: "get" | "post" | "delete", path: string, role: string, imp = false) => {
    const req = request(app.getHttpServer())[verb](path).set("x-role", role);
    if (imp) req.set("x-imp", "1");
    return req.set("Idempotency-Key", IDEM);
  };
  const deny = (groups: string[]) =>
    findFirst.mockResolvedValue({ deniedPermissionGroups: groups, permissionsVersion: 2 });

  it("OPERATOR with ORDERS denied: ringing a sale is 403 PERMISSION_DENIED with the group, and the service never runs", async () => {
    deny(["ORDERS"]);
    const res = await send("post", "/orders/counter-sale", "OPERATOR").send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
      groups: [STAFF_CAPABILITY_RULES.USE_POS_MODE.group],
    });
    expect(res.body.groups).toEqual(["ORDERS"]);
    expect(services.sale.ring).not.toHaveBeenCalled();
  });

  it.each([
    ["get", "/orders/counter-sale/today"],
    ["get", "/orders/counter-sale/quick-keys"],
    ["get", "/orders/counter-sale/by-key/k-1"],
    ["get", "/orders/counter-sale/parked"],
    ["post", "/orders/counter-sale/parked"],
    ["post", `/orders/counter-sale/parked/${ID}/resume`],
    ["delete", `/orders/counter-sale/parked/${ID}`],
    ["post", `/orders/${ID}/pickup-complete`],
    ["get", "/orders/counter-sale/day-close"],
    ["get", "/orders/counter-sale/day-close/latest"],
    ["get", `/orders/counter-sale/day-close/${ID}`],
    ["post", "/orders/counter-sale/day-close"],
    ["post", `/orders/counter-sale/day-close/${ID}/reopen`],
    ["post", `/orders/counter-sale/day-close/${ID}/report`],
  ] as const)("a denied OPERATOR is refused on %s %s", async (verb, path) => {
    deny(["ORDERS"]);
    const res = await send(verb, path, "OPERATOR").send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
  });

  it("OPERATOR with other groups denied (not ORDERS) still passes", async () => {
    deny(["PRICING", "FINANCE"]);
    const res = await send("get", "/orders/counter-sale/today", "OPERATOR");
    expect(res.status).toBe(200);
  });

  it("OPERATOR with no denials passes", async () => {
    const res = await send("get", "/orders/counter-sale/today", "OPERATOR");
    expect(res.status).toBe(200);
  });

  it("the permissions read is scoped to the caller's tenant (never another tenant's row)", async () => {
    await send("get", "/orders/counter-sale/today", "OPERATOR");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "u-1", tenantId: "t-1" }) }),
    );
  });

  it("OPERATOR with no tenantId on the token is refused (fails closed)", async () => {
    const res = await send("get", "/orders/counter-sale/today", "OPERATOR").set("x-no-tenant", "1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PERMISSION_DENIED");
  });

  it("OPERATOR with no row at all is refused (fails closed)", async () => {
    findFirst.mockResolvedValue(null);
    const res = await send("get", "/orders/counter-sale/today", "OPERATOR");
    expect(res.status).toBe(403);
    expect(res.body.groups).toEqual(["ORDERS"]);
  });

  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])(
    "%s passes with no permissions read, whatever any row says",
    async (role) => {
      deny(["ORDERS"]);
      const res = await send("get", "/orders/counter-sale/today", role);
      expect(res.status).toBe(200);
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("an impersonation token passes with no permissions read", async () => {
    deny(["ORDERS"]);
    const res = await send("get", "/orders/counter-sale/today", "TENANT_ADMIN", true);
    expect(res.status).toBe(200);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each(["DRIVER", "CUSTOMER"])(
    "%s is refused by the role gate before any permissions read (D2 pin)",
    async (role) => {
      const res = await send("post", "/orders/counter-sale", role).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).not.toBe("PERMISSION_DENIED");
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("the permissions are read live per request: a switch-off takes effect on the next call", async () => {
    expect((await send("get", "/orders/counter-sale/today", "OPERATOR")).status).toBe(200);
    deny(["ORDERS"]);
    expect((await send("get", "/orders/counter-sale/today", "OPERATOR")).status).toBe(403);
  });

  it("the counter-sale void is unchanged: a denied OPERATOR is not stopped by the till guard", async () => {
    deny(["ORDERS"]);
    const res = await send("post", `/orders/counter-sale/${ID}/void`, "OPERATOR").send({});
    expect(res.body.code).not.toBe("PERMISSION_DENIED");
    expect(findFirst).not.toHaveBeenCalled();
  });
});
