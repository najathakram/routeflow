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
  let systemConfigGet: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    configGet = jest.fn().mockReturnValue(undefined);
    systemConfigGet = jest.fn().mockResolvedValue(null);

    const mod = await Test.createTestingModule({
      providers: [
        RouteOptimizationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: SystemConfigService,
          useValue: { get: systemConfigGet, set: jest.fn() },
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

    /** Depot (0,0), stops due north; only the far one carries a window
     *  (08:00-09:00), which the pure-cost order [near, mid, far] misses at
     *  09:10 — the same geometry REG-B147 pins on optimizeTemplate. */
    function windowedRoute() {
      return {
        id: "route-1",
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        tenantId: "tenant-1",
        stops: [
          {
            id: "stop-near",
            stopNumber: 1,
            customerId: "cust-near",
            customer: {
              id: "cust-near",
              businessName: "Near",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-near", lat: 0.1, lng: 0 },
          },
          {
            id: "stop-mid",
            stopNumber: 2,
            customerId: "cust-mid",
            customer: {
              id: "cust-mid",
              businessName: "Mid",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-mid", lat: 0.2, lng: 0 },
          },
          {
            id: "stop-far",
            stopNumber: 3,
            customerId: "cust-far",
            customer: {
              id: "cust-far",
              businessName: "Far",
              deliveryWindowStart: "08:00",
              deliveryWindowEnd: "09:00",
            },
            customerAddress: { id: "addr-far", lat: 0.3, lng: 0 },
          },
        ],
      };
    }

    // REG-B147: a variant is one applyRouteVariant click from being persisted
    // as the route's stop order, so it runs the same window pass optimize does.
    it("REG-B147: the solver-only fallback variant is window-feasible and reports its violations", async () => {
      prisma.forTenant().route.findUnique.mockResolvedValue(windowedRoute());
      configGet.mockReturnValue(undefined); // no Google key → solver-only fallback
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );

      const result = await service.getRouteVariants("route-1");

      expect(result.variants.length).toBeGreaterThan(0);
      for (const variant of result.variants) {
        expect(variant.stopIds[0]).toBe("stop-far");
        expect(variant.windowViolations).toEqual([]);
      }
    });

    it("REG-B147: every variant from the per-config Google loop is window-feasible", async () => {
      prisma.forTenant().route.findUnique.mockResolvedValue(windowedRoute());
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      // computeRouteMatrix fails (haversine matrix), computeRoutes answers — so
      // the per-config loop runs rather than the catch-block fallback.
      (global as any).fetch = jest.fn().mockImplementation((url: string) =>
        String(url).includes("computeRouteMatrix")
          ? Promise.reject(new Error("matrix down"))
          : Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({
                routes: [
                  { polyline: { encodedPolyline: "abc" }, distanceMeters: 1000, duration: "600s" },
                ],
              }),
            }),
      );

      const result = await service.getRouteVariants("route-1");

      expect(result.variants.length).toBeGreaterThan(0);
      for (const variant of result.variants) {
        expect(variant.stopIds[0]).toBe("stop-far");
        expect(variant.windowViolations).toEqual([]);
      }
    });

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

    // ─── variant totals must describe the variant's own order ─────────────
    //
    // Index-linear matrices over [depot, ...stops]: `100+|i-j|` seconds and
    // `500*|i-j|` metres. The solver's cost order is then the identity, and
    // ANY reordering changes both totals — which is what makes a
    // window-repaired order's totals distinguishable from the cost-only
    // order's, the exact pair the pre-fix code could publish side by side.
    const legDurationSec = (i: number, j: number) => 100 + Math.abs(i - j);
    const legDistanceMeters = (i: number, j: number) => 500 * Math.abs(i - j);

    function linearMatrixElements(pointCount: number) {
      const elements: unknown[] = [];
      for (let i = 0; i < pointCount; i++) {
        for (let j = 0; j < pointCount; j++) {
          if (i === j) continue;
          elements.push({
            originIndex: i,
            destinationIndex: j,
            duration: `${legDurationSec(i, j)}s`,
            distanceMeters: legDistanceMeters(i, j),
            condition: "ROUTE_EXISTS",
          });
        }
      }
      return elements;
    }

    /** Sum a leg cost along [depot, ...stopIds] using the SAME matrix the
     *  service walked — stop `stop-N` is matrix index N+1. */
    function sumAlong(stopIds: string[], leg: (i: number, j: number) => number) {
      const path = [0, ...stopIds.map((id) => Number(id.split("-")[1]) + 1)];
      let total = 0;
      for (let k = 0; k < path.length - 1; k++) total += leg(path[k], path[k + 1]);
      return total;
    }

    /** `count` stops due north of a (0,0) depot at `latStep` intervals, so the
     *  cost order is [stop-0 … stop-(count-1)]. Only the farthest is windowed,
     *  and it closes long before that order reaches it — the repair pulls it
     *  to the FRONT, a strictly longer path. */
    function windowedLineStops(count: number, latStep: number) {
      return Array.from({ length: count }, (_, i) => ({
        id: `stop-${i}`,
        stopNumber: i + 1,
        customerId: `cust-${i}`,
        customer: {
          id: `cust-${i}`,
          businessName: `C${i}`,
          deliveryWindowStart: i === count - 1 ? "08:00" : null,
          deliveryWindowEnd: i === count - 1 ? "09:00" : null,
        },
        customerAddress: { id: `addr-${i}`, lat: latStep * (i + 1), lng: 0 },
      }));
    }

    it("re-sums the solver totals along the window-repaired order past 10 intermediates", async () => {
      // 12 stops, no end point = 11 intermediates: no computeRoutes call, so
      // the solver's matrix walk supplies the totals — and the window pass has
      // moved a stop since that walk.
      const route = mockRoute();
      route.depotLat = 0;
      route.depotLng = 0;
      route.stops = windowedLineStops(12, 0.02);
      const costOnlyOrder = route.stops.map((s) => s.id);
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      const matrixElements = linearMatrixElements(13); // depot + 12 stops
      (global as any).fetch = jest.fn(async (url: string) => {
        if (url.includes("computeRouteMatrix")) {
          return { ok: true, status: 200, json: async () => matrixElements };
        }
        throw new Error("computeRoutes must not be called above the intermediate cap");
      });

      const result = await service.getRouteVariants("route-1");

      // All three configs repair to the same order and the same totals, so
      // dedupe collapses them — it cannot be fooled by pre-repair numbers.
      expect(result.variants).toHaveLength(1);
      const variant = result.variants[0];
      expect(variant.encodedPolyline).toBeNull();
      expect(variant.hasTolls).toBe(false);
      expect(variant.stopIds[0]).toBe("stop-11"); // the repair moved it
      expect(variant.stopIds).not.toEqual(costOnlyOrder);
      // The totals describe the order the variant actually publishes …
      expect(variant.durationSec).toBe(sumAlong(variant.stopIds, legDurationSec));
      expect(variant.distanceMeters).toBe(sumAlong(variant.stopIds, legDistanceMeters));
      // … not the cost-only order the solver returned before the repair.
      expect(variant.durationSec).not.toBe(sumAlong(costOnlyOrder, legDurationSec));
      expect(variant.distanceMeters).not.toBe(sumAlong(costOnlyOrder, legDistanceMeters));
    });

    it("re-sums the Google-failure fallback variant's totals along its repaired order", async () => {
      // 4 stops = 3 intermediates, so the polyline call IS attempted — and
      // fails, dropping into the solver-only fallback, which publishes totals
      // of its own next to a repaired order.
      const route = mockRoute();
      route.depotLat = 0;
      route.depotLng = 0;
      route.stops = windowedLineStops(4, 0.1);
      const costOnlyOrder = route.stops.map((s) => s.id);
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      const matrixElements = linearMatrixElements(5); // depot + 4 stops
      (global as any).fetch = jest.fn(async (url: string) => {
        if (url.includes("computeRouteMatrix")) {
          return { ok: true, status: 200, json: async () => matrixElements };
        }
        throw new Error("computeRoutes down");
      });

      const result = await service.getRouteVariants("route-1");

      expect(result.variants).toHaveLength(1);
      const variant = result.variants[0];
      expect(variant.encodedPolyline).toBeNull();
      expect(variant.stopIds[0]).toBe("stop-3");
      expect(variant.durationSec).toBe(sumAlong(variant.stopIds, legDurationSec));
      expect(variant.distanceMeters).toBe(sumAlong(variant.stopIds, legDistanceMeters));
      expect(variant.durationSec).not.toBe(sumAlong(costOnlyOrder, legDurationSec));
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

  // ─── optimizeTemplate — delivery windows (F12: B147/B161/B177) ─────────
  //
  // Coordinates below are colinear along latitude at 0.1/0.2/0.3 degrees from
  // a depot at (0,0), so the pure-cost nearest-neighbour + 2-opt order is
  // always [near, mid, far] (monotonically increasing distance) — verified
  // against the haversine matrix (cost-matrix.ts's synthetic 11.1 m/s) via
  // the exact same formula this suite's other haversine-fallback tests rely
  // on. ETAs below use the same default avgSpeedKmh=50 / serviceTimeMinutes=15
  // that route-analysis.service.ts falls back to when SystemConfig has
  // nothing configured — `systemConfigGet` here resolves null for both, so
  // the analysis/optimize passes share those same defaults (B177's
  // invariant: one clock for the solver and the ETA pass).

  describe("optimizeTemplate — delivery windows (F12)", () => {
    function windowedTemplateRoute() {
      return {
        id: "route-1",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
        stops: [
          {
            id: "stop-near",
            stopNumber: 1,
            customerId: "cust-near",
            customer: {
              id: "cust-near",
              businessName: "Near",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-near", lat: 0.1, lng: 0 },
          },
          {
            id: "stop-mid",
            stopNumber: 2,
            customerId: "cust-mid",
            customer: {
              id: "cust-mid",
              businessName: "Mid",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-mid", lat: 0.2, lng: 0 },
          },
          {
            id: "stop-far",
            stopNumber: 3,
            customerId: "cust-far",
            // Only this stop carries a window. Under the pure-cost order
            // [near, mid, far] a vehicle leaving the depot at 08:00 (50 km/h,
            // 15 min service) reaches "far" third at 09:10 — past the 09:00
            // close. Reached FIRST instead, it arrives 08:40 — within window.
            customer: {
              id: "cust-far",
              businessName: "Far",
              deliveryWindowStart: "08:00",
              deliveryWindowEnd: "09:00",
            },
            customerAddress: { id: "addr-far", lat: 0.3, lng: 0 },
          },
        ],
      };
    }

    it("REG-B147: persists a window-feasible order on the cost-matrix branch", async () => {
      const route = windowedTemplateRoute();
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      // Google's computeRouteMatrix rejects — buildCostMatrices falls back to
      // the deterministic haversine matrix (cost-matrix.ts:30-33), never the
      // module-level cache (real-Google-only).
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));

      const result: any = await service.optimizeTemplate("route-1");

      expect(result.stopOrder[0].stopId).toBe("stop-far");
      expect(result.windowViolations).toEqual([]);

      // Persisted order = the LAST stopNumber written per stop id, so a
      // single-pass persist (or any other transaction shape) is judged on the
      // behaviour, not on today's two-phase equal-count update.
      const lastWritten = new Map<string, number>();
      for (const [arg] of prisma.forTenant().routeStop.update.mock.calls as any[]) {
        lastWritten.set(arg.where.id, arg.data.stopNumber);
      }
      const persistedIds = [...lastWritten.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([stopId]) => stopId);
      expect(persistedIds).toEqual(result.stopOrder.map((s: any) => s.stopId));

      // The ruling's invariant is window FEASIBILITY, not one permutation
      // ([near, far, mid] is feasible too, and cheaper) — so re-run the real
      // ETA pass over the PERSISTED order and require that nothing windowed
      // arrives late. Under the pure-cost order [near, mid, far] "far" arrives
      // 09:10, past its 09:00 close, which is what this pins red.
      const coordsById = new Map(
        route.stops.map((s: any) => [
          s.id,
          {
            id: s.id,
            stopNumber: s.stopNumber,
            customerName: s.customer.businessName,
            lat: s.customerAddress.lat,
            lng: s.customerAddress.lng,
            deliveryWindowStart: s.customer.deliveryWindowStart,
            deliveryWindowEnd: s.customer.deliveryWindowEnd,
          },
        ]),
      );
      const etas = service.calculateETAs(
        { lat: 0, lng: 0 },
        persistedIds.map((id) => coordsById.get(id)!),
        "08:00",
        50,
        15,
      );
      expect(etas.filter((e) => e.withinWindow === false).map((e) => e.stopId)).toEqual([]);
    });

    it("REG-B161: reports a stop whose window closes before its reachable ETA under any order", async () => {
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
        stops: [
          {
            id: "stop-late",
            stopNumber: 1,
            customerId: "cust-late",
            // ~33.36 km from the depot — the ONLY possible order (a single
            // stop) still arrives at 08:40 (50 km/h from 08:00), past the
            // 08:30 window close. No re-insertion can fix a one-stop route.
            customer: {
              id: "cust-late",
              businessName: "Late",
              deliveryWindowStart: "08:00",
              deliveryWindowEnd: "08:30",
            },
            customerAddress: { id: "addr-late", lat: 0.3, lng: 0 },
          },
        ],
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));

      const result: any = await service.optimizeTemplate("route-1");

      // Value oracle, never an existence check: the report must name THIS
      // stop (a fixture id no other test's order contains), its OWN window
      // close, and a real "HH:mm" ETA that is genuinely later than that close.
      const minutesFromMidnight = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };
      expect(result.windowViolations).toHaveLength(1);
      const violation = result.windowViolations[0];
      expect(violation.stopId).toBe("stop-late");
      expect(violation.windowStart).toBe("08:00");
      expect(violation.windowEnd).toBe("08:30");
      expect(typeof violation.eta).toBe("string");
      expect(violation.eta).toMatch(/^\d{2}:\d{2}$/);
      expect(violation.eta).toBe("08:40");
      expect(minutesFromMidnight(violation.eta)).toBeGreaterThan(
        minutesFromMidnight(violation.windowEnd),
      );
      expect(result.startTime).toBe("08:00");
    });

    /** Depot (0,0) with three stops due north. Cost order is always
     *  [near, mid, far] (11.12 km hops); the windows are the only thing that
     *  can move a stop. Callers set the two windowed stops' hours. */
    function twoWindowedRoute(nearWindow: [string, string], farWindow: [string, string]) {
      const route: any = windowedTemplateRoute();
      route.stops[0].id = "stop-a";
      route.stops[0].customer.deliveryWindowStart = nearWindow[0];
      route.stops[0].customer.deliveryWindowEnd = nearWindow[1];
      route.stops[1].id = "stop-b";
      route.stops[2].id = "stop-c";
      route.stops[2].customer.deliveryWindowStart = farWindow[0];
      route.stops[2].customer.deliveryWindowEnd = farWindow[1];
      return route;
    }

    function costMatrixBranch() {
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      // computeRouteMatrix rejects — the deterministic haversine matrix answers.
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    }

    it("REG-B147: when no order meets every window, never moves the violation onto an on-time stop", async () => {
      // c can only make its 08:45 close by going first — which makes a late.
      // One violation either way, so the solver's own order stands and the
      // report still names c, never the stop that was fine to begin with.
      const route = twoWindowedRoute(["08:00", "08:20"], ["08:00", "08:45"]);
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      costMatrixBranch();

      const result: any = await service.optimizeTemplate("route-1");

      expect(result.windowViolations.map((v: any) => v.stopId)).toEqual(["stop-c"]);
      expect(result.stopOrder).toEqual([
        { stopId: "stop-a", stopNumber: 1 },
        { stopId: "stop-b", stopNumber: 2 },
        { stopId: "stop-c", stopNumber: 3 },
      ]);
    });

    it("REG-B147: an EARLY arrival waits for the window to open — it is not a violation", async () => {
      // Reachable at 08:13 against a 14:00-15:00 window: the driver waits, is
      // served at 14:00, and every later ETA follows from that departure.
      const etas = service.calculateETAs(
        { lat: 0, lng: 0 },
        [
          {
            id: "stop-early",
            stopNumber: 1,
            customerName: "Early",
            lat: 0.1,
            lng: 0,
            deliveryWindowStart: "14:00",
            deliveryWindowEnd: "15:00",
          },
          { id: "stop-next", stopNumber: 2, customerName: "Next", lat: 0.2, lng: 0 },
        ],
        "08:00",
        50,
        15,
      );

      expect(etas[0].arrivalTime).toBe("08:13");
      expect(etas[0].withinWindow).toBe(true);
      expect(etas[0].waitMinutes).toBeGreaterThan(0);
      expect(etas[0].departureTime).toBe("14:15");
      expect(etas[1].arrivalTime).toBe("14:28");

      const route: any = windowedTemplateRoute();
      route.stops[2].customer.deliveryWindowStart = "14:00";
      route.stops[2].customer.deliveryWindowEnd = "15:00";
      prisma.forTenant().route.findUnique.mockResolvedValue(route);
      costMatrixBranch();

      const result: any = await service.optimizeTemplate("route-1");
      expect(result.windowViolations).toEqual([]);
    });

    it("REG-B177: the ORS request carries the vehicle's departure clock as its time_window", async () => {
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
        stops: [
          {
            id: "stop-a",
            stopNumber: 1,
            customerId: "cust-a",
            customer: {
              id: "cust-a",
              businessName: "A",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-a", lat: 0.1, lng: 0 },
          },
          {
            id: "stop-b",
            stopNumber: 2,
            customerId: "cust-b",
            customer: {
              id: "cust-b",
              businessName: "B",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-b", lat: 0.2, lng: 0 },
          },
        ],
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      // No Google key — falls through to the ORS branch. ORS jobs carry
      // absolute seconds-from-midnight windows but (today) no vehicle clock,
      // so a job's window is meaningless without knowing when the vehicle
      // actually departs (B177).
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? undefined : key === "ors.apiKey" ? "ors-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              steps: [
                { type: "job", job: 1 },
                { type: "job", job: 2 },
              ],
            },
          ],
        }),
      });

      await service.optimizeTemplate("route-1");

      const fetchMock = global.fetch as jest.Mock;
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      // 08:00 = 28800s from midnight; WORKDAY_SEC (12h workday) = 43200s.
      expect(body.vehicles[0].time_window).toEqual([28800, 72000]);
    });

    it("REG-B177: an ORS response with unassigned jobs keeps the primary solver", async () => {
      // The vehicle clock (above) makes a stop whose window has already
      // closed unschedulable, so vroom returns it in `unassigned` instead of
      // failing: two of three stops come back as steps. That is "this stop is
      // late", not "ORS is broken" — the stop must still be persisted (last),
      // named in windowViolations, with NO fallback claimed.
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
        stops: [
          {
            id: "stop-ors-a",
            stopNumber: 1,
            customerId: "cust-ors-a",
            customer: {
              id: "cust-ors-a",
              businessName: "A",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-ors-a", lat: 0.1, lng: 0 },
          },
          {
            id: "stop-ors-b",
            stopNumber: 2,
            customerId: "cust-ors-b",
            customer: {
              id: "cust-ors-b",
              businessName: "B",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-ors-b", lat: 0.2, lng: 0 },
          },
          {
            id: "stop-late",
            stopNumber: 3,
            customerId: "cust-ors-late",
            // 33.36 km out: unreachable before its 08:30 close from an 08:00
            // departure in ANY order, which is exactly why vroom drops it.
            customer: {
              id: "cust-ors-late",
              businessName: "Late",
              deliveryWindowStart: "08:00",
              deliveryWindowEnd: "08:30",
            },
            customerAddress: { id: "addr-ors-late", lat: 0.3, lng: 0 },
          },
        ],
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? undefined : key === "ors.apiKey" ? "ors-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              steps: [
                { type: "job", job: 1 },
                { type: "job", job: 2 },
              ],
            },
          ],
          // Job 3 = the third stop we sent.
          unassigned: [{ id: 3 }],
        }),
      });

      const result: any = await service.optimizeTemplate("route-1");

      expect(result.stopOrder.map((s: any) => s.stopId)).toEqual([
        "stop-ors-a",
        "stop-ors-b",
        "stop-late",
      ]);
      expect(result.windowViolations).toHaveLength(1);
      expect(result.windowViolations[0].stopId).toBe("stop-late");
      expect(result.windowViolations[0].windowEnd).toBe("08:30");
      // ORS answered — the local solver never ran and no reason is claimed.
      expect(result.usedFallback).toBe(false);
      expect(result.fallbackReason).toBeUndefined();
      expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(1);
    });

    it("REG-B177: an ORS response that neither schedules nor reports a stop still throws", async () => {
      configGet.mockImplementation((key: string) => (key === "ors.apiKey" ? "ors-key" : undefined));
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [{ steps: [{ type: "job", job: 1 }] }],
          unassigned: [],
        }),
      });

      // A TRUE mismatch (steps + unassigned < stops) is still an error, and
      // still names the counts — appending the unassigned must not soften it.
      await expect(
        (service as any).callOrsOptimization(
          [
            { id: "stop-1", stopNumber: 1, customerName: "One", lat: 0.1, lng: 0 },
            { id: "stop-2", stopNumber: 2, customerName: "Two", lat: 0.2, lng: 0 },
            { id: "stop-3", stopNumber: 3, customerName: "Three", lat: 0.3, lng: 0 },
          ],
          { lat: 0, lng: 0 },
          "08:00",
        ),
      ).rejects.toThrow("ORS stop count mismatch: expected 3, got 1");
    });

    it("REG-B177: only `job` entries of an ORS unassigned array index into the stop list", async () => {
      configGet.mockImplementation((key: string) => (key === "ors.apiKey" ? "ors-key" : undefined));
      const stops = [
        { id: "stop-1", stopNumber: 1, customerName: "One", lat: 0.1, lng: 0 },
        { id: "stop-2", stopNumber: 2, customerName: "Two", lat: 0.2, lng: 0 },
        { id: "stop-3", stopNumber: 3, customerName: "Three", lat: 0.3, lng: 0 },
      ];

      // Vroom numbers `shipment` and `break` entries in their OWN id spaces,
      // so a break's id says nothing about job N: only the job entry may be
      // mapped onto a stop, and it is appended exactly once.
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              steps: [
                { type: "job", job: 1 },
                { type: "job", job: 2 },
              ],
            },
          ],
          unassigned: [
            { id: 1, type: "break" },
            { id: 3, type: "job" },
          ],
        }),
      });

      await expect(
        (service as any).callOrsOptimization(stops, { lat: 0, lng: 0 }, "08:00"),
      ).resolves.toEqual(["stop-1", "stop-2", "stop-3"]);

      // The same id carried by a NON-job entry is no report about job 3: the
      // stop stays unaccounted for and the true-mismatch throw fires, rather
      // than a break silently standing in for the missing job.
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              steps: [
                { type: "job", job: 1 },
                { type: "job", job: 2 },
              ],
            },
          ],
          unassigned: [{ id: 3, type: "break" }],
        }),
      });

      await expect(
        (service as any).callOrsOptimization(stops, { lat: 0, lng: 0 }, "08:00"),
      ).rejects.toThrow("ORS stop count mismatch: expected 3, got 2");
    });

    // T7 (F12, REG-B147): the multi-stop half of the repair — the only branch
    // where the re-insertion loop actually runs more than once and where a
    // repair can push a DIFFERENT stop out of its window. Under pure cost
    // [A, B, C] only C is late (09:10 vs a 09:00 close); pulling C to the
    // front fixes C but strands A (09:21 vs an 08:20 close). The one feasible
    // order is [A, C, B] (A 08:13, C 08:55), so an empty `windowViolations`
    // is the distinguishing oracle: a repair that only checks the stop it
    // just moved reports A instead.
    it("REG-B147: repairing a late windowed stop never pushes another windowed stop out of its window", async () => {
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        avoidTolls: false,
        optimizeBy: RouteOptimizeMetric.TIME,
        endKind: RouteEndKind.NONE,
        endLat: null,
        endLng: null,
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
        stops: [
          {
            id: "stop-a",
            stopNumber: 1,
            customerId: "cust-a",
            customer: {
              id: "cust-a",
              businessName: "A",
              deliveryWindowStart: "08:00",
              deliveryWindowEnd: "08:20",
            },
            customerAddress: { id: "addr-a", lat: 0.1, lng: 0 },
          },
          {
            id: "stop-b",
            stopNumber: 2,
            customerId: "cust-b",
            customer: {
              id: "cust-b",
              businessName: "B",
              deliveryWindowStart: null,
              deliveryWindowEnd: null,
            },
            customerAddress: { id: "addr-b", lat: 0.2, lng: 0 },
          },
          {
            id: "stop-c",
            stopNumber: 3,
            customerId: "cust-c",
            customer: {
              id: "cust-c",
              businessName: "C",
              deliveryWindowStart: "08:00",
              deliveryWindowEnd: "09:00",
            },
            customerAddress: { id: "addr-c", lat: 0.3, lng: 0 },
          },
        ],
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));

      const result: any = await service.optimizeTemplate("route-1");

      // A was inside its window before the pass; it must still be inside it after.
      expect(result.windowViolations).toEqual([]);
      expect(result.stopOrder.map((s: any) => s.stopId)).toEqual(["stop-a", "stop-c", "stop-b"]);
    });
  });

  // ─── optimizeRoute — mid-run clock ──────────────────────────────────────

  describe("optimizeRoute — delivery windows (F12)", () => {
    /** A run of three stops due north of a (0,0) depot; only the far one is
     *  windowed (08:00-09:00). Against the SCHEDULED 08:00 departure the cost
     *  order [near, mid, far] misses that window at 09:10 — but a driver who
     *  is hours into the run is nowhere near 08:00, so that verdict is only
     *  honest when the caller says what time it actually is. */
    function windowedRun(status: RouteRunStatus) {
      return {
        id: "run-1",
        routeId: "route-1",
        startTime: "08:00",
        status,
        route: {
          id: "route-1",
          avoidTolls: false,
          optimizeBy: RouteOptimizeMetric.TIME,
          endKind: RouteEndKind.NONE,
          endLat: null,
          endLng: null,
        },
        stops: [
          {
            id: "run-stop-near",
            stopNumber: 1,
            customerId: "cust-near",
            customerAddress: { id: "addr-near", lat: 0.1, lng: 0 },
            routeStop: {
              customerAddress: { id: "addr-near", lat: 0.1, lng: 0 },
              customer: {
                id: "cust-near",
                businessName: "Near",
                deliveryWindowStart: null,
                deliveryWindowEnd: null,
              },
            },
          },
          {
            id: "run-stop-mid",
            stopNumber: 2,
            customerId: "cust-mid",
            customerAddress: { id: "addr-mid", lat: 0.2, lng: 0 },
            routeStop: {
              customerAddress: { id: "addr-mid", lat: 0.2, lng: 0 },
              customer: {
                id: "cust-mid",
                businessName: "Mid",
                deliveryWindowStart: null,
                deliveryWindowEnd: null,
              },
            },
          },
          {
            id: "run-stop-far",
            stopNumber: 3,
            customerId: "cust-far",
            customerAddress: { id: "addr-far", lat: 0.3, lng: 0 },
            routeStop: {
              customerAddress: { id: "addr-far", lat: 0.3, lng: 0 },
              customer: {
                id: "cust-far",
                businessName: "Far",
                deliveryWindowStart: "08:00",
                deliveryWindowEnd: "09:00",
              },
            },
          },
        ],
      };
    }

    function arrange(status: RouteRunStatus) {
      prisma.forTenant().routeRun.findUnique.mockResolvedValue(windowedRun(status));
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
      return jest.spyOn(service, "calculateETAs");
    }

    it("REG-B177: an underway run judges its windows against the clock the caller passes, not its scheduled departure", async () => {
      const etaSpy = arrange(RouteRunStatus.IN_PROGRESS);

      const result: any = await service.optimizeRoute("run-1", { lat: 0, lng: 0 }, "12:30");

      expect(etaSpy).toHaveBeenCalled();
      for (const call of etaSpy.mock.calls) expect(call[2]).toBe("12:30");
      expect(result.startTime).toBe("12:30");
      expect(result.windowsChecked).toBe(true);
    });

    it("REG-B177: an underway run with no caller clock is never reordered on its stale scheduled departure", async () => {
      const etaSpy = arrange(RouteRunStatus.IN_PROGRESS);

      const result: any = await service.optimizeRoute("run-1", { lat: 0, lng: 0 });

      expect(etaSpy).not.toHaveBeenCalled();
      expect(result.stopOrder).toEqual([
        { stopId: "run-stop-near", stopNumber: 1 },
        { stopId: "run-stop-mid", stopNumber: 2 },
        { stopId: "run-stop-far", stopNumber: 3 },
      ]);
      // Nothing was checked, and the result says so — an empty violations list
      // here must not read as "checked and clean".
      expect(result.windowViolations).toEqual([]);
      expect(result.windowsChecked).toBe(false);
    });

    it("REG-B147: a run that has not departed keeps its scheduled clock and is still window-repaired", async () => {
      const etaSpy = arrange(RouteRunStatus.SCHEDULED);

      const result: any = await service.optimizeRoute("run-1", { lat: 0, lng: 0 });

      expect(etaSpy).toHaveBeenCalled();
      for (const call of etaSpy.mock.calls) expect(call[2]).toBe("08:00");
      expect(result.startTime).toBe("08:00");
      expect(result.stopOrder[0].stopId).toBe("run-stop-far");
      expect(result.windowViolations).toEqual([]);
      expect(result.windowsChecked).toBe(true);
    });

    /** The ORS half of the same rule: the deterministic pass is skipped when
     *  there is no honest clock, so the ORS solver must not be handed one
     *  either — otherwise it reorders on exactly the stale departure the skip
     *  branch refuses to use. */
    function arrangeOrs(status: RouteRunStatus) {
      prisma.forTenant().routeRun.findUnique.mockResolvedValue(windowedRun(status));
      prisma.forTenant().route.findUnique.mockResolvedValue({
        id: "route-1",
        depotLat: 0,
        depotLng: 0,
        depotAddress: "Depot",
        tenantId: "tenant-1",
      });
      prisma.$transaction = jest.fn().mockResolvedValue([]);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? undefined : key === "ors.apiKey" ? "ors-key" : undefined,
      );
      systemConfigGet.mockImplementation((key: string) =>
        Promise.resolve(key === "route.defaultStartTime" ? "08:00" : null),
      );
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          routes: [
            {
              steps: [
                { type: "job", job: 1 },
                { type: "job", job: 2 },
                { type: "job", job: 3 },
              ],
            },
          ],
        }),
      });
    }

    function orsRequestBody() {
      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      return JSON.parse(init.body as string);
    }

    it("REG-B177: an underway run with no caller clock sends ORS no vehicle time_window", async () => {
      arrangeOrs(RouteRunStatus.IN_PROGRESS);

      const result: any = await service.optimizeRoute("run-1", { lat: 0, lng: 0 });

      expect(orsRequestBody().vehicles[0]).not.toHaveProperty("time_window");
      expect(result.windowsChecked).toBe(false);
    });

    it("REG-B177: an underway run WITH a caller clock sends ORS that clock as its time_window", async () => {
      arrangeOrs(RouteRunStatus.IN_PROGRESS);

      const result: any = await service.optimizeRoute("run-1", { lat: 0, lng: 0 }, "12:30");

      // 12:30 = 45000s from midnight; WORKDAY_SEC (12h workday) = 43200s.
      expect(orsRequestBody().vehicles[0].time_window).toEqual([45000, 88200]);
      expect(result.windowsChecked).toBe(true);
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
