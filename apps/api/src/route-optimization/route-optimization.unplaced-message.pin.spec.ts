import { readFileSync } from "fs";
import { join } from "path";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RouteOptimizationService } from "./route-optimization.service";

/**
 * W1 (COPY 2s): a customer the geocoder could not place reads as something the admin can fix. A tenant cannot set a
 * server key, so the old line ("Set GOOGLE_MAPS_API_KEY to auto-geocode") sent them to a setting they do not have.
 * Both routes that validate stop coordinates (optimize and the run reorder) carry the same words.
 */
const SRC = readFileSync(join(__dirname, "route-optimization.service.ts"), "utf8");

describe("route optimization: the unplaced-customers message", () => {
  it("says what to check, on both validation sites", () => {
    const line = "We couldn't place these customers on the map: ${names}. Check their addresses.";
    expect(SRC.split(line)).toHaveLength(3);
  });

  it("no longer tells a tenant to set a server key", () => {
    expect(SRC).not.toMatch(/Set GOOGLE_MAPS_API_KEY/);
    expect(SRC).not.toMatch(/Missing geocoded addresses/);
  });
});

/**
 * UXG B14. Entry condition: the stops reach the "missing coords" filter (no Maps key, so geocoding yields nothing, and
 * the addresses have no lat/lng). Red before the fix: the 400 carried only the sentence (no code, count or names).
 */
describe("route optimization: the unplaced refusal is coded (B14)", () => {
  const stop = (id: string, name: string) => ({
    id,
    stopNumber: 1,
    customerId: `c-${id}`,
    customer: { id: `c-${id}`, businessName: name },
    customerAddress: {
      id: `a-${id}`,
      line1: "1 Main St",
      city: "Austin",
      state: "TX",
      lat: null,
      lng: null,
    },
  });
  it("optimizeTemplate throws code, count, names and keeps today's sentence verbatim", async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        RouteOptimizationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: RouteFlowGateway, useValue: { emitRouteProgress: jest.fn() } },
      ],
    }).compile();
    const service = mod.get(RouteOptimizationService);
    (prisma.forTenant() as any).route.findUnique.mockResolvedValue({
      id: "r1",
      stops: [stop("s1", "Acme Deli"), stop("s2", "Acme Market")],
    });
    const err = await service.optimizeTemplate("r1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual({
      code: API_ERROR_CODES.ROUTE_STOPS_NOT_PLACED,
      message:
        "We couldn't place these customers on the map: Acme Deli, Acme Market. Check their addresses.",
      count: 2,
      names: ["Acme Deli", "Acme Market"],
    });
  });
});
