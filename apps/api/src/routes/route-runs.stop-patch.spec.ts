import { CanActivate, INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { RouteRunsController } from "./routes.controller";
import { RoutesService } from "./routes.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { AddonGuard } from "../billing/addon.guard";
import { DriverPaymentsGuard } from "./driver-payments.guard";
import { listenOnLoopback } from "../common/testing/listen-loopback";

/**
 * #2109: PATCH /route-runs/:id/stops/:stopId took an inline-typed body, so the global
 * ValidationPipe (whitelist + forbidNonWhitelisted, main.ts) had no class to validate against and
 * any body reached the service, including status "COMPLETED". Completion has its own endpoints
 * (complete / complete-with-payment: they reverse-safe the delivery mutations, stock and payment
 * guard); flipping the column here strands those side effects. The body is now UpdateStopStatusDto.
 * This drives the real controller over HTTP with the same pipe options main.ts sets.
 */
describe("PATCH /route-runs/:id/stops/:stopId body validation (#2109)", () => {
  let app: INestApplication;
  const routesService = { updateStopStatus: jest.fn().mockResolvedValue({ ok: true }) };
  const allow: CanActivate = { canActivate: () => true };
  const patch = (body: unknown) =>
    request(app.getHttpServer()).patch("/route-runs/run-1/stops/stop-1").send(body);

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [RouteRunsController],
      providers: [{ provide: RoutesService, useValue: routesService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(AddonGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue(allow)
      .overrideGuard(DriverPaymentsGuard)
      .useValue(allow)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await listenOnLoopback(app); // #2267: bind 127.0.0.1 before any request
  });

  afterEach(async () => {
    await app.close();
  });

  it("refuses COMPLETED through PATCH: 400, the service is never called", async () => {
    const res = await patch({ status: "COMPLETED" });
    expect(res.status).toBe(400);
    expect(routesService.updateStopStatus).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "completed", "", "ARRIVED"])("refuses status %p", async (status) => {
    const res = await patch({ status });
    expect(res.status).toBe(400);
    expect(routesService.updateStopStatus).not.toHaveBeenCalled();
  });

  it("refuses a missing status and a non-string driverNote", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch({ status: "SKIPPED", driverNote: 42 })).status).toBe(400);
    expect(routesService.updateStopStatus).not.toHaveBeenCalled();
  });

  it("refuses unknown properties (whitelist), e.g. arrivedAt or completedAt", async () => {
    const res = await patch({ status: "IN_PROGRESS", arrivedAt: "2020-01-01T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(routesService.updateStopStatus).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "IN_PROGRESS" }],
    [{ status: "SKIPPED" }],
    [{ status: "SKIPPED", driverNote: "gate locked" }],
  ])("still accepts the two shapes the clients send: %j", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(routesService.updateStopStatus).toHaveBeenCalledTimes(1);
    const [runId, stopId, dto] = routesService.updateStopStatus.mock.calls[0];
    expect([runId, stopId]).toEqual(["run-1", "stop-1"]);
    expect(dto).toMatchObject(body);
  });
});
