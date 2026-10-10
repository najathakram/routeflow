import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
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

describe("RoutesService — delivery lines must belong to this stop and fit the ordered qty (bug id pending)", () => {
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

  // (b) uncapped deliveredQty ------------------------------------------------------------------
  it("REPRO (b): a delivery line for MORE than the ordered qty is refused before any write (order line qty 5, delivered 12)", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        {
          id: "ord-1",
          status: "OUT_FOR_DELIVERY",
          customerId: "c1",
          orderNumber: "SO-1",
          total: 50,
        },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    const tx = txFor();
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });

    await expect(
      service.completeWithPayment(
        "run-1",
        "stop-1",
        { deliveries: [{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 12 }] } as any,
        operatorPayload,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.deliveryMutation.create).not.toHaveBeenCalled();
  });

  it("REPRO (b2): a delivery line whose item belongs to ANOTHER stop's order is refused", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        {
          id: "ord-1",
          status: "OUT_FOR_DELIVERY",
          customerId: "c1",
          orderNumber: "SO-1",
          total: 50,
        },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    const tx = txFor();
    tx.orderItem.findFirst.mockResolvedValue({ orderId: "ord-OTHER", productId: "p1", qty: 5 });
    tx.orderItem.findMany.mockResolvedValue([{ id: "oi-9", orderId: "ord-OTHER", qty: 5 }]);
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });

    await expect(
      service.completeWithPayment(
        "run-1",
        "stop-1",
        { deliveries: [{ orderItemId: "oi-9", type: "DELIVERED", quantityDelivered: 1 }] } as any,
        operatorPayload,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("a delivery of EXACTLY the ordered qty (and a short one) is accepted", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        {
          id: "ord-1",
          status: "OUT_FOR_DELIVERY",
          customerId: "c1",
          orderNumber: "SO-1",
          total: 50,
        },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    const tx = txFor();
    // SA-345a: the recompute only rewrites a line that HAS rows (a legacy line's column is left
    // alone), so give it the row a real completion leaves behind — this stop's own, hence
    // excluded from delivered-so-far at the fit-check and counted by the recompute.
    tx.deliveryMutation.findMany.mockResolvedValue([
      {
        orderId: "ord-1",
        orderItemId: "oi-1",
        routeRunStopId: "stop-1",
        type: "DELIVERED",
        quantityDelivered: 5,
      },
    ]);
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });

    for (const q of [5, 3]) {
      await service.completeWithPayment(
        "run-1",
        "stop-1",
        { deliveries: [{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: q }] } as any,
        operatorPayload,
      );
    }
    expect(tx.orderItem.update).toHaveBeenCalledTimes(2);
  });

  it("REPRO (b3): completeStop refuses a foreign-order line and an over-qty line too, before any write", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue(
      stopWith([
        {
          id: "ord-1",
          status: "OUT_FOR_DELIVERY",
          customerId: "c1",
          orderNumber: "SO-1",
          total: 50,
        },
      ]),
    );
    prisma.driver.findFirst.mockResolvedValue(null);
    const tx = txFor();
    tx.orderItem.findMany.mockResolvedValue([{ id: "oi-9", orderId: "ord-OTHER", qty: 5 }]);

    await expect(
      service.completeStop(
        "run-1",
        "stop-1",
        { deliveries: [{ orderItemId: "oi-9", type: "DELIVERED", quantityDelivered: 1 }] } as any,
        operatorPayload,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(tx.routeRunStop.updateMany).not.toHaveBeenCalled(); // refused before the FIRST write
    expect(tx.deliveryMutation.create).not.toHaveBeenCalled();
  });

  describe("follow-ups: duplicates, unknown items and named refusals", () => {
    const arrange = (findMany: unknown[]) => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      prisma.routeRunStop.findFirst.mockResolvedValue(
        stopWith([
          {
            id: "ord-1",
            status: "OUT_FOR_DELIVERY",
            customerId: "c1",
            orderNumber: "SO-1",
            total: 50,
          },
        ]),
      );
      prisma.driver.findFirst.mockResolvedValue(null);
      const tx = txFor();
      tx.orderItem.findMany.mockResolvedValue(findMany);
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({
        id: "stop-1",
        status: "COMPLETED",
      });
      return tx;
    };
    const line = (orderItemId: string, quantityDelivered: number) => ({
      orderItemId,
      type: "DELIVERED",
      quantityDelivered,
    });

    it("the same item id in two lines is refused (each would pass the cap alone), naming the item", async () => {
      const tx = arrange([{ id: "oi-1", orderId: "ord-1", qty: 5 }]);

      const err: any = await service
        .completeWithPayment(
          "run-1",
          "stop-1",
          { deliveries: [line("oi-1", 4), line("oi-1", 4)] } as any,
          operatorPayload,
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain("oi-1");
      expect(tx.orderItem.update).not.toHaveBeenCalled();
    });

    it("an item id that does not exist for this tenant is a 404, not a silent skip", async () => {
      const tx = arrange([]); // a foreign tenant's item reads back exactly like a missing one

      const err: any = await service
        .completeWithPayment(
          "run-1",
          "stop-1",
          { deliveries: [line("oi-ghost", 1)] } as any,
          operatorPayload,
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toContain("oi-ghost");
      expect(tx.orderItem.update).not.toHaveBeenCalled();
    });

    it("the foreign-stop and over-qty refusals name the offending item", async () => {
      arrange([
        { id: "oi-a", orderId: "ord-OTHER", qty: 5 },
        { id: "oi-b", orderId: "ord-1", qty: 2, product: { name: "Widget" } },
      ]);
      const foreign: any = await service
        .completeWithPayment(
          "run-1",
          "stop-1",
          { deliveries: [line("oi-a", 1)] } as any,
          operatorPayload,
        )
        .catch((e) => e);
      expect(foreign.message).toContain("oi-a");

      // SA-151: the over-qty refusal is driver-readable now — it names the
      // product, not the raw orderItemId (payment.tsx surfaces this verbatim).
      const over: any = await service
        .completeWithPayment(
          "run-1",
          "stop-1",
          { deliveries: [line("oi-b", 9)] } as any,
          operatorPayload,
        )
        .catch((e) => e);
      expect(over.message).toContain("Widget");
      expect(over.message).toContain("2 left");
    });
  });
});
