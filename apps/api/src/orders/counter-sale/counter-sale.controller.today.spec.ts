jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  RequestMethod,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { listenOnLoopback } from "../../common/testing/listen-loopback";
import { OrdersController } from "../orders.controller";
import { CounterSaleController } from "./counter-sale.controller";
import { CounterSaleService } from "./counter-sale.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import { PickupCompleteController } from "./pickup-complete.controller";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/** The HTTP edge of GET /orders/counter-sale/today: route resolution, the role gate, the query pipe. */

type Route = { controller: string; handler: string; path: string };

/** Every GET route of the orders controllers, as the full path template Nest registers. */
function getRoutes(): Route[] {
  const out: Route[] = [];
  for (const ctrl of [OrdersController, CounterSaleController, PickupCompleteController]) {
    const base = String(Reflect.getMetadata("path", ctrl)).replace(/^\/|\/$/g, "");
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = (ctrl.prototype as Record<string, unknown>)[name];
      if (typeof fn !== "function" || name === "constructor") continue;
      if (Reflect.getMetadata("method", fn) !== RequestMethod.GET) continue;
      const sub = String(Reflect.getMetadata("path", fn) ?? "").replace(/^\/|\/$/g, "");
      out.push({
        controller: ctrl.name,
        handler: name,
        path: [base, sub].filter(Boolean).join("/"),
      });
    }
  }
  return out;
}
const matchesPath = (template: string, url: string) =>
  new RegExp(`^${template.replace(/:[^/]+/g, "[^/]+")}$`).test(url);

describe("route resolution (test 13)", () => {
  it("GET /orders/counter-sale/today is the counter route, and no other GET route can take it", () => {
    const hits = getRoutes().filter((r) => matchesPath(r.path, "orders/counter-sale/today"));
    expect(hits).toEqual([
      { controller: "CounterSaleController", handler: "today", path: "orders/counter-sale/today" },
    ]);
  });

  it("GET /orders/counter-sale/by-key/:key still resolves to byKey alone", () => {
    const hits = getRoutes().filter((r) => matchesPath(r.path, "orders/counter-sale/by-key/k-1"));
    expect(hits.map((r) => r.handler)).toEqual(["byKey"]);
  });

  it("GET /orders/:id and GET /orders are untouched (still the orders controller)", () => {
    const id = getRoutes().filter((r) => matchesPath(r.path, "orders/abc"));
    expect(id.map((r) => `${r.controller}.${r.handler}`)).toEqual(["OrdersController.findOne"]);
    const list = getRoutes().filter((r) => matchesPath(r.path, "orders"));
    expect(list.map((r) => `${r.controller}.${r.handler}`)).toEqual(["OrdersController.findAll"]);
  });
});

describe("GET /orders/counter-sale/today over HTTP (test 6, roles and pipe)", () => {
  let app: INestApplication;
  const todays = {
    today: jest.fn().mockResolvedValue({ data: [], meta: { total: 0 }, summary: null }),
  };

  /** Stand-in for the JWT strategy: the x-role header is the token's role, absent = no token. */
  const fakeJwt: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers["x-role"];
      if (!role) throw new UnauthorizedException();
      req.user = { role, sub: "u-1" };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CounterSaleController],
      providers: [
        { provide: CounterSaleService, useValue: {} },
        { provide: CounterSaleTodayService, useValue: todays },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwt)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => todays.today.mockClear());

  const get = (path: string, role?: string) => {
    const req = request(app.getHttpServer()).get(path);
    if (role) req.set("x-role", role);
    return req;
  };

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s: 200 and the service is called", async (role) => {
    await get("/orders/counter-sale/today", role).expect(200);
    expect(todays.today).toHaveBeenCalledTimes(1);
  });

  it.each(["DRIVER", "CUSTOMER"])("%s: 403 and the service is never called", async (role) => {
    await get("/orders/counter-sale/today", role).expect(403);
    expect(todays.today).not.toHaveBeenCalled();
  });

  it("no token: 401", async () => {
    await get("/orders/counter-sale/today").expect(401);
    expect(todays.today).not.toHaveBeenCalled();
  });

  it("the query reaches the service typed (page and limit are numbers)", async () => {
    await get("/orders/counter-sale/today?day=2026-10-07&page=2&limit=25", "OPERATOR").expect(200);
    expect(todays.today).toHaveBeenCalledWith(
      expect.objectContaining({ day: "2026-10-07", page: 2, limit: 25 }),
    );
  });

  it.each(["limit=101", "page=0", "day=2026-02-30", "day=abc", "clerk=u-1"])(
    "?%s is a 400 before the service runs",
    async (qs) => {
      await get(`/orders/counter-sale/today?${qs}`, "OPERATOR").expect(400);
      expect(todays.today).not.toHaveBeenCalled();
    },
  );
});
