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
import { CounterParkController } from "./counter-park.controller";
import { CounterParkService } from "./counter-park.service";
import { CounterSaleController } from "./counter-sale.controller";
import { PickupCompleteController } from "./pickup-complete.controller";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/** The HTTP edge of the parked-sale routes (SA-748): route resolution, the role gate, the DTO pipe. */

const ID = "00000000-0000-4000-8000-000000000001";
const ATTEMPT = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
type Route = { controller: string; handler: string; method: RequestMethod; path: string };

/** Every route of every controller of the orders module, as the full path template Nest registers, in module order. */
function routes(): Route[] {
  const out: Route[] = [];
  for (const ctrl of [
    OrdersController,
    CounterSaleController,
    CounterParkController,
    PickupCompleteController,
  ]) {
    const base = String(Reflect.getMetadata("path", ctrl)).replace(/^\/|\/$/g, "");
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const fn = (ctrl.prototype as unknown as Record<string, unknown>)[name];
      if (typeof fn !== "function" || name === "constructor") continue;
      const method = Reflect.getMetadata("method", fn) as RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = String(Reflect.getMetadata("path", fn) ?? "").replace(/^\/|\/$/g, "");
      out.push({
        controller: ctrl.name,
        handler: name,
        method,
        path: [base, sub].filter(Boolean).join("/"),
      });
    }
  }
  return out;
}
const matches = (template: string, url: string) =>
  new RegExp(`^${template.replace(/:[^/]+/g, "[^/]+")}$`).test(url);
/** The FIRST route in registration order that takes this request: what Express would run. */
const firstHit = (method: RequestMethod, url: string) =>
  routes().find((r) => r.method === method && matches(r.path, url));

describe("route resolution: no earlier or parameterised route can swallow a parked-sale route", () => {
  it.each([
    [RequestMethod.POST, "orders/counter-sale/parked", "park"],
    [RequestMethod.GET, "orders/counter-sale/parked", "list"],
    [RequestMethod.POST, `orders/counter-sale/parked/${ID}/resume`, "resume"],
    [RequestMethod.DELETE, `orders/counter-sale/parked/${ID}`, "discard"],
  ])("%s %s is CounterParkController.%s, and no other route matches it", (method, url, handler) => {
    const hits = routes().filter((r) => r.method === method && matches(r.path, url));
    expect(hits.map((r) => `${r.controller}.${r.handler}`)).toEqual([
      `CounterParkController.${handler}`,
    ]);
    expect(firstHit(method, url)?.controller).toBe("CounterParkController");
  });

  it("the sibling counter routes still resolve to themselves", () => {
    expect(firstHit(RequestMethod.GET, "orders/counter-sale/today")?.handler).toBe("today");
    expect(firstHit(RequestMethod.GET, "orders/counter-sale/by-key/k-1")?.handler).toBe("byKey");
    expect(firstHit(RequestMethod.POST, "orders/counter-sale")?.handler).toBe("ring");
    expect(firstHit(RequestMethod.GET, `orders/${ID}`)?.controller).toBe("OrdersController");
  });
});

describe("the parked-sale routes over HTTP (roles and the DTO pipe)", () => {
  let app: INestApplication;
  const svc = {
    park: jest.fn().mockResolvedValue({ id: ID }),
    list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 }),
    resume: jest.fn().mockResolvedValue({ id: ID }),
    discard: jest.fn().mockResolvedValue(undefined),
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
      controllers: [CounterParkController],
      providers: [{ provide: CounterParkService, useValue: svc }],
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
  beforeEach(() => Object.values(svc).forEach((m) => m.mockClear()));

  const body = (over: Record<string, unknown> = {}) => ({
    id: ID,
    payload: { lines: [], method: "CASH" },
    ...over,
  });
  const call = (verb: "get" | "post" | "delete", path: string, role?: string) => {
    const req = request(app.getHttpServer())[verb](path);
    if (role) req.set("x-role", role);
    return req;
  };

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s may park, list, resume and discard", async (role) => {
    await call("post", "/orders/counter-sale/parked", role).send(body()).expect(201);
    await call("get", "/orders/counter-sale/parked", role).expect(200);
    await call("post", `/orders/counter-sale/parked/${ID}/resume`, role)
      .send({ resumeAttemptId: ATTEMPT })
      .expect(201);
    await call("delete", `/orders/counter-sale/parked/${ID}`, role).expect(204);
    expect(svc.park).toHaveBeenCalledTimes(1);
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.resume).toHaveBeenCalledWith(ID, ATTEMPT, expect.objectContaining({ sub: "u-1" }));
    expect(svc.discard).toHaveBeenCalledWith(ID);
  });

  it.each([
    ["no body", undefined],
    ["no resumeAttemptId", {}],
    ["a non-uuid attempt id", { resumeAttemptId: "tap-1" }],
    ["a uuid that is not v4", { resumeAttemptId: "a1a1a1a1-a1a1-1a1a-8a1a-a1a1a1a1a1a1" }],
    ["an unknown key", { resumeAttemptId: ATTEMPT, actor: "u-2" }],
  ])("resume with %s is a 400 before the service runs", async (_n, sent) => {
    await call("post", `/orders/counter-sale/parked/${ID}/resume`, "OPERATOR")
      .send(sent as never)
      .expect(400);
    expect(svc.resume).not.toHaveBeenCalled();
  });

  it.each(["DRIVER", "CUSTOMER"])(
    "%s is refused (403) on every route; the service never runs",
    async (role) => {
      await call("post", "/orders/counter-sale/parked", role).send(body()).expect(403);
      await call("get", "/orders/counter-sale/parked", role).expect(403);
      await call("post", `/orders/counter-sale/parked/${ID}/resume`, role).expect(403);
      await call("delete", `/orders/counter-sale/parked/${ID}`, role).expect(403);
      for (const m of Object.values(svc)) expect(m).not.toHaveBeenCalled();
    },
  );

  it("no token: 401", async () => {
    await call("get", "/orders/counter-sale/parked").expect(401);
    await call("post", "/orders/counter-sale/parked").send(body()).expect(401);
    for (const m of Object.values(svc)) expect(m).not.toHaveBeenCalled();
  });

  it("park body: a valid one reaches the service, the label is trimmed", async () => {
    await call("post", "/orders/counter-sale/parked", "OPERATOR")
      .send(body({ registerKey: "front-2", label: "  Aisle 3 " }))
      .expect(201);
    expect(svc.park).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, registerKey: "front-2", label: "Aisle 3" }),
      expect.anything(),
    );
  });

  it.each(["Front-1", "main", "a:b"])(
    "park body: registerKey %s is accepted (shared pattern)",
    async (key) => {
      await call("post", "/orders/counter-sale/parked", "OPERATOR")
        .send(body({ registerKey: key }))
        .expect(201);
      expect(svc.park).toHaveBeenCalledWith(
        expect.objectContaining({ registerKey: key }),
        expect.anything(),
      );
    },
  );

  it.each([
    ["no id", { id: undefined }],
    ["a non-UUID id", { id: "not-a-uuid" }],
    ["a bad registerKey", { registerKey: "bad key!" }],
    ["a registerKey over 64", { registerKey: "x".repeat(65) }],
    ["a registerKey with a leading colon", { registerKey: ":front" }],
    ["a label over 60", { label: "L".repeat(61) }],
    ["no payload", { payload: undefined }],
    ["a payload that is not an object", { payload: "lines" }],
    ["an unknown top-level key", { tenantId: "t-2" }],
  ])("park with %s is a 400 before the service runs", async (_n, over) => {
    await call("post", "/orders/counter-sale/parked", "OPERATOR").send(body(over)).expect(400);
    expect(svc.park).not.toHaveBeenCalled();
  });

  it("list query reaches the service typed; a bad page or size is a 400; an invalid register is NOT an error", async () => {
    await call(
      "get",
      "/orders/counter-sale/parked?register=front-2&page=2&pageSize=5",
      "OPERATOR",
    ).expect(200);
    expect(svc.list).toHaveBeenCalledWith(
      expect.objectContaining({ register: "front-2", page: 2, pageSize: 5 }),
    );
    await call("get", "/orders/counter-sale/parked?register=bad%20key!", "OPERATOR").expect(200);
    for (const qs of ["page=0", "pageSize=51", "pageSize=0", "clerk=u-1"]) {
      svc.list.mockClear();
      await call("get", `/orders/counter-sale/parked?${qs}`, "OPERATOR").expect(400);
      expect(svc.list).not.toHaveBeenCalled();
    }
  });
});
