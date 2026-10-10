/**
 * The preview and the change are throttled to 10 / 60 s (the global 100 / 60 s would let a script
 * hammer the aggregate counts behind the preview). Drives a real Nest app with the PRODUCTION
 * throttler set and the real global ThrottlerGuard; only the auth guards are opened and the
 * service is a stub. The throttle KEY is the guard's default, the client IP (per route handler):
 * two admins behind one office IP share the 10, which is the documented trade-off (SA Q9).
 */
import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { buildThrottlers } from "../common/throttlers";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { FulfilmentEditGuard } from "./fulfilment-edit";
import { SettingsFulfilmentController } from "./settings-fulfilment.controller";
import { SettingsFulfilmentService } from "./settings-fulfilment.service";

describe("settings/fulfilment throttle (real guard chain)", () => {
  let app: INestApplication;
  const service = {
    get: jest.fn(async () => ({ ok: true })),
    preview: jest.fn(async () => ({ ok: true })),
    update: jest.fn(async () => ({ ok: true })),
  };

  beforeAll(async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const open = { canActivate: () => true };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: buildThrottlers(config) })],
      controllers: [SettingsFulfilmentController],
      providers: [
        { provide: SettingsFulfilmentService, useValue: service },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(open)
      .overrideGuard(RolesGuard)
      .useValue(open)
      .overrideGuard(FulfilmentEditGuard)
      .useValue(open)
      .compile();
    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });

  const statuses = async (n: number, send: () => Promise<{ status: number }>) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await send()).status);
    return out;
  };

  it("PATCH: the 11th call inside a minute is a 429", async () => {
    const s = await statuses(11, () =>
      request(app.getHttpServer()).patch("/settings/fulfilment").send({}),
    );
    expect(s.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(s[10]).toBe(429);
  });

  it("POST preview: the 11th call inside a minute is a 429", async () => {
    const s = await statuses(11, () =>
      request(app.getHttpServer()).post("/settings/fulfilment/preview").send({}),
    );
    expect(s.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(s[10]).toBe(429);
  });

  it("GET keeps the ordinary limit (not 10)", async () => {
    const s = await statuses(12, () => request(app.getHttpServer()).get("/settings/fulfilment"));
    expect(s.every((x) => x === 200)).toBe(true);
  });
});
