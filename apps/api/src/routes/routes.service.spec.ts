import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { RouteKind, OrderStatus, FulfillPath } from "@prisma/client";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: NotificationsService, useValue: notifications },
        { provide: MessagingService, useValue: messaging },
        { provide: InvoicesService, useValue: invoicesService },
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
  });

  describe("createRoute", () => {
    it("should create a route with just a name", async () => {
      prisma.route.create.mockResolvedValue(MOCK_ROUTE);
      const result = await service.createRoute({ name: "Downtown Route" });
      expect(prisma.route.create).toHaveBeenCalledWith({ data: { name: "Downtown Route" } });
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

      await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, driverPayload);
      expect(prisma.routeRun.update).toHaveBeenCalled();
    });

    it("should forbid drivers from setting CANCELLED", async () => {
      prisma.routeRun.findUnique.mockResolvedValue(MOCK_RUN);

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
      expect(invoicesService.recordDeliveryPaymentInTx).toHaveBeenCalledWith(
        txMock,
        ["ord-1"],
        50,
        "CASH",
        [],
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
});
