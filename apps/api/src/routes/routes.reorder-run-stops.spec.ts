import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * #2135 (Opus review of the stop-reorder fix): `reorderRunStops` was reachable over HTTP for the
 * first time, and its service body trusted the client. `PATCH /route-runs/<run A>/stops/reorder`
 * with run B's stop ids renumbered the driver's LIVE run B, because each update matched only the
 * stop id. These pins run the REAL service (the two controller specs mock it): every write is scoped
 * to the run, the ids must equal the run's stops, the numbers must be exactly 1..N, and the status
 * and stop reads happen inside the transaction.
 */
const RUN = { id: "run-A", routeId: "route-1", status: "SCHEDULED" };
const STOPS = [
  { id: "a1", stopNumber: 1, status: "PENDING" },
  { id: "a2", stopNumber: 2, status: "PENDING" },
  { id: "a3", stopNumber: 3, status: "PENDING" },
];

describe("RoutesService.reorderRunStops (#2135)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.routeRun.findFirst.mockResolvedValue(RUN);
    prisma.routeRunStop.findMany.mockResolvedValue(STOPS);
    prisma.routeRunStop.updateMany.mockResolvedValue({ count: 1 });
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
    expect(prisma.routeRunStop.updateMany).not.toHaveBeenCalled();
    expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
    expect(prisma.route.update).not.toHaveBeenCalled();
  };

  it("a valid permutation renumbers every stop, each write scoped to THIS run, and clears the parent route's polyline", async () => {
    await service.reorderRunStops("run-A", order(["a3", 1], ["a1", 2], ["a2", 3]));
    const calls = prisma.routeRunStop.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(calls.length).toBeGreaterThanOrEqual(6); // the clearing pass + the final pass
    for (const c of calls) expect(c.where).toMatchObject({ routeRunId: "run-A" });
    const finalNumbers = new Map(
      calls
        .filter((c: any) => c.data.stopNumber <= 3)
        .map((c: any) => [c.where.id, c.data.stopNumber]),
    );
    expect(Object.fromEntries(finalNumbers)).toEqual({ a3: 1, a1: 2, a2: 3 });
    expect(prisma.route.update).toHaveBeenCalledWith({
      where: { id: "route-1" },
      data: { plannedPolyline: null },
    });
  });

  it("CROSS-RUN: another run's stop id in the body is a 400 and nothing is written (it used to renumber the other run)", async () => {
    await expect(
      service.reorderRunStops("run-A", order(["a1", 1], ["a2", 2], ["b1-OTHER-RUN", 3])),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it("PARTIAL: a body that leaves a stop out is a 400", async () => {
    await expect(service.reorderRunStops("run-A", order(["a1", 1], ["a2", 2]))).rejects.toThrow(
      BadRequestException,
    );
    noWrites();
  });

  it("DUPLICATE id is a 400", async () => {
    await expect(
      service.reorderRunStops("run-A", order(["a1", 1], ["a1", 2], ["a2", 3])),
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
  ] as const)("numbers must be exactly 1..N: %s is a 400", async (_name, pairs) => {
    await expect(
      service.reorderRunStops("run-A", order(...(pairs as unknown as [string, number][]))),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it("an unknown run is a 404 and nothing is written", async () => {
    prisma.routeRun.findFirst.mockResolvedValue(null);
    await expect(
      service.reorderRunStops("run-A", order(["a1", 1], ["a2", 2], ["a3", 3])),
    ).rejects.toThrow(NotFoundException);
    noWrites();
  });

  it.each(["IN_PROGRESS", "COMPLETED"])("a %s run is refused", async (status) => {
    prisma.routeRun.findFirst.mockResolvedValue({ ...RUN, status });
    await expect(
      service.reorderRunStops("run-A", order(["a1", 1], ["a2", 2], ["a3", 3])),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it("a stop that is IN_PROGRESS refuses the reorder even on a SCHEDULED run", async () => {
    prisma.routeRunStop.findMany.mockResolvedValue([
      STOPS[0],
      { ...STOPS[1], status: "IN_PROGRESS" },
      STOPS[2],
    ]);
    await expect(
      service.reorderRunStops("run-A", order(["a1", 1], ["a2", 2], ["a3", 3])),
    ).rejects.toThrow(BadRequestException);
    noWrites();
  });

  it("the run status and the stops are read INSIDE the transaction, not before it", async () => {
    await service.reorderRunStops("run-A", order(["a1", 1], ["a2", 2], ["a3", 3]));
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.routeRun.findUnique).not.toHaveBeenCalled();
    expect(prisma.routeRun.findFirst).toHaveBeenCalled();
  });
});
