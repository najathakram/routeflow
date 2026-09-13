import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RouteKind, OrderStatus, FulfillPath } from "@prisma/client";
import { RoutesService, RUN_LINE_ITEMS_SELECT } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
// F03 owns the "counts as collected money" predicate. The settlement cash basis
// must stay pinned to THAT shared const rather than a literal `status: "PAID"`,
// so a future widening of CONFIRMED_PAYMENT can never silently desync run
// settlement from every other confirmed-money read in the codebase.
import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";
import { StorageService } from "../storage/storage.service";
import { geocodeAddress } from "../common/geocode.util";
import { compressImage } from "../storage/compress.util";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
// Real sharp is exercised by compress.util.spec.ts (incl. the SVG-signature
// case); here it's mocked so POD unit tests need no real image fixtures.
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed"),
    mimeType: "image/jpeg",
    ext: "jpg",
  }),
}));

const MOCK_ROUTE = {
  id: "route-1",
  name: "Downtown Route",
  driverId: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_RUN = {
  id: "run-1",
  routeId: "route-1",
  driverId: "drv-1",
  status: "SCHEDULED" as const,
  scheduledDate: new Date(),
  startedAt: null,
  completedAt: null,
  manuallyReordered: false,
  notes: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const driverPayload = {
  sub: "user-drv",
  username: "driver1",
  role: "DRIVER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("RoutesService", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: jest.Mocked<
    Pick<
      RouteFlowGateway,
      | "emitStopCompleted"
      | "emitOrderCreated"
      | "emitOrderStatusChanged"
      | "emitLowStock"
      | "emitToDriver"
    >
  >;
  let notifications: jest.Mocked<Pick<NotificationsService, "sendToDriver">>;
  let messaging: { notify: jest.Mock; notifyEvent: jest.Mock };
  let invoicesService: { recordDeliveryPaymentInTx: jest.Mock };
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoicesService = {
      recordDeliveryPaymentInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
    };

    gateway = {
      emitStopCompleted: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
      emitLowStock: jest.fn(),
      emitToDriver: jest.fn(),
    };

    notifications = {
      sendToDriver: jest.fn().mockResolvedValue(undefined),
    };

    messaging = {
      notify: jest.fn().mockResolvedValue([]),
      notifyEvent: jest.fn().mockResolvedValue(undefined),
    };

    storage = {
      upload: jest.fn().mockImplementation((key: string) => Promise.resolve(key)),
      presignedUrl: jest.fn().mockImplementation((key: string) => Promise.resolve(`signed:${key}`)),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: NotificationsService, useValue: notifications },
        { provide: MessagingService, useValue: messaging },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  // ─── Route Templates ─────────────────────────────────────────────────────

  describe("findAllRoutes", () => {
    it("should return paginated routes", async () => {
      prisma.route.findMany.mockResolvedValue([MOCK_ROUTE]);
      prisma.route.count.mockResolvedValue(1);

      const result = await service.findAllRoutes({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it("should filter by isActive", async () => {
      prisma.route.findMany.mockResolvedValue([]);
      prisma.route.count.mockResolvedValue(0);

      await service.findAllRoutes({ isActive: true, page: 1, limit: 20 });

      expect(prisma.route.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });

    // WP3: templates/route-run flows must never surface ADHOC trips unless
    // explicitly asked for.
    it("should default kind to SCHEDULED when omitted", async () => {
      prisma.route.findMany.mockResolvedValue([]);
      prisma.route.count.mockResolvedValue(0);

      await service.findAllRoutes({ page: 1, limit: 20 });

      expect(prisma.route.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: RouteKind.SCHEDULED }),
        }),
      );
    });

    it("should pass through an explicit kind filter", async () => {
      prisma.route.findMany.mockResolvedValue([]);
      prisma.route.count.mockResolvedValue(0);

      await service.findAllRoutes({ kind: RouteKind.ADHOC, page: 1, limit: 20 });

      expect(prisma.route.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ kind: RouteKind.ADHOC }),
        }),
      );
    });

    // WP2: the Deliveries history list needs run counts + a latest-run summary
    // (status/date/driver) on every row without a second round-trip.
    it("should include run/stop counts and a latest-run summary", async () => {
      prisma.route.findMany.mockResolvedValue([]);
      prisma.route.count.mockResolvedValue(0);

      await service.findAllRoutes({ page: 1, limit: 20 });

      expect(prisma.route.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: {
            _count: { select: { runs: true, stops: true } },
            runs: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                id: true,
                status: true,
                scheduledDate: true,
                completedAt: true,
                driver: { select: { id: true, contactName: true } },
              },
            },
          },
        }),
      );
    });
  });

  describe("findOneRoute", () => {
    it("should return a route with stops", async () => {
      prisma.route.findUnique.mockResolvedValue({ ...MOCK_ROUTE, stops: [] });
      const result = await service.findOneRoute("route-1");
      expect(result.id).toBe("route-1");
    });

    it("should throw NotFoundException for non-existent route", async () => {
      prisma.route.findUnique.mockResolvedValue(null);
      await expect(service.findOneRoute("nonexistent")).rejects.toThrow(NotFoundException);
    });

    it("REG-B157: excludes a removed customer's stop from the route plan", async () => {
      prisma.route.findUnique.mockResolvedValue({ ...MOCK_ROUTE, stops: [] });

      await service.findOneRoute("route-1");

      expect(prisma.route.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            stops: expect.objectContaining({
              where: { OR: [{ customerId: null }, { customer: { deletedAt: null } }] },
            }),
          }),
        }),
      );
    });
  });

  describe("addStop", () => {
    beforeEach(() => {
      prisma.route.findUnique.mockResolvedValue(MOCK_ROUTE);
      prisma.routeStop.findFirst.mockResolvedValue({ stopNumber: 3 });
      prisma.customerAddress.findFirst.mockResolvedValue({ id: "addr-1" });
      prisma.routeStop.create.mockResolvedValue({ id: "stop-new" });
    });

    it("creates the stop for a live customer", async () => {
      prisma.customer.findUnique.mockResolvedValue({ deletedAt: null });

      await service.addStop("route-1", { customerId: "cust-1" } as any);

      expect(prisma.routeStop.create).toHaveBeenCalled();
    });

    it("REG-B157: refuses to add a removed customer to a route", async () => {
      prisma.customer.findUnique.mockResolvedValue({ deletedAt: new Date() });

      await expect(service.addStop("route-1", { customerId: "cust-1" } as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.routeStop.create).not.toHaveBeenCalled();
    });

    it("REG-B157: throws NotFoundException for a nonexistent customer", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);

      await expect(service.addStop("route-1", { customerId: "cust-1" } as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getPackingList", () => {
    it("REG-B157: excludes a removed customer's stop (and its order) from the packing list", async () => {
      prisma.route.findUnique.mockResolvedValue({ ...MOCK_ROUTE, stops: [] });

      await service.getPackingList("route-1");

      expect(prisma.route.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            stops: expect.objectContaining({
              where: { OR: [{ customerId: null }, { customer: { deletedAt: null } }] },
            }),
          }),
        }),
      );
    });

    it("throws NotFoundException for a nonexistent route", async () => {
      prisma.route.findUnique.mockResolvedValue(null);
      await expect(service.getPackingList("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  describe("createRoute", () => {
    beforeEach(() => {
      (geocodeAddress as jest.Mock).mockReset();
    });

    it("should create a route with just a name (no planning fields — unchanged behavior)", async () => {
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      await service.createRoute({ name: "Downtown Route" });
      expect(prisma.route.create).toHaveBeenCalledWith({ data: { name: "Downtown Route" } });
    });

    it("should persist depot* as-is + originKind=TENANT for a TENANT origin (no server geocode)", async () => {
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      await service.createRoute({
        name: "Downtown Route",
        depotLat: 30.1,
        depotLng: -97.1,
        depotAddress: "123 Main St",
        origin: { type: "TENANT" } as any,
      });
      expect(geocodeAddress).not.toHaveBeenCalled();
      expect(prisma.route.create).toHaveBeenCalledWith({
        data: {
          name: "Downtown Route",
          depotLat: 30.1,
          depotLng: -97.1,
          depotAddress: "123 Main St",
          originKind: "TENANT",
        },
      });
    });

    it("should resolve a DRIVER origin from the driver's home base", async () => {
      prisma.driver.findFirst.mockResolvedValue({
        id: "drv-1",
        contactName: "Sam",
        homeLat: 31.0,
        homeLng: -98.0,
        homeAddress: "Sam's home",
      });
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      await service.createRoute({
        name: "Downtown Route",
        origin: { type: "DRIVER", driverId: "drv-1" } as any,
      });
      expect(prisma.route.create).toHaveBeenCalledWith({
        data: {
          name: "Downtown Route",
          depotLat: 31.0,
          depotLng: -98.0,
          depotAddress: "Sam's home",
          originKind: "DRIVER",
        },
      });
    });

    it("should 400 a DRIVER origin when the driver has no home base", async () => {
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1", contactName: "Sam", homeLat: null });
      await expect(
        service.createRoute({
          name: "Downtown Route",
          origin: { type: "DRIVER", driverId: "drv-1" } as any,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.route.create).not.toHaveBeenCalled();
    });

    it("should geocode an ADDRESS origin", async () => {
      (geocodeAddress as jest.Mock).mockResolvedValue({ lat: 30.27, lng: -97.74 });
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      await service.createRoute({
        name: "Downtown Route",
        origin: { type: "ADDRESS", line1: "1 Congress Ave", city: "Austin", state: "TX" } as any,
      });
      expect(prisma.route.create).toHaveBeenCalledWith({
        data: {
          name: "Downtown Route",
          depotLat: 30.27,
          depotLng: -97.74,
          depotAddress: "1 Congress Ave, Austin, TX",
          originKind: "ADDRESS",
        },
      });
    });

    it("should 400 when an ADDRESS origin fails to geocode", async () => {
      (geocodeAddress as jest.Mock).mockResolvedValue(null);
      await expect(
        service.createRoute({
          name: "Downtown Route",
          origin: { type: "ADDRESS", line1: "nowhere" } as any,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.route.create).not.toHaveBeenCalled();
    });

    it("should persist a RETURN_TO_START end mirroring the resolved origin coords", async () => {
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      await service.createRoute({
        name: "Downtown Route",
        depotLat: 30.1,
        depotLng: -97.1,
        depotAddress: "123 Main St",
        origin: { type: "TENANT" } as any,
        end: { type: "RETURN_TO_START" } as any,
      });
      expect(prisma.route.create).toHaveBeenCalledWith({
        data: {
          name: "Downtown Route",
          depotLat: 30.1,
          depotLng: -97.1,
          depotAddress: "123 Main St",
          originKind: "TENANT",
          endKind: "RETURN_TO_START",
          endLat: 30.1,
          endLng: -97.1,
          endAddress: "123 Main St",
        },
      });
    });

    it("should persist avoidTolls/optimizeBy when provided", async () => {
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      await service.createRoute({
        name: "Downtown Route",
        avoidTolls: true,
        optimizeBy: "DISTANCE",
      });
      expect(prisma.route.create).toHaveBeenCalledWith({
        data: {
          name: "Downtown Route",
          avoidTolls: true,
          optimizeBy: "DISTANCE",
        },
      });
    });
  });

  describe("removeStop", () => {
    it("should delete a stop from a route", async () => {
      prisma.routeStop.findFirst.mockResolvedValue({ id: "stop-1", routeId: "route-1" });
      prisma.routeStop.delete.mockResolvedValue({});

      const result = await service.removeStop("route-1", "stop-1");

      expect(result).toEqual({ success: true });
      expect(prisma.routeStop.delete).toHaveBeenCalledWith({ where: { id: "stop-1" } });
    });

    it("should throw NotFoundException when stop does not belong to route", async () => {
      prisma.routeStop.findFirst.mockResolvedValue(null);
      await expect(service.removeStop("route-1", "stop-x")).rejects.toThrow(NotFoundException);
    });
  });

  // ─── deleteRoute — REG-B96 (destructive-write guard) ─────────────────────
  //
  // R3: refuse hard delete when ANY run is IN_PROGRESS/COMPLETED, regardless
  // of route.kind — not just ADHOC (drop the ADHOC gate, keep the existing
  // message). Today's guard only fires for `route.kind === RouteKind.ADHOC`,
  // so a SCHEDULED route with a delivered, POD-bearing run sails straight
  // through it and is destroyed. createMockPrisma()'s model mocks are plain
  // jest.fn()s here (no stateful fake store needed) — the oracle is which
  // methods get called, not persisted row state, exactly like the existing
  // "plannedPolyline invalidation" tests in this file.

  describe("deleteRoute", () => {
    it("REG-B96 / T-B96: refuses a SCHEDULED route with a COMPLETED run and deletes nothing", async () => {
      prisma.route.findUnique.mockResolvedValue({ ...MOCK_ROUTE, kind: RouteKind.SCHEDULED });
      prisma.routeRun.findMany.mockResolvedValue([
        {
          id: "run-1",
          status: "COMPLETED",
          // A POD-bearing stop — exactly the row R3 says must never be
          // deletable through this path.
          stops: [{ id: "rrs-1", signatureUrl: "tenants/test-tenant/pod/rrs-1/signature-x.png" }],
        },
      ]);

      // RED TODAY: the guard is gated on `route.kind === RouteKind.ADHOC`, so
      // a SCHEDULED route sails straight through it and nothing is rejected.
      await expect(service.deleteRoute("route-1")).rejects.toThrow(BadRequestException);

      // Call-shape, not return value: a guard that throws AFTER already
      // deleting would still pass a return-value-only check.
      expect(prisma.routeRunStop.deleteMany).not.toHaveBeenCalled();
      expect(prisma.routeRun.deleteMany).not.toHaveBeenCalled();
      expect(prisma.route.delete).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
  });

  // ─── plannedPolyline invalidation ─────────────────────────────────────────
  //
  // The map renders Route.plannedPolyline verbatim and deliberately SKIPS its
  // Routes API fetch while one is present. So any change to which stops are on
  // a route — or what order they're in — must clear it, or the map keeps
  // drawing the old path with no way to self-correct. applyRouteVariant
  // (route-optimization.service.ts) is the only writer.

  describe("plannedPolyline invalidation on stop mutations", () => {
    const polylineCleared = () =>
      prisma.route.update.mock.calls.some(
        ([args]: any) => args?.data?.plannedPolyline === null && args?.where?.id === "route-1",
      );

    beforeEach(() => {
      prisma.route.findUnique.mockResolvedValue(MOCK_ROUTE);
      prisma.route.findFirst.mockResolvedValue(MOCK_ROUTE);
    });

    it("addStop clears it", async () => {
      prisma.customer.findUnique.mockResolvedValue({ deletedAt: null });
      prisma.routeStop.findFirst.mockResolvedValue({ stopNumber: 3 });
      prisma.customerAddress.findFirst.mockResolvedValue({ id: "addr-1" });
      prisma.routeStop.create.mockResolvedValue({ id: "stop-new" });

      await service.addStop("route-1", { customerId: "cust-1" } as any);

      expect(polylineCleared()).toBe(true);
    });

    it("removeStop clears it", async () => {
      prisma.routeStop.findFirst.mockResolvedValue({ id: "stop-1", routeId: "route-1" });
      prisma.routeRunStop.findFirst.mockResolvedValue(null);
      prisma.routeStop.delete.mockResolvedValue({});

      await service.removeStop("route-1", "stop-1");

      expect(polylineCleared()).toBe(true);
    });

    it("reorderStops clears it in the same transaction", async () => {
      prisma.routeStop.findMany.mockResolvedValue([
        { id: "stop-1", stopNumber: 1 },
        { id: "stop-2", stopNumber: 2 },
      ]);
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      await service.reorderStops("route-1", [
        { id: "stop-2", stopNumber: 1 },
        { id: "stop-1", stopNumber: 2 },
      ]);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(polylineCleared()).toBe(true);
    });

    it("reorderRunStops clears the PARENT route's polyline — it's what the run map draws", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, routeId: "route-1" });
      prisma.routeRunStop.findMany.mockResolvedValue([
        { id: "runstop-1", stopNumber: 1 },
        { id: "runstop-2", stopNumber: 2 },
      ]);
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      await service.reorderRunStops("run-1", [
        { id: "runstop-2", stopNumber: 1 },
        { id: "runstop-1", stopNumber: 2 },
      ]);

      expect(polylineCleared()).toBe(true);
    });
  });

  describe("getCustomerRouteAssignments", () => {
    // WP3: ad-hoc trips must never pollute the "Currently in:" customer hints.
    it("should filter to SCHEDULED routes only", async () => {
      prisma.routeStop.findMany.mockResolvedValue([]);

      await service.getCustomerRouteAssignments();

      expect(prisma.routeStop.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ route: { kind: RouteKind.SCHEDULED } }),
        }),
      );
    });

    it("REG-B157: excludes a removed customer's stop — same predicate customers.service.ts's unassigned=1 filter relies on", async () => {
      prisma.routeStop.findMany.mockResolvedValue([]);

      await service.getCustomerRouteAssignments();

      expect(prisma.routeStop.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ customer: { deletedAt: null } }),
        }),
      );
    });
  });

  // ─── Route Runs ───────────────────────────────────────────────────────────

  describe("findOneRun", () => {
    it("should return a run with stops", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, stops: [] });
      const result = await service.findOneRun("run-1");
      expect(result.id).toBe("run-1");
    });

    it("should throw NotFoundException for non-existent run", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(null);
      await expect(service.findOneRun("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateRunStatus", () => {
    it("should allow operators to set any status", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.routeRun.update.mockResolvedValue({ ...MOCK_RUN, status: "CANCELLED" });

      const result = await service.updateRunStatus(
        "run-1",
        { status: "CANCELLED" as any },
        operatorPayload,
      );
      expect(prisma.routeRun.update).toHaveBeenCalled();
    });

    it("should allow drivers to set IN_PROGRESS", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.routeRun.update.mockResolvedValue({ ...MOCK_RUN, status: "IN_PROGRESS" });
      // B72: updateRunStatus now verifies driver ownership via the driver
      // table — MOCK_RUN.driverId is "drv-1".
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, driverPayload);
      expect(prisma.routeRun.update).toHaveBeenCalled();
    });

    it("should forbid drivers from setting CANCELLED", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      await expect(
        service.updateRunStatus("run-1", { status: "CANCELLED" as any }, driverPayload),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should set startedAt when transitioning to IN_PROGRESS", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
      prisma.routeRun.update.mockResolvedValue({});

      await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, operatorPayload);

      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ startedAt: expect.any(Date) }),
        }),
      );
    });

    it("should set completedAt when transitioning to COMPLETED", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, status: "IN_PROGRESS" });
      prisma.routeRun.update.mockResolvedValue({});

      await service.updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload);

      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ completedAt: expect.any(Date) }),
        }),
      );
    });

    it("should throw NotFoundException for non-existent run", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(null);

      await expect(
        service.updateRunStatus("nonexistent", { status: "COMPLETED" as any }, operatorPayload),
      ).rejects.toThrow(NotFoundException);
    });

    // T-B152c / R7a / REG-B152 — a cash-carrying run cannot close unsettled via
    // ANY path (role-agnostic). This is the backstop for the (rare, but real)
    // case where something other than RF-016 drives the run to COMPLETED.
    describe("cash-settlement backstop (T-B152c / R7a / REG-B152)", () => {
      // Refusal AND allowance in ONE test, deliberately: a standalone
      // "allows it once the note is set" case would PASS today (no guard exists,
      // so every COMPLETED transition already succeeds) and would keep passing
      // whether the guard is written correctly, incorrectly, or not at all.
      // Folded behind the refusal, the whole test is red pre-fix on phase 1 and
      // only goes green when BOTH halves of the predicate hold.
      it("REG-B152: refuses COMPLETED when cash sits uncollected and no settlementNote is set, naming the amount — and allows it once the note is set", async () => {
        // ── phase 1: cash outstanding, no note → refused, message names the amount
        prisma.routeRun.findUnique.mockResolvedValue({
          ...MOCK_RUN,
          status: "IN_PROGRESS",
          settlementNote: null,
        });
        prisma.routeRunStop.findMany.mockResolvedValue([{ status: "COMPLETED" }]);
        prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 40, method: "CASH" }]);
        prisma.advancePayment.findMany.mockResolvedValue([]);

        const err: any = await service
          .updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload)
          .catch((e: any) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.message).toEqual(expect.stringContaining("40"));

        // ── phase 2: same run and same outstanding cash, note now present → completes.
        // No invoicePayment assertion here on purpose — a correct implementation
        // may short-circuit on `settlementNote != null` before it ever queries.
        prisma.routeRun.findUnique.mockResolvedValue({
          ...MOCK_RUN,
          status: "IN_PROGRESS",
          settlementNote: "settled at close",
        });
        prisma.routeRun.update.mockResolvedValue({ ...MOCK_RUN, status: "COMPLETED" });

        await service.updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload);

        expect(prisma.routeRun.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
        );
      });

      // The gate's basis is PHYSICAL money — CASH **and CHECK** — matching
      // mobile's `shouldForceSettlement`. A cash-only predicate would let a
      // check-only run close with no settlement on record: the same B152 gap,
      // reached through CHECK instead of CASH.
      it("REG-B152: refuses COMPLETED when the run's only at-door money was a CHECK", async () => {
        prisma.routeRun.findUnique.mockResolvedValue({
          ...MOCK_RUN,
          status: "IN_PROGRESS",
          settlementNote: null,
        });
        prisma.routeRunStop.findMany.mockResolvedValue([{ status: "COMPLETED" }]);
        prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 500, method: "CHECK" }]);
        prisma.advancePayment.findMany.mockResolvedValue([]);

        const err: any = await service
          .updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload)
          .catch((e: any) => e);

        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.message).toEqual(expect.stringContaining("500"));
        expect(prisma.routeRun.update).not.toHaveBeenCalled();
      });

      it("REG-B152: completes a run with nothing collected, having actually evaluated the cash predicate", async () => {
        prisma.routeRun.findUnique.mockResolvedValue({
          ...MOCK_RUN,
          status: "IN_PROGRESS",
          settlementNote: null,
        });
        prisma.routeRunStop.findMany.mockResolvedValue([{ status: "COMPLETED" }]);
        // invoicePayment/advancePayment findMany default to [] in the prisma mock —
        // i.e. a run that collected nothing.
        prisma.routeRun.update.mockResolvedValue({ ...MOCK_RUN, status: "COMPLETED" });

        await service.updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload);

        expect(prisma.routeRun.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
        );
        // The discriminating half: the completion must have been ALLOWED by a
        // zero balance, not by a guard that was never evaluated. False today
        // (updateRunStatus reads no payments at all), true only once R7a's
        // predicate runs on this path.
        expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              invoice: expect.objectContaining({
                order: expect.objectContaining({ routeRunId: "run-1" }),
              }),
            }),
          }),
        );
      });
    });
  });

  describe("createRun", () => {
    it("should throw NotFoundException when route does not exist", async () => {
      prisma.route.findUnique.mockResolvedValue(null);

      await expect(
        service.createRun({ routeId: "nonexistent", scheduledDate: "2025-01-01" } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it("should create a run with stops mirroring the route template", async () => {
      prisma.route.findUnique.mockResolvedValue({
        ...MOCK_ROUTE,
        stops: [{ id: "rs-1", stopNumber: 1, customerId: "c1", customerAddressId: "a1" }],
      });
      // RF-015: createRun now accesses run.route and run.stops — supply them in the mock
      prisma.routeRun.create.mockResolvedValue({
        ...MOCK_RUN,
        driverId: null,
        scheduledDate: new Date("2025-06-01"),
        route: { id: "route-1", name: "Downtown Route" },
        stops: [],
      });
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await service.createRun({
        routeId: "route-1",
        driverId: "drv-1",
        scheduledDate: "2025-06-01",
      } as any);

      expect(prisma.routeRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stops: {
              create: [
                expect.objectContaining({
                  routeStopId: "rs-1",
                  stopNumber: 1,
                  customerId: "c1",
                  customerAddressId: "a1",
                }),
              ],
            },
          }),
        }),
      );
    });

    // RF-015: operator dispatch must emit route.dispatched to the driver's socket room
    it("should emit route.dispatched via gateway when driver is assigned", async () => {
      const mockRun = {
        ...MOCK_RUN,
        driverId: "drv-1",
        scheduledDate: new Date("2025-06-01"),
        route: { id: "route-1", name: "Downtown Route" },
        stops: [{ id: "rrs-1", customerId: "c1" }],
      };
      prisma.route.findUnique.mockResolvedValue({
        ...MOCK_ROUTE,
        stops: [{ id: "rs-1", stopNumber: 1, customerId: "c1", customerAddressId: "a1" }],
      });
      prisma.routeRun.create.mockResolvedValue(mockRun);
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await service.createRun({
        routeId: "route-1",
        driverId: "drv-1",
        scheduledDate: "2025-06-01",
      } as any);

      expect(gateway.emitToDriver).toHaveBeenCalledWith(
        expect.anything(), // tenantId
        "drv-1",
        expect.objectContaining({
          runId: mockRun.id,
          routeId: "route-1",
          routeName: "Downtown Route",
          stopCount: 1,
        }),
      );
    });

    // RF-015: no socket emit when no driver assigned
    it("should NOT emit route.dispatched when no driver is assigned", async () => {
      const mockRun = {
        ...MOCK_RUN,
        driverId: null,
        scheduledDate: new Date("2025-06-01"),
        route: { id: "route-1", name: "Downtown Route" },
        stops: [],
      };
      prisma.route.findUnique.mockResolvedValue({
        ...MOCK_ROUTE,
        stops: [],
      });
      prisma.routeRun.create.mockResolvedValue(mockRun);

      await service.createRun({
        routeId: "route-1",
        scheduledDate: "2025-06-01",
      } as any);

      expect(gateway.emitToDriver).not.toHaveBeenCalled();
    });

    // REG-B131: a removed (soft-deleted) customer's stop is never dispatched — every write at that
    // door (delivery, order, invoice) is already refused, so sending a driver there is a wasted trip.
    describe("removed-customer stops (B131)", () => {
      const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");

      const stops = (removedAt: Date | null) => [
        {
          id: "rs-live",
          stopNumber: 1,
          customerId: "c-live",
          customerAddressId: "a1",
          customer: { deletedAt: null },
        },
        {
          id: "rs-removed",
          stopNumber: 2,
          customerId: "c-removed",
          customerAddressId: "a2",
          customer: { deletedAt: removedAt },
        },
        // A manual/depot stop: no customer at all, so the relation filter must not drop it.
        {
          id: "rs-manual",
          stopNumber: 3,
          customerId: null,
          customerAddressId: null,
          customer: null,
        },
      ];

      // Honest stand-in for Postgres: applies the nested `include.stops.where` the service actually
      // sends, so a where-only fix is observable (L-081: a mock that hands back a fixed stop list
      // cannot see one).
      function boot(rows: any[]) {
        prisma.route.findUnique.mockImplementation((async (args: any) => {
          const where = args?.include?.stops?.where;
          const matches = (r: any) =>
            !where ||
            where.OR.some((c: any) =>
              Object.prototype.hasOwnProperty.call(c, "customerId")
                ? r.customerId === c.customerId
                : r.customer?.deletedAt === null,
            );
          return { ...MOCK_ROUTE, stops: rows.filter(matches) };
        }) as any);
        prisma.routeRun.create.mockResolvedValue({
          ...MOCK_RUN,
          driverId: null,
          scheduledDate: new Date("2026-09-10"),
          route: { id: "route-1", name: "Downtown Route" },
          stops: [],
        });
        prisma.order.updateMany.mockResolvedValue({ count: 0 });
      }

      it("REG-B131 T15: createRun skips stops of removed customers and warns", async () => {
        boot(stops(REMOVED_AT));
        prisma.routeStop.count.mockResolvedValue(1 as any);
        const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});

        await service.createRun({ routeId: "route-1", scheduledDate: "2026-09-10" } as any);

        const created = prisma.routeRun.create.mock.calls[0][0] as any;
        expect(created.data.stops.create.map((s: any) => s.routeStopId)).toEqual([
          "rs-live",
          "rs-manual",
        ]);
        // The warned number must come from the suppressed set, not from any set: a count whose where
        // is flipped (or loses the relation filter) would log a confident wrong number.
        expect(prisma.routeStop.count).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ customer: { deletedAt: { not: null } } }),
          }),
        );
        const suppressionWarnings = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes("REG-B131"));
        expect(suppressionWarnings).toHaveLength(1);
        expect(suppressionWarnings[0]).toContain("1");
        expect(suppressionWarnings[0]).toContain("route-1");
      });

      it("B131 P14: live stops are all dispatched", async () => {
        boot(stops(null));
        const warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => {});

        await service.createRun({ routeId: "route-1", scheduledDate: "2026-09-10" } as any);

        const created = prisma.routeRun.create.mock.calls[0][0] as any;
        expect(created.data.stops.create.map((s: any) => s.routeStopId)).toEqual([
          "rs-live",
          "rs-removed",
          "rs-manual",
        ]);
        expect(warn.mock.calls.filter((c) => String(c[0]).includes("REG-B131"))).toHaveLength(0);
      });
    });

    // WP3: ad-hoc trip sweep narrowing — the SCHEDULED where-object is
    // money-critical (it controls which orders attach to a run, and thus
    // delivery payments downstream), so it is pinned by deep-equal here. The
    // ONE deliberate addition vs. the pre-feature shape is the `fulfillPath`
    // guard; it needs owner sign-off and a pre-deploy customer audit, both
    // documented in docs/phase0-adhoc-trips-findings.md.
    describe("dispatch sweep narrowing (kind / orderIds)", () => {
      const routeStops = [{ id: "rs-1", stopNumber: 1, customerId: "c1", customerAddressId: "a1" }];
      const createdRun = {
        ...MOCK_RUN,
        route: { id: "route-1", name: "Downtown Route" },
        stops: [{ id: "rrs-1", customerId: "c1" }],
      };
      // Every key the sweep has ever had, plus the fulfillPath guard that keeps
      // carrier-shipped orders off delivery runs. `fulfillPath` defaults to ROUTE
      // and is never backfilled, so this is behaviour-identical for existing data.
      const EXPECTED_SCHEDULED_WHERE = {
        customerId: "c1",
        status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
        routeRunStopId: null,
        fulfillPath: FulfillPath.ROUTE,
      };

      it("SCHEDULED dispatch with no orderIds: sweep where deep-equals today's shape, no id key", async () => {
        prisma.route.findUnique.mockResolvedValue({
          ...MOCK_ROUTE,
          kind: RouteKind.SCHEDULED,
          stops: routeStops,
        });
        prisma.routeRun.create.mockResolvedValue(createdRun);
        prisma.order.updateMany.mockResolvedValue({ count: 0 });

        await service.createRun({
          routeId: "route-1",
          scheduledDate: "2025-06-01",
        } as any);

        const sweepArgs = prisma.order.updateMany.mock.calls[0][0];
        expect(sweepArgs.where).toEqual(EXPECTED_SCHEDULED_WHERE);
        expect(sweepArgs.where).not.toHaveProperty("id");
      });

      it("SCHEDULED route + orderIds: rejects with BadRequestException before any writes", async () => {
        prisma.route.findUnique.mockResolvedValue({
          ...MOCK_ROUTE,
          kind: RouteKind.SCHEDULED,
          stops: routeStops,
        });

        await expect(
          service.createRun({
            routeId: "route-1",
            scheduledDate: "2025-06-01",
            orderIds: ["ord-1"],
          } as any),
        ).rejects.toThrow(BadRequestException);

        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(prisma.routeRun.create).not.toHaveBeenCalled();
      });

      it("ADHOC route + orderIds: sweep where gains ONLY id:{in:...}, retains customerId + routeRunStopId:null", async () => {
        prisma.route.findUnique.mockResolvedValue({
          ...MOCK_ROUTE,
          kind: RouteKind.ADHOC,
          stops: routeStops,
        });
        prisma.routeRun.create.mockResolvedValue(createdRun);
        prisma.order.updateMany.mockResolvedValue({ count: 1 });

        await service.createRun({
          routeId: "route-1",
          scheduledDate: "2025-06-01",
          orderIds: ["ord-1", "ord-2"],
        } as any);

        const sweepArgs = prisma.order.updateMany.mock.calls[0][0];
        expect(sweepArgs.where).toEqual({
          ...EXPECTED_SCHEDULED_WHERE,
          id: { in: ["ord-1", "ord-2"] },
        });
      });

      // A draft trip writes no order linkage, so a dispatch that arrives without
      // orderIds (route-detail "Dispatch Run", a re-dispatch of a finished trip)
      // has nothing to narrow the sweep with and would attach every open order of
      // each stop's customer. Fail closed — only the trip builder may dispatch.
      it("ADHOC route with no orderIds: rejects with BadRequestException before any writes", async () => {
        prisma.route.findUnique.mockResolvedValue({
          ...MOCK_ROUTE,
          kind: RouteKind.ADHOC,
          stops: routeStops,
        });

        await expect(
          service.createRun({
            routeId: "route-1",
            scheduledDate: "2025-06-01",
          } as any),
        ).rejects.toThrow(BadRequestException);

        expect(prisma.order.updateMany).not.toHaveBeenCalled();
        expect(prisma.routeRun.create).not.toHaveBeenCalled();
      });

      it("reports attachedOrderCount so the caller can detect orders dropped between build and send", async () => {
        prisma.route.findUnique.mockResolvedValue({
          ...MOCK_ROUTE,
          kind: RouteKind.ADHOC,
          stops: routeStops,
        });
        prisma.routeRun.create.mockResolvedValue(createdRun);
        // Asked for two orders; one was cancelled/dispatched elsewhere meanwhile.
        prisma.order.updateMany.mockResolvedValue({ count: 1 });

        const run = await service.createRun({
          routeId: "route-1",
          scheduledDate: "2025-06-01",
          orderIds: ["ord-1", "ord-2"],
        } as any);

        expect(run.attachedOrderCount).toBe(1);
      });

      it("re-pin: a second dispatch on a route with an active run still throws ConflictException", async () => {
        prisma.route.findUnique.mockResolvedValue({
          ...MOCK_ROUTE,
          kind: RouteKind.SCHEDULED,
          stops: routeStops,
        });
        prisma.routeRun.findFirst.mockResolvedValue({ id: "run-existing" });

        await expect(
          service.createRun({
            routeId: "route-1",
            scheduledDate: "2025-06-01",
          } as any),
        ).rejects.toThrow(ConflictException);

        expect(prisma.order.updateMany).not.toHaveBeenCalled();
      });
    });
  });

  // ─── RF-016: Auto-complete run when last stop is DELIVERED ────────────────

  describe("completeStop (RF-016)", () => {
    const IN_PROGRESS_RUN = { ...MOCK_RUN, status: "IN_PROGRESS" as const };

    it("should auto-complete the run when the last remaining stop is completed", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      // Simulate two stops — one being completed now, one already COMPLETED
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([
            { id: "stop-1", status: "PENDING" },
            { id: "stop-2", status: "COMPLETED" },
          ]),
          update: jest.fn().mockResolvedValue({}),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "stop-1", status: "COMPLETED" }),
        },
        routeRun: {
          ...prisma.routeRun,
          update: jest.fn().mockResolvedValue({}),
        },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeStop("run-1", "stop-1", {}, operatorPayload);

      expect(txMock.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({ status: "COMPLETED" }),
        }),
      );
    });

    it("should NOT auto-complete the run when other stops are still pending", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([
            { id: "stop-1", status: "PENDING" },
            { id: "stop-2", status: "PENDING" }, // still pending
          ]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn() },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeStop("run-1", "stop-1", {}, operatorPayload);

      expect(txMock.routeRun.update).not.toHaveBeenCalled();
    });

    // T-B152d / R7b / REG-B152 — RF-016 bypasses updateRunStatus entirely, so on
    // the common path (last stop closes with cash in hand) no backstop there can
    // ever fire. The auto-complete itself must refuse to flip the run when cash
    // sits uncollected and no settlementNote exists yet.
    it("REG-B152: RF-016 does not auto-complete when cash sits uncollected and no settlementNote is set", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...IN_PROGRESS_RUN, settlementNote: null });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 40, method: "CASH" }]);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([
            { id: "stop-1", status: "PENDING" },
            { id: "stop-2", status: "COMPLETED" },
          ]),
          update: jest.fn().mockResolvedValue({}),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "stop-1", status: "COMPLETED" }),
        },
        routeRun: {
          ...prisma.routeRun,
          update: jest.fn().mockResolvedValue({}),
        },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeStop("run-1", "stop-1", {}, operatorPayload);

      // Every stop is done (allDone=true) yet the run must stay IN_PROGRESS.
      expect(txMock.routeRun.update).not.toHaveBeenCalled();
    });

    // T-B148b / R3 / REG-B148 — findOneRun selects productId and reopenStop gates
    // stock-restore on it, but both deliveryMutation.create sites omit it. The
    // value persisted is the ORDER ITEM's productId (a real Product FK read
    // through the tenant-scoped tx), never the client's — the payload below
    // deliberately carries a different id to pin that.
    it("REG-B148: deliveryMutation.create receives the order item's productId, not the client's", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn() },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: {
          ...prisma.orderItem,
          findFirst: jest
            .fn()
            .mockResolvedValue({ orderId: "ord-1", productId: "prod-1", unitPrice: 10 }),
        },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeStop(
        "run-1",
        "stop-1",
        {
          deliveries: [
            {
              orderItemId: "oi-1",
              productId: "prod-from-client",
              type: "DELIVERED",
              quantityDelivered: 3,
            },
          ],
        } as any,
        operatorPayload,
      );

      expect(txMock.deliveryMutation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: "prod-1" }) }),
      );
    });

    // P6-5: transactional trigger — DELIVERED fires per eligible order after
    // the tx commits (driver completion bypasses changeStatus entirely).
    it("fires DELIVERED once for the eligible order and skips CANCELLED/DELIVERED", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [
          {
            id: "ord-1",
            status: "OUT_FOR_DELIVERY",
            customerId: "cust-1",
            orderNumber: "ORD-100",
            total: 42,
          },
          {
            id: "ord-2",
            status: "CANCELLED",
            customerId: "cust-2",
            orderNumber: "ORD-101",
            total: 5,
          },
          {
            id: "ord-3",
            status: "DELIVERED",
            customerId: "cust-3",
            orderNumber: "ORD-102",
            total: 7,
          },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeStop("run-1", "stop-1", {}, operatorPayload);

      expect(messaging.notifyEvent).toHaveBeenCalledTimes(1);
      expect(messaging.notifyEvent).toHaveBeenCalledWith(
        "DELIVERED",
        expect.objectContaining({
          customerId: "cust-1",
          senderId: operatorPayload.sub,
          vars: expect.objectContaining({ orderNumber: "ORD-100", orderTotal: "$42.00" }),
        }),
      );
    });

    // Durable POD: a data-URL signature is ingested into storage and the stop
    // persists the storage KEY; legacy strings (file:// URIs) pass through.
    it("ingests a data-URL signature into storage and persists the key", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn() },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeStop(
        "run-1",
        "stop-1",
        {
          signatureUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
          podPhotoUrls: ["file:///legacy-device-path.jpg"],
        },
        operatorPayload,
      );

      const keyRe = /^tenants\/test-tenant\/pod\/stop-1\/signature-[a-f0-9-]+\.jpg$/;
      expect(storage.upload).toHaveBeenCalledWith(
        expect.stringMatching(keyRe),
        expect.any(Buffer),
        "image/jpeg",
      );
      expect(txMock.routeRunStop.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "stop-1" },
          data: expect.objectContaining({
            signatureUrl: expect.stringMatching(keyRe),
            podPhotoUrls: ["file:///legacy-device-path.jpg"],
          }),
        }),
      );
    });
  });

  // ─── Durable POD artifacts ───────────────────────────────────────────────

  describe("attachPodArtifact / getStopPod", () => {
    const STOP = {
      id: "stop-1",
      routeRunId: "run-1",
      status: "PENDING",
      podPhotoUrls: [] as string[],
      signatureUrl: null as string | null,
      driverNote: null,
      completedAt: null,
      ageCheckRequired: false,
      identityCheckRequired: false,
      ageVerified: false,
      identityVerified: false,
      identityType: null,
    };
    const PHOTO_DATA_URL = "data:image/jpeg;base64,/9j/fake";

    beforeEach(() => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);
    });

    it("appends a photo key to the stop and returns a presigned url", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({ ...STOP });

      const result = await service.attachPodArtifact(
        "run-1",
        "stop-1",
        {
          kind: "photo",
          dataUrl: PHOTO_DATA_URL,
          artifactId: "abcd1234",
        },
        operatorPayload,
      );

      const key = "tenants/test-tenant/pod/stop-1/photo-abcd1234.jpg";
      expect(storage.upload).toHaveBeenCalledWith(key, expect.any(Buffer), "image/jpeg");
      expect(prisma.routeRunStop.update).toHaveBeenCalledWith({
        where: { id: "stop-1" },
        data: { podPhotoUrls: { push: key } },
      });
      expect(result).toEqual({ key, url: `signed:${key}` });
    });

    it("sets the signature key on a signature attach", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({ ...STOP });

      await service.attachPodArtifact(
        "run-1",
        "stop-1",
        {
          kind: "signature",
          dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
          artifactId: "sig00001",
        },
        operatorPayload,
      );

      expect(prisma.routeRunStop.update).toHaveBeenCalledWith({
        where: { id: "stop-1" },
        data: { signatureUrl: "tenants/test-tenant/pod/stop-1/signature-sig00001.jpg" },
      });
    });

    it("is idempotent per artifactId — a replay returns the existing key without re-uploading", async () => {
      const existingKey = "tenants/test-tenant/pod/stop-1/photo-abcd1234.jpg";
      prisma.routeRunStop.findFirst.mockResolvedValue({ ...STOP, podPhotoUrls: [existingKey] });

      const result = await service.attachPodArtifact(
        "run-1",
        "stop-1",
        {
          kind: "photo",
          dataUrl: PHOTO_DATA_URL,
          artifactId: "abcd1234",
        },
        operatorPayload,
      );

      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      expect(result).toEqual({ key: existingKey, url: `signed:${existingKey}` });
    });

    it("rejects a payload that is not an image data URL", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({ ...STOP });

      await expect(
        service.attachPodArtifact(
          "run-1",
          "stop-1",
          {
            kind: "photo",
            dataUrl: "file:///device-local.jpg",
          },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.attachPodArtifact(
          "run-1",
          "stop-1",
          {
            kind: "photo",
            dataUrl: "data:text/html,<script>alert(1)</script>",
          },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("404s when the stop does not belong to the run", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue(null);

      await expect(
        service.attachPodArtifact(
          "run-1",
          "stop-x",
          { kind: "photo", dataUrl: PHOTO_DATA_URL },
          operatorPayload,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("400s when the image bytes cannot be decoded (sharp rejects)", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({ ...STOP });
      (compressImage as jest.Mock).mockRejectedValueOnce(new Error("unsupported image"));

      await expect(
        service.attachPodArtifact(
          "run-1",
          "stop-1",
          { kind: "photo", dataUrl: PHOTO_DATA_URL },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
    });

    // REG-B121 (pin): a photo can still be attached to a stop that is already
    // COMPLETED — R7's immutability rule is signature-only. Reopen remains the
    // sanctioned path to re-capture a signature; photos stay appendable.
    it("REG-B121 (pin): photos stay appendable on a COMPLETED stop", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        ...STOP,
        status: "COMPLETED",
        signatureUrl: "tenants/test-tenant/pod/stop-1/signature-old-1.jpg",
      });

      const result = await service.attachPodArtifact(
        "run-1",
        "stop-1",
        {
          kind: "photo",
          dataUrl: PHOTO_DATA_URL,
          artifactId: "new-photo-1",
        },
        operatorPayload,
      );

      const key = "tenants/test-tenant/pod/stop-1/photo-new-photo-1.jpg";
      expect(prisma.routeRunStop.update).toHaveBeenCalledWith({
        where: { id: "stop-1" },
        data: { podPhotoUrls: { push: key } },
      });
      expect(result).toEqual({ key, url: `signed:${key}` });
    });

    it("getStopPod presigns stored keys, passes data URLs through, and counts legacy strings", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        ...STOP,
        podPhotoUrls: [
          "tenants/test-tenant/pod/stop-1/photo-a.jpg",
          "data:image/png;base64,AAAA",
          "file:///dead-device-path.jpg",
          // another tenant's key must never be presigned, even if a hostile
          // completion payload smuggled it into the column
          "tenants/other-tenant/pod/stop-1/photo-b.jpg",
        ],
        signatureUrl: "native-captured",
      });

      const pod = await service.getStopPod("run-1", "stop-1", operatorPayload);

      expect(pod.photos).toEqual([
        { url: "signed:tenants/test-tenant/pod/stop-1/photo-a.jpg" },
        { url: "data:image/png;base64,AAAA" },
      ]);
      expect(pod.legacyPhotoCount).toBe(2);
      expect(pod.signatureUrl).toBeNull();
      expect(pod.signatureCaptured).toBe(true);
    });

    it("getStopPod presigns a stored signature key", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        ...STOP,
        signatureUrl: "tenants/test-tenant/pod/stop-1/signature-x.png",
      });

      const pod = await service.getStopPod("run-1", "stop-1", operatorPayload);

      expect(pod.signatureUrl).toBe("signed:tenants/test-tenant/pod/stop-1/signature-x.png");
      expect(pod.signatureCaptured).toBe(true);
      expect(pod.photos).toEqual([]);
    });
  });

  // ─── RF-005: Atomic complete + payment ───────────────────────────────────

  describe("completeWithPayment (RF-005)", () => {
    const IN_PROGRESS_RUN = { ...MOCK_RUN, status: "IN_PROGRESS" as const };

    it("resolves the invoice server-side and records the payment WITHOUT a client invoiceId", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          { id: "ord-1", status: "PENDING", customerId: "cust-1", orderNumber: "SO-1", total: 50 },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });
      invoicesService.recordDeliveryPaymentInTx.mockResolvedValue({
        applied: 50,
        invoiceIds: ["inv-1"],
        paymentIds: ["pay-1"],
      });

      // The regression: mobile sends amount + method only (a client invoiceId was
      // always undefined). The server must still record the payment by resolving
      // the invoice from the delivered order — the old code silently did nothing.
      const response = await service.completeWithPayment(
        "run-1",
        "stop-1",
        { payment: { amount: 50, method: "CASH" } },
        operatorPayload,
      );

      // 5th arg = the orders delivered in THIS completion (empty here — no
      // deliveries were sent — so nothing is reconciled to the delivered basis).
      // 6th arg = the run/stop context B83 turns into the AdvancePayment
      // `reference` token — load-bearing for the settlement cash lookup.
      expect(invoicesService.recordDeliveryPaymentInTx).toHaveBeenCalledWith(
        txMock,
        ["ord-1"],
        50,
        "CASH",
        [],
        { runId: "run-1", stopId: "stop-1" },
      );
      // Additive field: the driver app attaches a best-effort payment photo to
      // paymentIds[0] after the stop completes — must be surfaced on the response.
      expect(response.paymentIds).toEqual(["pay-1"]);
    });

    it("passes only the orders delivered in THIS completion as the reconcile subset", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        // Two orders on the stop; only ord-1 is delivered here (ord-2 was already
        // delivered by the office and carries no delivery line in this payload).
        orders: [
          { id: "ord-1", status: "PENDING", customerId: "cust-1", orderNumber: "SO-1", total: 50 },
          {
            id: "ord-2",
            status: "DELIVERED",
            customerId: "cust-1",
            orderNumber: "SO-2",
            total: 30,
          },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: {
          ...prisma.orderItem,
          findFirst: jest.fn().mockResolvedValue({ orderId: "ord-1" }),
          update: jest.fn().mockResolvedValue({}),
        },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeWithPayment(
        "run-1",
        "stop-1",
        {
          deliveries: [{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 3 }],
          payment: { amount: 50, method: "CASH" },
        },
        operatorPayload,
      );

      // Bill/collect across BOTH non-cancelled orders, but reconcile-to-delivered
      // ONLY ord-1 — ord-2 (not delivered here) must keep its invoice, not be zeroed.
      expect(invoicesService.recordDeliveryPaymentInTx).toHaveBeenCalledWith(
        txMock,
        ["ord-1", "ord-2"],
        50,
        "CASH",
        ["ord-1"],
        { runId: "run-1", stopId: "stop-1" },
      );
    });

    it("should throw BadRequestException for CASH payment with amount=0 (RF-006)", async () => {
      const inProgressRun = { ...MOCK_RUN, status: "IN_PROGRESS" as const };
      prisma.routeRun.findUnique.mockResolvedValue(inProgressRun);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });

      await expect(
        service.completeWithPayment(
          "run-1",
          "stop-1",
          { payment: { invoiceId: "inv-1", amount: 0, method: "CASH" } },
          operatorPayload,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // T-B152d / R7b / REG-B152 — same RF-016 bypass as completeStop, but on the
    // path that JUST collected the cash in the same call.
    it("REG-B152: RF-016 does not auto-complete when cash sits uncollected and no settlementNote is set", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...IN_PROGRESS_RUN, settlementNote: null });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          { id: "ord-1", status: "PENDING", customerId: "cust-1", orderNumber: "SO-1", total: 50 },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 40, method: "CASH" }]);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });
      invoicesService.recordDeliveryPaymentInTx.mockResolvedValue({
        applied: 50,
        invoiceIds: ["inv-1"],
        paymentIds: ["pay-1"],
      });

      await service.completeWithPayment(
        "run-1",
        "stop-1",
        { payment: { amount: 50, method: "CASH" } },
        operatorPayload,
      );

      expect(txMock.routeRun.update).not.toHaveBeenCalled();
    });

    // T-B152d / R7b / REG-B152 — the allowance half of the gate above. Without
    // it, deleting the whole RF-016 auto-complete block from THIS flow would
    // still pass (the driver would silently never get the run closed out).
    it("REG-B152: RF-016 still auto-completes on the paid path once the run is settled", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...IN_PROGRESS_RUN,
        settlementNote: "Cash settled: 50.00",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          { id: "ord-1", status: "PENDING", customerId: "cust-1", orderNumber: "SO-1", total: 50 },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });
      invoicesService.recordDeliveryPaymentInTx.mockResolvedValue({
        applied: 50,
        invoiceIds: ["inv-1"],
        paymentIds: ["pay-1"],
      });

      await service.completeWithPayment(
        "run-1",
        "stop-1",
        { payment: { amount: 50, method: "CASH" } },
        operatorPayload,
      );

      expect(txMock.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({ status: "COMPLETED" }),
        }),
      );
    });

    // T-B148b / R3 / REG-B148 — same create-args gap as completeStop, and the
    // same rule: the persisted productId is the order item's, not the body's.
    it("REG-B148: deliveryMutation.create receives the order item's productId, not the client's", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          { id: "ord-1", status: "PENDING", customerId: "cust-1", orderNumber: "SO-1", total: 50 },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const txMock = {
        ...prisma,
        routeRunStop: {
          ...prisma.routeRunStop,
          findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
          update: jest.fn().mockResolvedValue({}),
        },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: {
          ...prisma.orderItem,
          findFirst: jest.fn().mockResolvedValue({ orderId: "ord-1", productId: "prod-1" }),
          update: jest.fn().mockResolvedValue({}),
        },
        deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });

      await service.completeWithPayment(
        "run-1",
        "stop-1",
        {
          deliveries: [
            {
              orderItemId: "oi-1",
              productId: "prod-from-client",
              type: "DELIVERED",
              quantityDelivered: 3,
            },
          ],
        } as any,
        operatorPayload,
      );

      expect(txMock.deliveryMutation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ productId: "prod-1" }) }),
      );
    });
  });

  // ─── RF-019: Idempotency key deduplication ───────────────────────────────

  describe("completeStop idempotency (RF-019)", () => {
    const IN_PROGRESS_RUN = { ...MOCK_RUN, status: "IN_PROGRESS" as const };

    it("should return cached response for duplicate idempotency key", async () => {
      const cachedStop = { id: "stop-1", status: "COMPLETED" };
      prisma.routeRun.findUnique.mockResolvedValue(IN_PROGRESS_RUN);
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [],
      });

      // Mock $queryRaw to simulate an existing idempotency key in the DB
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        { response: JSON.stringify(cachedStop) },
      ]);

      const result = await service.completeStop(
        "run-1",
        "stop-1",
        { idempotencyKey: "test-key-123" },
        operatorPayload,
      );

      // Should return the cached response, not call tenantTransaction
      expect(result).toEqual(cachedStop);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
  });

  // ─── RF-167: GET /route-runs/my-runs regression check ───────────────────

  describe("findMyRuns (RF-167)", () => {
    it("should return active runs for the authenticated driver", async () => {
      const mockDriver = { id: "drv-1", userId: "user-drv" };
      const mockRuns = [{ ...MOCK_RUN, status: "IN_PROGRESS" as const, stops: [] }];
      prisma.driver.findFirst.mockResolvedValue(mockDriver);
      prisma.routeRun.findMany.mockResolvedValue(mockRuns);

      const result = await service.findMyRuns(driverPayload);
      expect(result.data).toHaveLength(1);
      expect(prisma.routeRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ driverId: "drv-1" }),
        }),
      );
    });

    it("should return empty list when driver profile not found", async () => {
      prisma.driver.findFirst.mockResolvedValue(null);
      const result = await service.findMyRuns(driverPayload);
      expect(result.data).toHaveLength(0);
    });
  });

  // ─── G7 / F05: RUN_LINE_ITEMS_SELECT shared across the run read path ─────

  // T-B49a / R1 / REG-B49 — today the `{ id, productId, product, qty, unitPrice,
  // status }` lineItems select literal is duplicated three times (RUN_STOP_INCLUDE,
  // findOneRun's main query, its unlinked-orders fallback) and none carries
  // subtotal/boxes/pieces/unitsPerBox. No RUN_LINE_ITEMS_SELECT export exists yet,
  // so the imported binding is `undefined` — every assertion below is red until
  // all three sites are collapsed onto one shared, enriched const.
  describe("RUN_LINE_ITEMS_SELECT (G7) — enriched money fields (T-B49a / R1 / REG-B49)", () => {
    it("REG-B49: carries subtotal/boxes/pieces/unitsPerBox alongside the existing fields", () => {
      expect(RUN_LINE_ITEMS_SELECT).toEqual({
        id: true,
        productId: true,
        product: { select: { id: true, name: true, unit: true } },
        qty: true,
        unitPrice: true,
        status: true,
        subtotal: true,
        boxes: true,
        pieces: true,
        unitsPerBox: true,
      });
    });

    // The three identity tests below assert `toBe(RUN_LINE_ITEMS_SELECT)` and
    // never inspect a field, so they would pass against ANY shared object. The
    // `toEqual` test above is the SOLE content oracle for R1 — delete or weaken
    // it and all four tests here go green on a const carrying the wrong fields.
    it("REG-B49: findAllRuns' RUN_STOP_INCLUDE references the exact same select object", async () => {
      prisma.routeRun.findMany.mockResolvedValue([]);
      prisma.routeRun.count.mockResolvedValue(0);

      await service.findAllRuns({} as any, operatorPayload);

      const call = prisma.routeRun.findMany.mock.calls[0][0];
      const actualSelect = call.include.stops.include.orders.select.lineItems.select;
      expect(actualSelect).toBe(RUN_LINE_ITEMS_SELECT);
    });

    it("REG-B49: findOneRun's main query references the exact same select object", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, stops: [] });

      await service.findOneRun("run-1");

      const call = prisma.routeRun.findUnique.mock.calls[0][0];
      const actualSelect = call.include.stops.include.orders.select.lineItems.select;
      expect(actualSelect).toBe(RUN_LINE_ITEMS_SELECT);
    });

    it("REG-B49: findOneRun's unlinked-orders fallback references the exact same select object", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...MOCK_RUN,
        stops: [
          {
            id: "stop-1",
            customerId: "cust-1",
            customer: null,
            customerAddress: { id: "addr-1" },
            routeStop: null,
            orders: [], // no stop has a linked order -> triggers the fallback
            deliveryMutations: [],
          },
        ],
      });
      prisma.order.findMany.mockResolvedValue([]);

      await service.findOneRun("run-1");

      expect(prisma.order.findMany).toHaveBeenCalled();
      const call = prisma.order.findMany.mock.calls[0][0];
      const actualSelect = call.select.lineItems.select;
      expect(actualSelect).toBe(RUN_LINE_ITEMS_SELECT);
    });
  });

  // ─── F05: server-truth run cash collections ──────────────────────────────

  // T-B152a / R5 / REG-B152 — findOneRun exposes zero collected-payment data
  // today (no invoicePayment reads in the file outside reopenStop's tx). The
  // fix folds CONFIRMED CASH/CHECK InvoicePayments (via invoice.order.routeRunId,
  // windowed on paidAt >= startedAt) PLUS AdvancePayments referenced to this run.
  describe("findOneRun — collectedPayments (server cash truth) (T-B152a / R5 / REG-B152)", () => {
    it("REG-B152: folds CONFIRMED CASH/CHECK invoice payments plus RUN-scoped advances into collectedPayments", async () => {
      const startedAt = new Date("2026-08-01T00:00:00.000Z");
      prisma.routeRun.findUnique.mockResolvedValue({ ...MOCK_RUN, startedAt, stops: [] });
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 40, method: "CASH" },
        { amount: 25, method: "CHECK" },
      ]);
      prisma.advancePayment.findMany.mockResolvedValue([
        { amount: 30, method: "CASH", reference: "RUN:run-1:STOP:s2" },
      ]);

      const result: any = await service.findOneRun("run-1");

      // 40 (CASH) + 30 (RUN-scoped advance) = 70; CHECK stays 25; 3 rows folded.
      expect(result.collectedPayments).toEqual({ cashTotal: 70, checkTotal: 25, count: 3 });
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ...CONFIRMED_PAYMENT,
            method: { in: ["CASH", "CHECK"] },
            invoice: expect.objectContaining({
              order: expect.objectContaining({ routeRunId: "run-1" }),
            }),
            paidAt: expect.objectContaining({ gte: startedAt }),
          }),
        }),
      );
      expect(prisma.advancePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ reference: { startsWith: "RUN:run-1" } }),
        }),
      );
    });
  });

  // ─── F05: POST /route-runs/:id/settlement ────────────────────────────────

  // T-B152b / R6 / REG-B152 — new endpoint (never a PATCH :id retrofit). The
  // service method does not exist today, so every call below throws
  // "service.settleRun is not a function" — the plan's own oracle for this row
  // ("Endpoint does not exist — red (method undefined)").
  describe("settleRun (POST :id/settlement) (T-B152b / R6 / REG-B152)", () => {
    const SETTLE_RUN = {
      ...MOCK_RUN,
      status: "IN_PROGRESS" as const,
      settlementNote: null as string | null,
    };

    beforeEach(() => {
      prisma.routeRunStop.findMany.mockResolvedValue([{ status: "COMPLETED" }]);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.routeRun.update.mockImplementation((args: any) =>
        Promise.resolve({ ...SETTLE_RUN, ...args.data }),
      );
    });

    it("REG-B152: counted cash matching the server's expected figure settles at variance 0, no reason required", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(SETTLE_RUN);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 70, method: "CASH" }]);

      const result: any = await (service as any).settleRun(
        "run-1",
        { countedCash: 70 },
        operatorPayload,
      );

      expect(result.variance).toBe(0);
      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({ settlementVariance: 0 }),
        }),
      );
    });

    // The reconciliation basis is the PHYSICAL money the driver carries — cash
    // AND checks. Every other fixture in this block is CASH-only, which a
    // cash-only basis satisfies just as well, so this mixed fixture is the sole
    // oracle on the sum: revert the implementation to `expected.cashTotal` and a
    // driver holding $100 cash + a $150 check is told they are $50 over, refused
    // for want of a variance reason, and — once they invent one — has a phantom
    // overage persisted to `settlementVariance` and badged on the web card.
    it("REG-B152: folds CHECKS into the expected figure — a mixed cash/check run reconciles at variance 0", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(SETTLE_RUN);
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 100, method: "CASH" },
        { amount: 50, method: "CHECK" },
      ]);

      const result: any = await (service as any).settleRun(
        "run-1",
        { countedCash: 150 },
        operatorPayload,
      );

      expect(result.expectedCash).toBe(150);
      expect(result.variance).toBe(0);
      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({
            settlementVariance: 0,
            settlementNote: expect.stringContaining("$150.00"),
          }),
        }),
      );
    });

    it("REG-B152: a mismatch without a varianceReason is refused", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(SETTLE_RUN);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 70, method: "CASH" }]);

      await expect(
        (service as any).settleRun("run-1", { countedCash: 50 }, operatorPayload),
      ).rejects.toThrow(BadRequestException);
    });

    it("REG-B152: a reasoned mismatch settles with the signed variance and the reason in the note", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(SETTLE_RUN);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 70, method: "CASH" }]);

      const result: any = await (service as any).settleRun(
        "run-1",
        { countedCash: 50, varianceReason: "Register short" },
        operatorPayload,
      );

      // 50 - 70 = -20 (sign per mobile computeVariance: counted minus expected).
      expect(result.variance).toBe(-20);
      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            settlementVariance: -20,
            settlementNote: expect.stringContaining("Register short"),
          }),
        }),
      );
    });

    it("REG-B152: a DRIVER who does not own the run is forbidden", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(SETTLE_RUN);
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 70, method: "CASH" }]);
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-999", userId: "user-drv" });

      await expect(
        (service as any).settleRun("run-1", { countedCash: 70 }, driverPayload),
      ).rejects.toThrow(ForbiddenException);
    });

    it("REG-B152: a DRIVER cannot re-settle a run that already carries a settlementNote", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...SETTLE_RUN, settlementNote: "existing" });
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 70, method: "CASH" }]);
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1", userId: "user-drv" });

      await expect(
        (service as any).settleRun("run-1", { countedCash: 70 }, driverPayload),
      ).rejects.toThrow(BadRequestException);
    });

    it("REG-B152: an OPERATOR may overwrite an existing settlementNote", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...SETTLE_RUN, settlementNote: "existing" });
      prisma.invoicePayment.findMany.mockResolvedValue([{ amount: 70, method: "CASH" }]);

      const result: any = await (service as any).settleRun(
        "run-1",
        { countedCash: 70 },
        operatorPayload,
      );

      expect(result.variance).toBe(0);
      // `variance === 0` alone would pass an implementation that refused the
      // overwrite and returned the run untouched — the overwrite itself is the
      // claim, so pin that a replacement note was actually written.
      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ settlementNote: expect.any(String) }),
        }),
      );
    });

    // A run cancelled mid-route still has the driver's cash in the truck, and
    // nothing blocks the cancel itself (R7 gates only COMPLETED). Refusing to
    // settle afterwards would strand that money as unreconcilable — so CANCELLED
    // settles post-hoc, and the web card renders it for every status.
    it("REG-B152: a CANCELLED run still settles post-hoc so its cash is not stranded", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...SETTLE_RUN, status: "CANCELLED" });
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 300, method: "CASH", paidAt: new Date("2026-08-31T12:00:00Z") },
      ]);
      prisma.advancePayment.findMany.mockResolvedValue([]);

      const res = await (service as any).settleRun(
        "run-1",
        { countedCash: 275, varianceReason: "Breakdown — $25 fuel paid from the bag" },
        operatorPayload,
      );

      expect(res.expectedCash).toBe(300);
      expect(res.variance).toBe(-25);
      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ settlementVariance: -25 }),
        }),
      );
    });

    // A SCHEDULED run settles to $0 with no reason required, and the resulting
    // settlementNote would disarm all three R7 gates for every collection the
    // driver makes afterwards — R6 accepts IN_PROGRESS and COMPLETED only.
    it("REG-B152: a run that never started refuses settlement", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...SETTLE_RUN, status: "SCHEDULED" });

      await expect(
        (service as any).settleRun("run-1", { countedCash: 0 }, driverPayload),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.routeRun.update).not.toHaveBeenCalled();
    });
  });

  // ─── F05: reopening a stop invalidates the run's settlement ──────────────

  // Every R7 gate keys on `settlementNote == null`. reopenStop puts a run back
  // in a state where it can collect money again, so a note describing the
  // earlier (smaller) count must not survive the reopen — otherwise the
  // re-collected cash closes the run with no settlement covering it.
  describe("reopenStop — settlement reset (R7 / REG-B152)", () => {
    it("REG-B152: clears settlementNote/settlementVariance when a settled run is reopened", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...MOCK_RUN,
        status: "COMPLETED",
        settlementNote: "Expected: $200.00\nCounted: $200.00",
        settlementVariance: 0,
        stops: [{ id: "stop-1", status: "COMPLETED", orders: [] }],
      });
      prisma.deliveryMutation.findMany.mockResolvedValue([]);
      const txMock = {
        ...prisma,
        deliveryMutation: {
          ...prisma.deliveryMutation,
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        routeRunStop: { ...prisma.routeRunStop, update: jest.fn().mockResolvedValue({}) },
        routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));

      await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(txMock.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({
            status: "IN_PROGRESS",
            settlementNote: null,
            settlementVariance: null,
          }),
        }),
      );
    });
  });
});
