import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RouteEndKind, RouteOptimizeMetric, RouteRunStatus } from "@prisma/client";
import { RouteOptimizationService, RouteVariant } from "./route-optimization.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RouteOptimizationService", () => {
  let service: RouteOptimizationService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let configGet: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    configGet = jest.fn().mockReturnValue(undefined);

    const mod = await Test.createTestingModule({
      providers: [
        RouteOptimizationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
      ],
    }).compile();
    service = mod.get(RouteOptimizationService);
  });

  // ─── solveOrder ─────────────────────────────────────────────────────────

  describe("solveOrder", () => {
    // Cost matrix hand-crafted so nearest-neighbour's greedy seed (index 0 =
    // fixed start) lands on [1,2,3,4] — but 2-opt finds a cheaper tour by
    // reversing the middle segment, landing on [1,3,2,4].
    const crossedMatrix = [
      [0, 1, 8, 8, 8],
      [1, 0, 2, 3, 9],
      [8, 2, 0, 2.5, 3],
      [8, 3, 2.5, 0, 5],
      [8, 9, 3, 5, 0],
    ];

    function tourCost(matrix: number[][], order: number[], tail?: number): number {
      let t = matrix[0][order[0]];
      for (let i = 0; i < order.length - 1; i++) t += matrix[order[i]][order[i + 1]];
      if (tail !== undefined) t += matrix[order[order.length - 1]][tail];
      return t;
    }

    it("improves on the nearest-neighbour seed via 2-opt on a crossed 4-stop case", () => {
      const order = (service as any).solveOrder(crossedMatrix, [1, 2, 3, 4]);
      // Pure NN (no 2-opt) would stop at [1,2,3,4] with cost 10.5; 2-opt must
      // find the cheaper [1,3,2,4] (cost 9.5).
      expect(tourCost(crossedMatrix, [1, 2, 3, 4])).toBe(10.5);
      expect(order).toEqual([1, 3, 2, 4]);
      expect(tourCost(crossedMatrix, order)).toBeLessThan(10.5);
    });

    it("keeps a fixed end out of the permutation and lets it steer which stop is visited last", () => {
      // Stop 1 is cheap to reach from the start AND expensive to reach the
      // fixed end from; stop 2 is the opposite. NN (blind to the end) greedily
      // visits 1 first, stranding the expensive-to-end stop 2 for last — 2-opt
      // must use the end-aware tour cost to flip the order.
      const matrix = [
        [0, 1, 5, 0], // 0=start; end index=3, cost[0][3] unused
        [1, 0, 1, 1], // stop1: cheap to end (index3 cost=1)
        [5, 1, 0, 10], // stop2: expensive to end (index3 cost=10)
        [0, 1, 10, 0],
      ];
      const withEnd = (service as any).solveOrder(matrix, [1, 2], 3);
      expect(withEnd).toEqual([2, 1]); // stop1 (cheap-to-end) pushed to last
      expect(tourCost(matrix, withEnd, 3)).toBeLessThan(tourCost(matrix, [1, 2], 3));

      // Without a fixed end, the same matrix's NN seed is already optimal —
      // no reason to prefer stop2 last.
      const withoutEnd = (service as any).solveOrder(matrix, [1, 2], undefined);
      expect(withoutEnd).toEqual([1, 2]);
    });

    it("produces a different order for a distance matrix than for a duration matrix on the same points", () => {
      // Mirrored chains: duration favors visiting 1→2→3, distance (indices 1
      // and 3 swapped) favors visiting 3→2→1.
      const durationSec = [
        [0, 1, 5, 9],
        [1, 0, 1, 5],
        [5, 1, 0, 1],
        [9, 5, 1, 0],
      ];
      const distanceMeters = [
        [0, 9, 5, 1],
        [9, 0, 1, 5],
        [5, 1, 0, 1],
        [1, 5, 1, 0],
      ];
      const byDuration = (service as any).solveOrder(durationSec, [1, 2, 3]);
      const byDistance = (service as any).solveOrder(distanceMeters, [1, 2, 3]);
      expect(byDuration).toEqual([1, 2, 3]);
      expect(byDistance).toEqual([3, 2, 1]);
      expect(byDuration).not.toEqual(byDistance);
    });

    it("returns the permutable list unchanged when it has 0 or 1 elements", () => {
      expect((service as any).solveOrder([[0]], [])).toEqual([]);
      expect(
        (service as any).solveOrder(
          [
            [0, 1],
            [1, 0],
          ],
          [1],
        ),
      ).toEqual([1]);
    });
  });

  // ─── dedupeVariants ─────────────────────────────────────────────────────

  describe("dedupeVariants", () => {
    function variant(overrides: Partial<RouteVariant>): RouteVariant {
      return {
        key: "FASTEST",
        stopIds: ["a", "b"],
        durationSec: 100,
        distanceMeters: 1000,
        hasTolls: false,
        encodedPolyline: null,
        ...overrides,
      };
    }

    it("drops a later variant whose stopIds match and totals are within 1%", () => {
      const first = variant({ key: "FASTEST", durationSec: 100, distanceMeters: 1000 });
      const second = variant({ key: "SHORTEST", durationSec: 100.5, distanceMeters: 1005 });
      const result = (service as any).dedupeVariants([first, second]);
      expect(result).toEqual([first]);
    });

    it("keeps both variants when stopIds match but totals differ by more than 1%", () => {
      const first = variant({ key: "FASTEST", durationSec: 100, distanceMeters: 1000 });
      const second = variant({ key: "NO_TOLLS", durationSec: 140, distanceMeters: 1000 });
      const result = (service as any).dedupeVariants([first, second]);
      expect(result).toEqual([first, second]);
    });

    it("keeps both variants when stopIds differ, even with identical totals", () => {
      const first = variant({ key: "FASTEST", stopIds: ["a", "b"] });
      const second = variant({ key: "SHORTEST", stopIds: ["b", "a"] });
      const result = (service as any).dedupeVariants([first, second]);
      expect(result).toEqual([first, second]);
    });
  });

  // ─── applyTollContrast ──────────────────────────────────────────────────
  // computeRoutePolyline deliberately never requests travelAdvisory.tollInfo
  // (Pro-tier double-pricing risk on computeRoutes) — hasTolls is derived by
  // contrasting each variant against the NO_TOLLS one instead.

  describe("applyTollContrast", () => {
    function variant(overrides: Partial<RouteVariant>): RouteVariant {
      return {
        key: "FASTEST",
        stopIds: ["a", "b"],
        durationSec: 100,
        distanceMeters: 1000,
        hasTolls: false,
        encodedPolyline: null,
        ...overrides,
      };
    }

    it("sets hasTolls false on every variant when no NO_TOLLS variant is present", () => {
      const results = [
        variant({ key: "FASTEST", durationSec: 100, hasTolls: true }),
        variant({ key: "SHORTEST", durationSec: 200, hasTolls: true }),
      ];
      (service as any).applyTollContrast(results);
      expect(results.map((r) => r.hasTolls)).toEqual([false, false]);
    });

    it("marks a variant hasTolls true when its duration diverges from NO_TOLLS by more than 2%", () => {
      const noTolls = variant({ key: "NO_TOLLS", stopIds: ["a", "b"], durationSec: 100 });
      const fastest = variant({ key: "FASTEST", stopIds: ["a", "b"], durationSec: 130 }); // 30% faster
      const results = [fastest, noTolls];
      (service as any).applyTollContrast(results);
      expect(fastest.hasTolls).toBe(true);
      expect(noTolls.hasTolls).toBe(false);
    });

    it("marks a variant hasTolls true when its stop order differs from NO_TOLLS, even at equal duration", () => {
      const noTolls = variant({ key: "NO_TOLLS", stopIds: ["a", "b"], durationSec: 100 });
      const fastest = variant({ key: "FASTEST", stopIds: ["b", "a"], durationSec: 100 });
      const results = [fastest, noTolls];
      (service as any).applyTollContrast(results);
      expect(fastest.hasTolls).toBe(true);
    });

    it("keeps hasTolls false when duration is within 2% of NO_TOLLS and the stop order matches", () => {
      const noTolls = variant({ key: "NO_TOLLS", stopIds: ["a", "b"], durationSec: 100 });
      const fastest = variant({ key: "FASTEST", stopIds: ["a", "b"], durationSec: 101 }); // 1% off
      const results = [fastest, noTolls];
      (service as any).applyTollContrast(results);
      expect(fastest.hasTolls).toBe(false);
      expect(noTolls.hasTolls).toBe(false);
    });
  });

  // ─── getRouteVariants — never throws on Google failure ─────────────────

  describe("getRouteVariants", () => {
    function mockRoute() {
      return {
        id: "route-1",
        depotLat: 40.0,
        depotLng: -74.0,
        depotAddress: "Depot",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        stops: [
          {
            id: "stop-1",
            stopNumber: 1,
            customerId: "cust-1",
            customer: {
              id: "cust-1",
              businessName: "A",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-1", lat: 40.01, lng: -73.99 },
          },
          {
            id: "stop-2",
            stopNumber: 2,
            customerId: "cust-2",
            customer: {
              id: "cust-2",
              businessName: "B",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-2", lat: 40.02, lng: -73.98 },
          },
        ],
      };
    }

    it("falls back to a single solver-only variant (encodedPolyline null) when Google is entirely unavailable, never throwing", async () => {
      prisma.forTenant().route.findUnique.mockResolvedValue(mockRoute());
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));

      const result = await service.getRouteVariants("route-1");

      expect(result.variants).toHaveLength(1);
      expect(result.variants[0].encodedPolyline).toBeNull();
      expect(result.variants[0].stopIds.sort()).toEqual(["stop-1", "stop-2"]);
    });

    it("requests exactly polyline+distanceMeters+duration from computeRoutes — no tollInfo/extraComputations", async () => {
      const route = mockRoute();
      // Distinct coordinates from the other tests in this file so the
      // module-level matrix cache in cost-matrix.ts can't serve a stale hit.
      route.depotLat = 41.0;
      route.depotLng = -75.0;
      route.stops = [
        {
          id: "stop-1",
          stopNumber: 1,
          customerId: "cust-1",
          customer: {
            id: "cust-1",
            businessName: "A",
            deliveryWindowStart: null,
            deliveryWindowEnd: null,
          },
          customerAddress: { id: "addr-1", lat: 41.01, lng: -74.99 },
        },
        {
          id: "stop-2",
          stopNumber: 2,
          customerId: "cust-2",
          customer: {
            id: "cust-2",
            businessName: "B",
            deliveryWindowStart: null,
            deliveryWindowEnd: null,
          },
          customerAddress: { id: "addr-2", lat: 41.02, lng: -74.98 },
        },
      ];
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );

      const matrixElements = [
        {
          originIndex: 0,
          destinationIndex: 1,
          duration: "60s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 0,
          destinationIndex: 2,
          duration: "70s",
          distanceMeters: 600,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 1,
          destinationIndex: 0,
          duration: "60s",
          distanceMeters: 500,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 1,
          destinationIndex: 2,
          duration: "50s",
          distanceMeters: 400,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 2,
          destinationIndex: 0,
          duration: "70s",
          distanceMeters: 600,
          condition: "ROUTE_EXISTS",
        },
        {
          originIndex: 2,
          destinationIndex: 1,
          duration: "50s",
          distanceMeters: 400,
          condition: "ROUTE_EXISTS",
        },
      ];

      let computeRoutesCallCount = 0;
      (global as any).fetch = jest.fn(async (url: string) => {
        if (url.includes("computeRouteMatrix")) {
          return { ok: true, status: 200, json: async () => matrixElements };
        }
        if (url.includes("computeRoutes")) {
          // Distinct totals per call so dedupeVariants doesn't legitimately
          // collapse these — this test only cares about what was requested.
          computeRoutesCallCount += 1;
          const duration = 100 + computeRoutesCallCount * 20;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              routes: [
                {
                  polyline: { encodedPolyline: `enc-${computeRoutesCallCount}` },
                  distanceMeters: 900 + computeRoutesCallCount * 100,
                  duration: `${duration}s`,
                },
              ],
            }),
          };
        }
        throw new Error(`unexpected fetch url: ${String(url)}`);
      });

      const result = await service.getRouteVariants("route-1");
      expect(result.variants.length).toBe(3); // FASTEST, SHORTEST, NO_TOLLS

      const fetchMock = global.fetch as jest.Mock;
      const computeRoutesCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("computeRoutes"),
      );
      expect(computeRoutesCalls.length).toBe(3);
      for (const [, init] of computeRoutesCalls) {
        expect(init.headers["X-Goog-FieldMask"]).toBe(
          "routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration",
        );
        const body = JSON.parse(init.body as string);
        expect(body.extraComputations).toBeUndefined();
      }
    });

    it("skips the computeRoutes call past 10 intermediates (Pro-tier guard), using solver totals", async () => {
      // 12 stops + no end point = 11 intermediates, one over the Essentials
      // ceiling. The polyline call is worth $10/1000 there — and this loop
      // makes one per variant — so it's skipped and the client draws its own.
      const route = mockRoute();
      route.depotLat = 42.0;
      route.depotLng = -76.0;
      route.stops = Array.from({ length: 12 }, (_, i) => ({
        id: `stop-${i}`,
        stopNumber: i + 1,
        customerId: `cust-${i}`,
        customer: {
          id: `cust-${i}`,
          businessName: `C${i}`,
          deliveryWindowStart: null,
          deliveryWindowEnd: null,
        },
        customerAddress: { id: `addr-${i}`, lat: 42.01 + i * 0.01, lng: -75.99 - i * 0.01 },
      }));
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );

      const n = 13; // depot + 12 stops
      const matrixElements: unknown[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          matrixElements.push({
            originIndex: i,
            destinationIndex: j,
            duration: `${100 + Math.abs(i - j)}s`,
            distanceMeters: 500 * Math.abs(i - j),
            condition: "ROUTE_EXISTS",
          });
        }
      }
      (global as any).fetch = jest.fn(async (url: string) => {
        if (url.includes("computeRouteMatrix")) {
          return { ok: true, status: 200, json: async () => matrixElements };
        }
        throw new Error("computeRoutes must not be called above the intermediate cap");
      });

      const result = await service.getRouteVariants("route-1");

      const computeRoutesCalls = (global.fetch as jest.Mock).mock.calls.filter(([url]) =>
        String(url).includes("computeRoutes"),
      );
      expect(computeRoutesCalls).toHaveLength(0);
      expect(result.variants.length).toBeGreaterThan(0);
      for (const v of result.variants) {
        expect(v.encodedPolyline).toBeNull();
        // Totals still come back — from the solver's own matrix walk.
        expect(v.durationSec).toBeGreaterThan(0);
        expect(v.distanceMeters).toBeGreaterThan(0);
      }
    });

    it("returns no variants when the route has no stops", async () => {
      const route = mockRoute();
      route.stops = [];
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );

      const result = await service.getRouteVariants("route-1");
      expect(result.variants).toEqual([]);
    });

    it("returns no variants when no depot can be resolved", async () => {
      const route = mockRoute();
      route.depotLat = null as any;
      route.depotLng = null as any;
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      // resolveDepot falls through to systemConfig defaults, which are null in
      // this test setup, and then the tenant depot lookup (also unresolvable
      // here since tenantConfig defaults to null via the mock) — ends null.
      prisma.forTenant().tenantConfig.findFirst.mockResolvedValue(null);

      const result = await service.getRouteVariants("route-1");
      expect(result.variants).toEqual([]);
    });
  });

  // ─── applyRouteVariant ──────────────────────────────────────────────────

  describe("applyRouteVariant", () => {
    beforeEach(() => {
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        stops: [{ id: "stop-1" }, { id: "stop-2" }],
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
    });

    it("rejects a stopIds list that isn't a permutation of the route's current stops", async () => {
      await expect(
        service.applyRouteVariant("route-1", {
          stopIds: ["stop-1", "stop-3"],
          optimizeBy: "TIME",
          avoidTolls: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("persists the reordered stops, settings, and polyline for a valid permutation", async () => {
      const result = await service.applyRouteVariant("route-1", {
        stopIds: ["stop-2", "stop-1"],
        optimizeBy: "DISTANCE",
        avoidTolls: true,
        encodedPolyline: "abc123",
      });

      expect(result).toEqual({ applied: true });
      expect(prisma.$transaction).toHaveBeenCalled();
      // plannedPolyline is written here and ONLY here.
      expect(prisma.forTenant().route.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "route-1" },
          data: expect.objectContaining({
            optimizeBy: "DISTANCE",
            avoidTolls: true,
            plannedPolyline: "abc123",
          }),
        }),
      );
    });

    it("409s on the template-only path when any run of the route is IN_PROGRESS", async () => {
      prisma.forTenant().routeRun.findFirst.mockResolvedValue({ id: "run-live" });

      await expect(
        service.applyRouteVariant("route-1", {
          stopIds: ["stop-2", "stop-1"],
          optimizeBy: "TIME",
          avoidTolls: false,
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // ── runId: re-number the run's stops in the SAME transaction ───────────
    // Variants are solved against the route TEMPLATE, but the operator is
    // usually looking at a RUN. Doing both in one transaction is what keeps
    // the stored polyline and the visible order from ever disagreeing.

    it("re-numbers the named SCHEDULED run's stops to the variant order, keeping the polyline", async () => {
      prisma.forTenant().routeRun.findFirst.mockResolvedValue({
        id: "run-1",
        routeId: "route-1",
        status: RouteRunStatus.SCHEDULED,
        stops: [
          { id: "runstop-a", routeStopId: "stop-1", stopNumber: 1 },
          { id: "runstop-b", routeStopId: "stop-2", stopNumber: 2 },
        ],
      });

      await service.applyRouteVariant("route-1", {
        stopIds: ["stop-2", "stop-1"],
        optimizeBy: "TIME",
        avoidTolls: false,
        encodedPolyline: "keep-me",
        runId: "run-1",
      });

      const runStopUpdates = prisma.forTenant().routeRunStop.update.mock.calls.map(([a]: any) => a);
      // Two-phase: offset pass first, then the real 1..n numbering.
      const finalPass = runStopUpdates.slice(runStopUpdates.length / 2);
      expect(finalPass).toEqual([
        { where: { id: "runstop-b" }, data: { stopNumber: 1 } },
        { where: { id: "runstop-a" }, data: { stopNumber: 2 } },
      ]);
      // The route update in the same transaction still carries the polyline —
      // nothing nulls what apply just wrote.
      expect(prisma.forTenant().route.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ plannedPolyline: "keep-me" }) }),
      );
      expect(prisma.forTenant().routeRun.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: { manuallyReordered: false },
      });
    });

    it("404s when the named run doesn't belong to this route", async () => {
      prisma.forTenant().routeRun.findFirst.mockResolvedValue(null);

      await expect(
        service.applyRouteVariant("route-1", {
          stopIds: ["stop-2", "stop-1"],
          optimizeBy: "TIME",
          avoidTolls: false,
          runId: "run-of-another-route",
        }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("409s when the named run is not SCHEDULED", async () => {
      prisma.forTenant().routeRun.findFirst.mockResolvedValue({
        id: "run-1",
        routeId: "route-1",
        status: RouteRunStatus.IN_PROGRESS,
        stops: [],
      });

      await expect(
        service.applyRouteVariant("route-1", {
          stopIds: ["stop-2", "stop-1"],
          optimizeBy: "TIME",
          avoidTolls: false,
          runId: "run-1",
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("keeps run stops whose template stop isn't in the variant, so the rewrite stays a full permutation", async () => {
      prisma.forTenant().routeRun.findFirst.mockResolvedValue({
        id: "run-1",
        routeId: "route-1",
        status: RouteRunStatus.SCHEDULED,
        stops: [
          { id: "runstop-a", routeStopId: "stop-1", stopNumber: 1 },
          { id: "runstop-b", routeStopId: "stop-2", stopNumber: 2 },
          // Orphan: its template stop was removed after dispatch.
          { id: "runstop-orphan", routeStopId: "stop-gone", stopNumber: 3 },
        ],
      });

      await service.applyRouteVariant("route-1", {
        stopIds: ["stop-2", "stop-1"],
        optimizeBy: "TIME",
        avoidTolls: false,
        runId: "run-1",
      });

      const runStopUpdates = prisma.forTenant().routeRunStop.update.mock.calls.map(([a]: any) => a);
      const finalPass = runStopUpdates.slice(runStopUpdates.length / 2);
      expect(finalPass).toEqual([
        { where: { id: "runstop-b" }, data: { stopNumber: 1 } },
        { where: { id: "runstop-a" }, data: { stopNumber: 2 } },
        { where: { id: "runstop-orphan" }, data: { stopNumber: 3 } },
      ]);
    });
  });
});
