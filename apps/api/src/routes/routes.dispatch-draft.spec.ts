import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RouteKind, OrderStatus, FulfillPath } from "@prisma/client";
import { RELEASED_CHANGE_REQUEST_REASON, RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { geocodeAddress } from "../common/geocode.util";
import { compressImage } from "../storage/compress.util";
import { createMockPrisma } from "../testing/prisma-mock";
import { mockRouteRefsInTenant } from "../testing/route-refs-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed"),
    mimeType: "image/jpeg",
    ext: "jpg",
  }),
}));

const operatorPayload = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;
const driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" } as any;

const RUN_FIXTURE = {
  id: "run-1",
  driverId: "drv-1",
  status: "SCHEDULED" as const,
  startedAt: null as Date | null,
  settlementNote: null as string | null,
  settlementVariance: null as number | null,
  completedAt: null as Date | null,
};

describe("RoutesService — DRAFT orders never ride a dispatch or complete as delivered (bug id pending)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let gateway: jest.Mocked<
    Pick<
      RouteFlowGateway,
      "emitStopCompleted" | "emitOrderCreated" | "emitOrderStatusChanged" | "emitToDriver"
    >
  >;
  let notifications: jest.Mocked<Pick<NotificationsService, "sendToDriver">>;
  let messaging: { notify: jest.Mock; notifyEvent: jest.Mock };
  let invoicesService: {
    recordDeliveryPaymentInTx: jest.Mock;
    reconcileDeliveredOrdersInTx: jest.Mock;
    reverseRunAdvancesInTx: jest.Mock;
  };
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    mockRouteRefsInTenant(prisma, { a1: "c1", a2: "c2" });

    invoicesService = {
      recordDeliveryPaymentInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
      reconcileDeliveredOrdersInTx: jest.fn().mockResolvedValue(undefined),
      reverseRunAdvancesInTx: jest.fn().mockResolvedValue(0),
    };

    gateway = {
      emitStopCompleted: jest.fn(),
      emitOrderCreated: jest.fn(),
      emitOrderStatusChanged: jest.fn(),
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
        // Feature grants v2 brief C (PR-5): resolves "unset" so every existing test in this
        // file keeps exercising today's (every-kind-allowed) dispatch behavior unchanged.
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  const stopWith = (orders: any[]) => ({
    id: "stop-1",
    routeRunId: "run-1",
    status: "PENDING",
    signatureUrl: null,
    orders,
  });
  const txFor = (over: Record<string, unknown> = {}) => {
    const txMock = {
      ...prisma,
      routeRunStop: {
        ...prisma.routeRunStop,
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
      },
      routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
      order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderItem: {
        ...prisma.orderItem,
        findFirst: jest.fn().mockResolvedValue({ orderId: "ord-1", productId: "p1", qty: 5 }),
        findMany: jest.fn().mockResolvedValue([{ id: "oi-1", orderId: "ord-1", qty: 5 }]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(0),
      ...over,
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
    return txMock;
  };

  // (a) DRAFT dispatch bypass ------------------------------------------------------------------
  it("REPRO (a1): the scheduled-run dispatch sweep never attaches a DRAFT order", async () => {
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "R",
      driverId: null,
      isActive: true,
      kind: RouteKind.SCHEDULED,
      stops: [{ id: "rs-1", stopNumber: 1, customerId: "c1", customerAddressId: "a1" }],
    });
    prisma.routeRun.create.mockResolvedValue({
      id: "run-2",
      routeId: "route-1",
      driverId: null,
      status: "SCHEDULED",
      route: { id: "route-1", name: "R" },
      stops: [{ id: "rrs-1", customerId: "c1" }],
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await service.createRun({ routeId: "route-1", scheduledDate: "2026-09-03" } as any);

    const excluded = (prisma.order.updateMany as jest.Mock).mock.calls[0][0].where.status.notIn;
    expect(excluded).toContain(OrderStatus.DRAFT);
  });

  it("REPRO (a2): completing a stop never flips a DRAFT order to DELIVERED (completeWithPayment)", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        { id: "ord-1", status: "DRAFT", customerId: "c1", orderNumber: "SO-1", total: 50 },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    const tx = txFor();
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });

    await service.completeWithPayment(
      "run-1",
      "stop-1",
      { deliveries: [] } as any,
      operatorPayload,
    );

    const where = tx.order.updateMany.mock.calls[0][0].where;
    expect(where.status.notIn).toContain(OrderStatus.DRAFT);
  });

  it("(a3) a DRAFT order on a completed stop gets NO delivered notification (completeStop and completeWithPayment)", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        { id: "ord-1", status: "DRAFT", customerId: "c1", orderNumber: "SO-1", total: 50 },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    txFor();
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });

    await service.completeStop("run-1", "stop-1", { deliveries: [] } as any, operatorPayload);
    await service.completeWithPayment(
      "run-1",
      "stop-1",
      { deliveries: [] } as any,
      operatorPayload,
    );

    expect(messaging.notifyEvent).not.toHaveBeenCalled();
  });

  it("(a4) completeWithPayment never invoices or pays a DRAFT order: it is excluded from the payment's order set", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        { id: "ord-1", status: "DRAFT", customerId: "c1", orderNumber: "SO-1", total: 50 },
        {
          id: "ord-2",
          status: "OUT_FOR_DELIVERY",
          customerId: "c1",
          orderNumber: "SO-2",
          total: 20,
        },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    txFor();
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });
    invoicesService.recordDeliveryPaymentInTx.mockResolvedValue({
      applied: 20,
      invoiceIds: [],
      paymentIds: [],
    });

    await service.completeWithPayment(
      "run-1",
      "stop-1",
      { payment: { amount: 20, method: "CASH" } } as any,
      operatorPayload,
    );

    expect(invoicesService.recordDeliveryPaymentInTx.mock.calls[0][2]).toEqual(["ord-2"]); // [1] = #2175 queue
  });
});
