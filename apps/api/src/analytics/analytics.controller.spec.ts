import { BadRequestException } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import type { AnalyticsService } from "./analytics.service";

/**
 * The controller is a thin pass-through, so it is instantiated directly rather than
 * through a Nest testing module — the only logic worth covering is the `range`
 * validation branch, which has no dependencies.
 */
describe("AnalyticsController", () => {
  let service: {
    getProductDemand: jest.Mock;
    getRoutePerformance: jest.Mock;
    getDriverPerformance: jest.Mock;
  };
  let controller: AnalyticsController;

  beforeEach(() => {
    service = {
      getProductDemand: jest.fn().mockResolvedValue({}),
      getRoutePerformance: jest.fn().mockResolvedValue([]),
      getDriverPerformance: jest.fn().mockResolvedValue([]),
    };
    controller = new AnalyticsController(service as unknown as AnalyticsService);
  });

  describe("getProductDemand", () => {
    it("defaults to 30d when range is absent", () => {
      controller.getProductDemand("p1");
      expect(service.getProductDemand).toHaveBeenCalledWith("p1", "30d");
    });

    it.each(["30d", "6m", "1y", "5y"])("passes %s through", (range) => {
      controller.getProductDemand("p1", range);
      expect(service.getProductDemand).toHaveBeenCalledWith("p1", range);
    });

    it("trims and lowercases before validating", () => {
      controller.getProductDemand("p1", " 6M ");
      expect(service.getProductDemand).toHaveBeenCalledWith("p1", "6m");
    });

    it.each(["6mo", "1yr", "90d", "week", ""])(
      "rejects %p instead of silently defaulting",
      (range) => {
        // "" is the one case that still defaults — an absent param and an empty one are
        // indistinguishable over HTTP.
        if (range === "") {
          controller.getProductDemand("p1", range);
          expect(service.getProductDemand).toHaveBeenCalledWith("p1", "30d");
          return;
        }
        expect(() => controller.getProductDemand("p1", range)).toThrow(BadRequestException);
        expect(service.getProductDemand).not.toHaveBeenCalled();
      },
    );
  });

  describe("route/driver performance", () => {
    it("forwards from/to to both service methods — the web date picker was silently ignored", () => {
      controller.getRoutes("2026-06-01", "2026-06-30");
      expect(service.getRoutePerformance).toHaveBeenCalledWith("2026-06-01", "2026-06-30");

      controller.getDrivers("2026-06-01", "2026-06-30");
      expect(service.getDriverPerformance).toHaveBeenCalledWith("2026-06-01", "2026-06-30");
    });

    it("forwards absent params as undefined (all-time, the mobile admin call)", () => {
      controller.getRoutes();
      expect(service.getRoutePerformance).toHaveBeenCalledWith(undefined, undefined);

      controller.getDrivers();
      expect(service.getDriverPerformance).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  it("lists the demand route in the self-describing index", () => {
    expect(controller.getIndex().endpoints).toContain("GET /analytics/demand/:productId");
  });
});
