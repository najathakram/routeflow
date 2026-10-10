/**
 * #2095 follow-up — RoutesService announces each run/stop mutation through RouteRealtime, and only
 * AFTER its write committed. Who then receives what is proven against a live Socket.IO server in
 * route-realtime.spec.ts; this suite pins the wiring: the right announcement, with the right
 * arguments, strictly after the commit, never for a rolled-back write or an idempotent replay.
 *
 * Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { RouteRealtime } from "./route-realtime";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { mockRouteRefsInTenant } from "../testing/route-refs-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));

const operator = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "tenant-1",
  tenantSlug: "test",
};

const RUN = {
  id: "run-1",
  routeId: "route-1",
  driverId: "drv-1",
  status: "SCHEDULED" as const,
  scheduledDate: new Date("2026-09-25T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  manuallyReordered: false,
  notes: null,
  createdAt: new Date("2026-09-25T00:00:00.000Z"),
  updatedAt: new Date("2026-09-25T00:00:00.000Z"),
};

const ordOut = {
  id: "ord-1",
  status: "OUT_FOR_DELIVERY",
  customerId: "c-a1",
  orderNumber: "SO-1",
  total: 50,
};
const ordDraft = {
  id: "ord-2",
  status: "DRAFT",
  customerId: "c-a1",
  orderNumber: "SO-2",
  total: 10,
};

describe("RoutesService → RouteRealtime wiring (#2095)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoicesService: Record<string, jest.Mock>;
  let events: string[];
  let stopCompleted: jest.SpyInstance;
  let stopReopened: jest.SpyInstance;
  let runProgress: jest.SpyInstance;

  /** Every tenantTransaction runs its callback, then records the commit. */
  function commitAfterCallback() {
    (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) => {
      const result = await fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0) });
      events.push("commit");
      return result;
    });
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockRouteRefsInTenant(prisma, { a1: "c-a1" });
    events = [];
    invoicesService = {
      recordDeliveryPaymentInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
      reconcileDeliveredOrdersInTx: jest.fn().mockResolvedValue(undefined),
      reverseRunAdvancesInTx: jest.fn().mockResolvedValue(0),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitToDriver: jest.fn(),
            emitDriverStatusUpdated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitRouteProgress: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: { sendToDriver: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: MessagingService,
          useValue: {
            notify: jest.fn().mockResolvedValue([]),
            notifyEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();
    service = moduleRef.get(RoutesService);

    const announce = async () => {
      events.push("announce");
    };
    stopCompleted = jest
      .spyOn(RouteRealtime.prototype, "stopCompleted")
      .mockImplementation(announce);
    stopReopened = jest.spyOn(RouteRealtime.prototype, "stopReopened").mockImplementation(announce);
    runProgress = jest.spyOn(RouteRealtime.prototype, "runProgress").mockImplementation(announce);
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── Stop completion ────────────────────────────────────────────────────────

  describe("completeStop", () => {
    beforeEach(() => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN, status: "IN_PROGRESS" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        customerId: "c-a1",
        status: "PENDING",
        signatureUrl: null,
        orders: [ordOut, ordDraft],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      // Another stop is still open, so the run does not auto-complete.
      prisma.routeRunStop.findMany.mockResolvedValue([
        { id: "stop-1", status: "PENDING" },
        { id: "stop-2", status: "PENDING" },
      ]);
      // SA-151: completion claims the stop atomically (claimStopCompletion → updateMany).
      prisma.routeRunStop.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });
    });

    it("announces the stop once, with its customer and its pre-commit orders, after the commit", async () => {
      commitAfterCallback();

      await service.completeStop("run-1", "stop-1", {}, operator);

      expect(stopCompleted).toHaveBeenCalledTimes(1);
      const [runId, stop, autoCompleted] = stopCompleted.mock.calls[0];
      expect(runId).toBe("run-1");
      expect(stop).toEqual(
        expect.objectContaining({ id: "stop-1", customerId: "c-a1", orders: [ordOut, ordDraft] }),
      );
      expect(autoCompleted).toBe(false);
      expect(events).toEqual(["commit", "announce"]);
    });

    it("announces the auto-completion when the last stop closes", async () => {
      commitAfterCallback();
      prisma.routeRunStop.findMany.mockResolvedValue([{ id: "stop-1", status: "PENDING" }]);
      prisma.routeRun.update.mockResolvedValue({});

      await service.completeStop("run-1", "stop-1", {}, operator);

      expect(stopCompleted.mock.calls[0][2]).toBe(true);
    });

    it("a rolled-back completion announces nothing", async () => {
      (prisma.tenantTransaction as jest.Mock).mockRejectedValue(new Error("serialization failure"));

      await expect(service.completeStop("run-1", "stop-1", {}, operator)).rejects.toThrow(
        "serialization failure",
      );
      expect(stopCompleted).not.toHaveBeenCalled();
      expect(runProgress).not.toHaveBeenCalled();
    });

    it("an idempotent replay announces nothing a second time", async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        { response: JSON.stringify({ id: "stop-1", status: "COMPLETED" }) },
      ]);

      await service.completeStop("run-1", "stop-1", { idempotencyKey: "key-1" }, operator);

      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(stopCompleted).not.toHaveBeenCalled();
    });
  });

  it("completeWithPayment announces the stop once, after the commit", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "c-a1",
      status: "PENDING",
      signatureUrl: null,
      orders: [ordOut],
    });
    prisma.driver.findFirst.mockResolvedValue(null);
    prisma.routeRunStop.findMany.mockResolvedValue([
      { id: "stop-1", status: "PENDING" },
      { id: "stop-2", status: "PENDING" },
    ]);
    prisma.routeRunStop.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });
    commitAfterCallback();

    await service.completeWithPayment("run-1", "stop-1", {}, operator);

    expect(stopCompleted).toHaveBeenCalledTimes(1);
    expect(stopCompleted.mock.calls[0][0]).toBe("run-1");
    expect(stopCompleted.mock.calls[0][1]).toEqual(
      expect.objectContaining({ id: "stop-1", customerId: "c-a1", orders: [ordOut] }),
    );
    expect(events).toEqual(["commit", "announce"]);
  });

  // ─── Run and stop state changes that move a tracking card ──────────────────

  it("starting a run tells the run's customers, after the write", async () => {
    prisma.routeRun.findUnique.mockResolvedValue(RUN);
    prisma.routeRun.update.mockImplementation(async () => {
      events.push("write");
      return { ...RUN, status: "IN_PROGRESS", driver: null };
    });

    await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, operator);

    expect(runProgress).toHaveBeenCalledTimes(1);
    expect(runProgress).toHaveBeenCalledWith("run-1");
    expect(events).toEqual(["write", "announce"]);
  });

  it("cancelling a run tells the run's customers, after the release commits", async () => {
    prisma.routeRun.findUnique.mockResolvedValue(RUN);
    prisma.routeRun.update.mockResolvedValue({ ...RUN, status: "CANCELLED", driver: null });
    prisma.routeRunStop.findMany.mockResolvedValue([]);
    commitAfterCallback();

    await service.updateRunStatus("run-1", { status: "CANCELLED" as any }, operator);

    expect(runProgress).toHaveBeenCalledWith("run-1");
    expect(events).toEqual(["commit", "announce"]);
  });

  it("a driver skipping a stop tells the run's customers, after the write", async () => {
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "stop-2",
      routeRunId: "run-1",
      status: "PENDING",
      arrivedAt: null,
    });
    prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1", status: "IN_PROGRESS" });
    // #2415: the write is a compare-and-swap (updateMany), then the row is read back.
    prisma.routeRunStop.updateMany.mockImplementation(async () => {
      events.push("write");
      return { count: 1 };
    });
    prisma.routeRunStop.findFirst
      .mockResolvedValueOnce({
        id: "stop-2",
        routeRunId: "run-1",
        status: "PENDING",
        arrivedAt: null,
      })
      .mockResolvedValueOnce({ id: "stop-2", status: "SKIPPED" });

    const result = await service.updateStopStatus(
      "run-1",
      "stop-2",
      { status: "SKIPPED" },
      operator,
    );

    expect(result).toEqual({ id: "stop-2", status: "SKIPPED" });
    expect(runProgress).toHaveBeenCalledWith("run-1");
    expect(events).toEqual(["write", "announce"]);
  });

  it("reordering a run's stops tells the run's customers, after the reorder commits", async () => {
    // #2135: the reorder runs in one locked tenantTransaction (reorderRunStopsInTx), so the
    // run and its stops are read inside it.
    prisma.routeRun.findFirst.mockResolvedValue(RUN);
    prisma.routeRunStop.findMany.mockResolvedValue([
      { id: "stop-1", stopNumber: 1, status: "PENDING" },
      { id: "stop-2", stopNumber: 2, status: "PENDING" },
    ]);
    prisma.routeRunStop.updateMany.mockResolvedValue({ count: 1 });
    prisma.route.update.mockResolvedValue({});
    commitAfterCallback();

    await service.reorderRunStops("run-1", [
      { id: "stop-2", stopNumber: 1 },
      { id: "stop-1", stopNumber: 2 },
    ]);

    expect(runProgress).toHaveBeenCalledWith("run-1");
    expect(events).toEqual(["commit", "announce"]);
  });

  it("dispatching a run tells its customers, after the run is committed", async () => {
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "Downtown Route",
      driverId: null,
      isActive: true,
      stops: [{ id: "rs-1", stopNumber: 1, customerId: "c-a1", customerAddressId: "a1" }],
    });
    prisma.routeRun.create.mockResolvedValue({
      ...RUN,
      route: { id: "route-1", name: "Downtown Route" },
      stops: [{ id: "rrs-1", customerId: "c-a1" }],
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    commitAfterCallback();

    await service.createRun({
      routeId: "route-1",
      driverId: "drv-1",
      scheduledDate: "2026-09-25",
    } as any);

    expect(runProgress).toHaveBeenCalledTimes(1);
    expect(runProgress).toHaveBeenCalledWith("run-1");
    expect(events).toEqual(["commit", "announce"]);
  });

  // ─── Reopen ─────────────────────────────────────────────────────────────────

  describe("reopenStop", () => {
    beforeEach(() => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN,
        status: "IN_PROGRESS",
        settlementNote: null,
        settlementVariance: null,
        stops: [
          {
            id: "stop-1",
            status: "COMPLETED",
            orders: [
              { ...ordOut, status: "DELIVERED", lineItems: [] },
              {
                id: "ord-3",
                status: "CANCELLED",
                customerId: "c-a1",
                orderNumber: "SO-3",
                total: 5,
                lineItems: [],
              },
            ],
          },
        ],
      });
      prisma.deliveryMutation.findMany.mockResolvedValue([]);
      prisma.deliveryMutation.deleteMany.mockResolvedValue({ count: 0 });
      prisma.routeRunStop.update.mockResolvedValue({});
      prisma.routeRun.update.mockResolvedValue({});
    });

    it("announces only the orders the reopen flipped back, after the commit", async () => {
      commitAfterCallback();

      await service.reopenStop("run-1", "stop-1", operator);

      expect(stopReopened).toHaveBeenCalledTimes(1);
      const [runId, reopened] = stopReopened.mock.calls[0];
      expect(runId).toBe("run-1");
      expect(reopened.map((o: { id: string }) => o.id)).toEqual(["ord-1"]);
      expect(reopened[0].status).toBe("DELIVERED");
      expect(events).toEqual(["commit", "announce"]);
    });

    it("a rolled-back reopen announces nothing", async () => {
      invoicesService.reverseRunAdvancesInTx.mockRejectedValue(
        new Error("advance already applied"),
      );

      await expect(service.reopenStop("run-1", "stop-1", operator)).rejects.toThrow(
        "advance already applied",
      );
      expect(stopReopened).not.toHaveBeenCalled();
    });
  });
});
