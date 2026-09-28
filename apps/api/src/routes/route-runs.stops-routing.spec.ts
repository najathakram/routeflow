import { CanActivate, INestApplication } from "@nestjs/common";
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
 * #2110: PATCH /route-runs/:id/stops/reorder used to be declared AFTER
 * PATCH /route-runs/:id/stops/:stopId, so Express matched "reorder" as a :stopId and the
 * reorder handler was unreachable (the stop-status handler ran instead). This drives the real
 * routing table over HTTP with the guards allowed and the service mocked.
 */
describe("RouteRunsController: stop routes resolve to the right handler (#2110)", () => {
  let app: INestApplication;
  const routesService = {
    reorderRunStops: jest.fn().mockResolvedValue({ ok: true }),
    updateStopStatus: jest.fn().mockResolvedValue({ ok: true }),
  };
  const allow: CanActivate = { canActivate: () => true };

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
    await listenOnLoopback(app); // #2267: bind 127.0.0.1 before any request
  });

  afterEach(async () => {
    await app.close();
  });

  it("PATCH :id/stops/reorder reaches reorderRunStops, not updateStopStatus", async () => {
    const order = [
      { id: "s1", stopNumber: 2 },
      { id: "s2", stopNumber: 1 },
    ];
    await request(app.getHttpServer()).patch("/route-runs/run-1/stops/reorder").send({ order });
    expect(routesService.reorderRunStops).toHaveBeenCalledWith("run-1", order);
    expect(routesService.updateStopStatus).not.toHaveBeenCalled();
  });

  it("PATCH :id/stops/:stopId still reaches updateStopStatus for a real stop id", async () => {
    await request(app.getHttpServer())
      .patch("/route-runs/run-1/stops/stop-9")
      .send({ status: "SKIPPED" });
    expect(routesService.updateStopStatus).toHaveBeenCalledTimes(1);
    expect(routesService.updateStopStatus.mock.calls[0][0]).toBe("run-1");
    expect(routesService.updateStopStatus.mock.calls[0][1]).toBe("stop-9");
    expect(routesService.reorderRunStops).not.toHaveBeenCalled();
  });
});
