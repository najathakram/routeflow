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

describe("RoutesService — reopenStop never revives a cancelled line (bug id pending)", () => {
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
        update: jest.fn().mockResolvedValue({}),
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

  // (c) reopenStop revives cancelled lines -----------------------------------------------------
  it("REPRO (c): reopenStop resets only the NON-cancelled lines — a cancelled line stays cancelled", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({
      ...RUN_FIXTURE,
      status: "IN_PROGRESS",
      stops: [
        {
          id: "stop-1",
          status: "COMPLETED",
          orders: [{ id: "ord-1", status: "DELIVERED" }],
          signatureUrl: null,
          podPhotoUrls: [],
          ageVerified: false,
          identityVerified: false,
          identityType: null,
          identityVerifiedAt: null,
          completedAt: null,
          safeDropEnabled: false,
          driverNote: null,
        },
      ],
    });
    prisma.invoice.findFirst.mockResolvedValue(null);
    prisma.transaction.findMany.mockResolvedValue([]);
    // SA-346: the pre-delete read returns the qualifying row actually deleted, so the line is in
    // the force set and recomputes to 0 (a legacy line with no row is not rewritten).
    const tx = txFor({
      deliveryMutation: {
        ...prisma.deliveryMutation,
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { orderId: "ord-1", orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 5 },
          ])
          .mockResolvedValue([]),
        create: jest.fn(),
      },
    });

    await service.reopenStop("run-1", "stop-1", operatorPayload);

    const call = tx.orderItem.updateMany.mock.calls[0][0];
    expect(call.data).toMatchObject({ status: "PENDING" });
    expect(call.where).toMatchObject({ orderId: "ord-1", status: { not: "CANCELLED" } });
    // F-05 (#2093) + SA-365 R6: this is what carries reopenStop's EXEMPT row — it adds no quantity of
    // any product: the only line writes reset delivery state — status here, deliveredQty via the
    // SA-346 recompute — never qty, and no line is created.
    expect(Object.keys(call.data).sort()).toEqual(["status"]);
    expect(tx.orderItem.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.orderItem.create ?? { mock: { calls: [] } }).toHaveProperty("mock.calls.length", 0);
    // B785/SA-133: deliveredQty is a separate RECOMPUTE write, not part of updateMany's data.
    expect(tx.orderItem.update).toHaveBeenCalledWith({
      where: { id: "oi-1" },
      data: { deliveredQty: 0 },
    });
    for (const [arg] of tx.orderItem.update.mock.calls) {
      expect(Object.keys(arg.data)).toEqual(["deliveredQty"]);
    }
  });
});
