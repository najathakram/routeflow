import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { reorderRouteStopsInTx } from "./route-stop-reorder";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Follow-up to #2135 (same shape as the run-stop reorder): `PATCH /routes/:id/stops/reorder` renumbered
 * ANY stop whose id appeared in the body, because each update matched only the stop id, so route A's
 * reorder with route B's stop ids renumbered route B's template. Runs the REAL service: every write is
 * scoped to the route, the ids must equal the route's stops, the numbers must be exactly 1..N, and the
 * route and its stops are read inside the transaction.
 */
const ROUTE = { id: "route-A" };
const STOPS = [
  { id: "a1", stopNumber: 1 },
  { id: "a2", stopNumber: 2 },
  { id: "a3", stopNumber: 3 },
];

describe("RoutesService.reorderStops (template route)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.route.findFirst.mockResolvedValue(ROUTE);
    prisma.routeStop.findMany.mockResolvedValue(STOPS);
    prisma.routeStop.updateMany.mockResolvedValue({ count: 1 });
    const mod = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: MessagingService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("k") } },
        { provide: StorageService, useValue: {} },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();
    service = mod.get(RoutesService);
  });

  const order = (...pairs: [string, number][]) =>
    pairs.map(([id, stopNumber]) => ({ id, stopNumber }));
  const noWrites = () => {
    expect(prisma.routeStop.updateMany).not.toHaveBeenCalled();
    expect(prisma.routeStop.update).not.toHaveBeenCalled();
    expect(prisma.route.update).not.toHaveBeenCalled();
  };

  it("a valid permutation renumbers every stop, each write scoped to THIS route, and clears the polyline", async () => {
    await service.reorderStops("route-A", order(["a3", 1], ["a1", 2], ["a2", 3]));
    const calls = prisma.routeStop.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) expect(c.where).toMatchObject({ routeId: "route-A" });
    const final = Object.fromEntries(
      calls
        .filter((c: any) => c.data.stopNumber <= 3)
        .map((c: any) => [c.where.id, c.data.stopNumber]),
    );
    expect(final).toEqual({ a3: 1, a1: 2, a2: 3 });
    expect(prisma.route.update).toHaveBeenCalledWith({
      where: { id: "route-A" },
      data: { plannedPolyline: null },
    });
  });

  it("CROSS-ROUTE: another route's stop id in the body is a 400 and nothing is written", async () => {
    await expect(
      service.reorderStops("route-A", order(["a1", 1], ["a2", 2], ["b1-OTHER-ROUTE", 3])),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it("PARTIAL and DUPLICATE ids are 400s", async () => {
    await expect(service.reorderStops("route-A", order(["a1", 1], ["a2", 2]))).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.reorderStops("route-A", order(["a1", 1], ["a1", 2], ["a2", 3])),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it.each([
    [
      "duplicate numbers",
      [
        ["a1", 1],
        ["a2", 1],
        ["a3", 2],
      ],
    ],
    [
      "a gap (1, 3, 4)",
      [
        ["a1", 1],
        ["a2", 3],
        ["a3", 4],
      ],
    ],
    [
      "zero-based (0, 1, 2)",
      [
        ["a1", 0],
        ["a2", 1],
        ["a3", 2],
      ],
    ],
    [
      "past N (1, 2, 5)",
      [
        ["a1", 1],
        ["a2", 2],
        ["a3", 5],
      ],
    ],
  ] as const)("numbers must be exactly 1..N: %s is a 400", async (_n, pairs) => {
    await expect(
      service.reorderStops("route-A", order(...(pairs as unknown as [string, number][]))),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it("an unknown route is a 404 and nothing is written", async () => {
    prisma.route.findFirst.mockResolvedValue(null);
    await expect(
      service.reorderStops("route-A", order(["a1", 1], ["a2", 2], ["a3", 3])),
    ).rejects.toThrow(NotFoundException);
    noWrites();
  });

  it("the route and its stops are read INSIDE the transaction", async () => {
    await service.reorderStops("route-A", order(["a1", 1], ["a2", 2], ["a3", 3]));
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.route.findFirst).toHaveBeenCalled();
  });

  // Lock conflicts: the route optimizer locks stops THEN the route, a hand reorder must not turn a
  // lost deadlock/serialization race into a raw 500. Same shape as reorderRunStops (#2631).
  describe("lock conflicts retry (the optimizer takes stops then route)", () => {
    const conflict = (code: string) => Object.assign(new Error(`conflict ${code}`), { code });
    const swap = () => order(["a3", 1], ["a1", 2], ["a2", 3]);
    const finalNumbers = () =>
      Object.fromEntries(
        prisma.routeStop.updateMany.mock.calls
          .map((c: any[]) => c[0])
          .filter((c: any) => c.data.stopNumber <= 3)
          .map((c: any) => [c.where.id, c.data.stopNumber]),
      );

    it("a 40P01 deadlock on the first attempt is retried and the reorder then succeeds", async () => {
      const real = prisma.tenantTransaction.getMockImplementation()!;
      prisma.tenantTransaction
        .mockImplementationOnce(() => Promise.reject(conflict("40P01")))
        .mockImplementation(real);
      await expect(service.reorderStops("route-A", swap())).resolves.toEqual({ success: true });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(finalNumbers()).toEqual({ a3: 1, a1: 2, a2: 3 });
    });

    it("a Prisma P2034 write conflict is retried too", async () => {
      const real = prisma.tenantTransaction.getMockImplementation()!;
      prisma.tenantTransaction
        .mockImplementationOnce(() => Promise.reject(conflict("P2034")))
        .mockImplementation(real);
      await expect(service.reorderStops("route-A", swap())).resolves.toEqual({ success: true });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
    });

    it("a conflict that never clears is surfaced after 3 attempts, never swallowed", async () => {
      prisma.tenantTransaction.mockImplementation(() => Promise.reject(conflict("40P01")));
      await expect(service.reorderStops("route-A", swap())).rejects.toMatchObject({
        code: "40P01",
      });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    });

    it("a validation 400 is NOT retried", async () => {
      await expect(service.reorderStops("route-A", order(["a1", 1]))).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // House lock order for the route family: STOP rows (id order), then Route. The real-PG behaviour
  // is pinned in run-stop-reorder-lock.db.spec.ts; this fails fast in the default lane.
  describe("reorderRouteStopsInTx lock order", () => {
    it("locks the route's stops, in id order, FOR NO KEY UPDATE (never FOR UPDATE: dispatch's FK check), BEFORE the Route row, and before any read", async () => {
      const events: string[] = [];
      const tx = {
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          events.push(strings.join("?").replace(/\s+/g, " ").trim());
          return Promise.resolve(0);
        }),
        route: {
          findFirst: jest.fn(() => (events.push("read route"), Promise.resolve(ROUTE))),
          update: jest.fn().mockResolvedValue({}),
        },
        routeStop: {
          findMany: jest.fn(() => (events.push("read stops"), Promise.resolve(STOPS))),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      await reorderRouteStopsInTx(tx, "route-A", [
        { id: "a1", stopNumber: 1 },
        { id: "a2", stopNumber: 2 },
        { id: "a3", stopNumber: 3 },
      ]);
      expect(events.slice(0, 4)).toEqual([
        'SELECT id FROM "RouteStop" WHERE "routeId" = ? ORDER BY id FOR NO KEY UPDATE',
        'SELECT id FROM "Route" WHERE id = ? FOR UPDATE',
        "read route",
        "read stops",
      ]);
    });

    it("an undefined route id throws before ANY query (it would bind NULL and lock nothing)", async () => {
      const tx = {
        $executeRaw: jest.fn(),
        route: { findFirst: jest.fn(), update: jest.fn() },
        routeStop: { findMany: jest.fn(), updateMany: jest.fn() },
      };
      await expect(reorderRouteStopsInTx(tx, undefined as never, [])).rejects.toThrow(
        /route id missing/,
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.route.findFirst).not.toHaveBeenCalled();
      expect(tx.routeStop.findMany).not.toHaveBeenCalled();
    });
  });
});
