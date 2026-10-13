import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { RouteOptimizationService } from "./route-optimization.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";

/**
 * A blank-street address (no street, no city: a "minimal" state-only address) is never geocoded by
 * route optimization: it would pin the stop to the state's centroid. Same rule as `geocodeAddress`
 * in common/geocode.util (`hasBlankStreet`).
 */
describe("RouteOptimizationService.geocodeAddress skips a blank-street address", () => {
  let service: RouteOptimizationService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "OK",
        results: [{ geometry: { location: { lat: 30.2, lng: -97.7 } } }],
      }),
    } as any);
    const mod = await Test.createTestingModule({
      providers: [
        RouteOptimizationService,
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitRouteProgress: jest.fn() } },
      ],
    }).compile();
    service = mod.get(RouteOptimizationService);
  });
  afterEach(() => fetchSpy.mockRestore());

  const geocode = (a: { line1: string; city: string; state: string; zip: string }) =>
    (service as any).geocodeAddress(a);

  it("blank line1 AND blank city: null, and the geocoder is never called", async () => {
    expect(await geocode({ line1: "", city: " ", state: "TX", zip: "75201" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a street or a city alone still geocodes", async () => {
    await geocode({ line1: "1 Main St", city: "", state: "TX", zip: "" });
    await geocode({ line1: "", city: "Austin", state: "TX", zip: "" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
