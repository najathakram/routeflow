/**
 * W3 real-Nest integration: the whole join rests on `req.route.path` carrying the GLOBAL PREFIX once a
 * route matches ("GET /api/v1/customers/:id"), exactly the audit's route format. This boots a real Nest
 * app with `setGlobalPrefix("api/v1")`, the real interceptor and service, and a fake Redis.
 */
import {
  CanActivate,
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { RouteHitsModule } from "./route-hits.module";
import { RouteHitsRedis, RouteHitsService } from "./route-hits.service";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException();
  }
}

@Controller("customers")
class CustomersStubController {
  @Get(":id")
  one(@Param("id") id: string) {
    return { id };
  }
  @Post()
  create() {
    return { ok: true };
  }
  @Get("boom/now")
  boom() {
    throw new Error("handler failed");
  }
  @UseGuards(DenyGuard)
  @Get("denied/route")
  denied() {
    return {};
  }
}

describe("route hit counter (real Nest app)", () => {
  let app: INestApplication;
  let hits: RouteHitsService;
  const written: Array<[string, string, number]> = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), RouteHitsModule],
      controllers: [CustomersStubController],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await listenOnLoopback(app); // #2267: bind to 127.0.0.1 once, before any request
    hits = app.get(RouteHitsService);
    hits.enabled = true;
    const redis: RouteHitsRedis = {
      pipeline: () => ({
        hincrby: (k: string, f: string, n: number) => written.push([k, f, n]),
        expire: () => undefined,
        exec: async () => [],
      }),
    };
    hits.attachRedis(redis);
  });
  afterAll(async () => {
    await app.close();
  });

  it("counts the TEMPLATE with the global prefix, collapses ids, counts a throwing handler, skips guard-denied", async () => {
    await request(app.getHttpServer()).get("/api/v1/customers/cust-1").expect(200);
    await request(app.getHttpServer()).get("/api/v1/customers/cust-2").expect(200);
    await request(app.getHttpServer()).post("/api/v1/customers").expect(201);
    await request(app.getHttpServer()).get("/api/v1/customers/boom/now").expect(500);
    await request(app.getHttpServer()).get("/api/v1/customers/denied/route").expect(403);
    await request(app.getHttpServer()).get("/api/v1/does/not/exist").expect(404);

    await hits.flush(new Date("2026-10-02T12:00:00Z"));
    const byRoute = Object.fromEntries(written.map(([, route, n]) => [route, n]));
    expect(byRoute).toEqual({
      "GET /api/v1/customers/:id": 2, // both ids collapse into the template
      "POST /api/v1/customers": 1,
      "GET /api/v1/customers/boom/now": 1, // counted although the handler threw
      // the guard-denied route and the unmatched 404 never reach the interceptor: not counted
    });
    expect(JSON.stringify(written)).not.toMatch(/cust-1|cust-2/);
  });
});
