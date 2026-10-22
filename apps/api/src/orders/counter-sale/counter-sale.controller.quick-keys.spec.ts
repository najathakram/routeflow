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
import { PrismaService } from "../../prisma/prisma.service";
import { listenOnLoopback } from "../../common/testing/listen-loopback";
import { OrdersController } from "../orders.controller";
import { CounterSaleController } from "./counter-sale.controller";
import { CounterSaleService } from "./counter-sale.service";
import { CounterSaleTodayService } from "./counter-sale-today.service";
import { PickupCompleteController } from "./pickup-complete.controller";
import { QuickKeysService } from "./quick-keys.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/** The HTTP edge of GET /orders/counter-sale/quick-keys: route resolution, the role gate, the register query. */

function getRoutes() {
  const out: { handler: string; path: string; controller: string }[] = [];
  for (const ctrl of [OrdersController, CounterSaleController, PickupCompleteController]) {
    const base = String(Reflect.getMetadata("path", ctrl)).replace(/^\/|\/$/g, "");
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = (ctrl.prototype as unknown as Record<string, unknown>)[name];
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

describe("route resolution", () => {
  it("GET /orders/counter-sale/quick-keys is the counter route and no other GET route can take it", () => {
    const hits = getRoutes().filter((r) => matchesPath(r.path, "orders/counter-sale/quick-keys"));
    expect(hits).toEqual([
      {
        controller: "CounterSaleController",
        handler: "quickKeysGrid",
        path: "orders/counter-sale/quick-keys",
      },
    ]);
  });
});

describe("GET /orders/counter-sale/quick-keys over HTTP (roles and register)", () => {
  let app: INestApplication;
  const grid = { register: "main", keys: [], cap: 12 };
  const quickKeys = { get: jest.fn().mockResolvedValue(grid) };

  const fakeJwt: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers["x-role"];
      if (!role) throw new UnauthorizedException();
      req.user = { role, sub: "u-1", tenantId: "t-1" };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CounterSaleController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            user: {
              findFirst: jest
                .fn()
                .mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 1 }),
            },
          },
        },
        { provide: CounterSaleService, useValue: {} },
        { provide: CounterSaleTodayService, useValue: {} },
        { provide: QuickKeysService, useValue: quickKeys },
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
  beforeEach(() => quickKeys.get.mockClear());

  const get = (url: string, role?: string) => {
    const r = request(app.getHttpServer()).get(url);
    return role ? r.set("x-role", role) : r;
  };

  it("no token: 401", async () => {
    expect((await get("/orders/counter-sale/quick-keys")).status).toBe(401);
    expect(quickKeys.get).not.toHaveBeenCalled();
  });

  it.each(["CUSTOMER", "DRIVER"])("%s: 403 and the service is never called", async (role) => {
    expect((await get("/orders/counter-sale/quick-keys", role)).status).toBe(403);
    expect(quickKeys.get).not.toHaveBeenCalled();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s: 200 with the grid", async (role) => {
    const res = await get("/orders/counter-sale/quick-keys", role);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(grid);
    expect(quickKeys.get).toHaveBeenCalledWith(undefined);
  });

  it("forwards ?register= as given", async () => {
    await get("/orders/counter-sale/quick-keys?register=front", "OPERATOR");
    expect(quickKeys.get).toHaveBeenCalledWith("front");
  });

  it("a repeated ?register= still answers 200 and the service only ever sees a string or nothing", async () => {
    const res = await get("/orders/counter-sale/quick-keys?register=a&register=b", "OPERATOR");
    expect(res.status).toBe(200);
    const arg = quickKeys.get.mock.calls[0][0];
    expect(arg === undefined || typeof arg === "string").toBe(true);
  });
});
