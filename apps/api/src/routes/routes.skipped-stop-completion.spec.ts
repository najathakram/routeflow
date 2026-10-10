// #2409 (tier 1): a SKIPPED stop accepted a replayed offline completion (201). F2 found it while
// proving #2389: the office skipped the stop while the driver's completion sat in the offline
// queue; on reconnect the replay turned the skipped stop into a completed one. Both completion
// paths now refuse a SKIPPED stop with a readable 409 (STOP_SKIPPED) BEFORE the transaction, and
// the atomic claim (claimStopCompletion) only claims PENDING / IN_PROGRESS, so a skip that lands
// between the guard and the write is refused too. The COMPLETED path keeps its exact 400 message
// (mobile's isAlreadyCompletedStopError classifies on it).
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
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
import {
  COMPLETABLE_STOP_STATUSES,
  assertStopNotSkipped,
  claimStopCompletion,
} from "./delivery-lines.util";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn(async (b: Buffer) => b),
}));

const driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" } as any;

describe("assertStopNotSkipped / claimStopCompletion (#2409)", () => {
  it("a SKIPPED stop throws a readable 409 STOP_SKIPPED; every other status passes the guard", () => {
    try {
      assertStopNotSkipped("SKIPPED");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({
        code: "STOP_SKIPPED",
        message: expect.stringMatching(/skipped by dispatch/),
      });
    }
    for (const s of ["PENDING", "IN_PROGRESS", "COMPLETED", null, undefined]) {
      expect(() => assertStopNotSkipped(s as any)).not.toThrow();
    }
  });

  it("the atomic claim only claims PENDING / IN_PROGRESS", async () => {
    const tx = {
      routeRunStop: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
    };
    await claimStopCompletion(tx, "stop-1", { status: "COMPLETED" });
    expect(COMPLETABLE_STOP_STATUSES).toEqual(["PENDING", "IN_PROGRESS"]);
    expect(tx.routeRunStop.updateMany).toHaveBeenCalledWith({
      where: { id: "stop-1", status: { in: ["PENDING", "IN_PROGRESS"] } },
      data: { status: "COMPLETED" },
    });
  });

  it("a skip that lands between the guard and the write: the claim loses and says SKIPPED, not 'already completed'", async () => {
    const tx = {
      routeRunStop: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({ status: "SKIPPED" }),
      },
    };
    await expect(claimStopCompletion(tx, "stop-1", { status: "COMPLETED" })).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STOP_SKIPPED" }),
    });
  });

  it("a concurrent COMPLETE still loses with the existing 409 message", async () => {
    const tx = {
      routeRunStop: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({ status: "COMPLETED" }),
      },
    };
    await expect(claimStopCompletion(tx, "stop-1", { status: "COMPLETED" })).rejects.toThrow(
      "This stop was already completed by another request.",
    );
  });
});

describe("RoutesService: both completion paths refuse a SKIPPED stop before any write (#2409)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitStopCompleted: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitToDriver: jest.fn(),
          },
        },
        { provide: NotificationsService, useValue: { sendToDriver: jest.fn() } },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        {
          provide: InvoicesService,
          useValue: {
            recordDeliveryPaymentInTx: jest.fn(),
            reconcileDeliveredOrdersInTx: jest.fn(),
            reverseRunAdvancesInTx: jest.fn(),
          },
        },
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
    service = module.get<RoutesService>(RoutesService);
    prisma.routeRun.findUnique.mockResolvedValue({
      id: "run-1",
      driverId: "drv-1",
      status: "IN_PROGRESS",
    });
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1", userId: "user-drv" });
  });

  const skipped = { id: "stop-1", status: "SKIPPED", orders: [], signatureUrl: null };

  it.each([
    [
      "completeWithPayment",
      (s: RoutesService) =>
        s.completeWithPayment(
          "run-1",
          "stop-1",
          { deliveries: [], idempotencyKey: "k1" } as any,
          driverPayload,
        ),
    ],
    [
      "completeStop",
      (s: RoutesService) =>
        s.completeStop(
          "run-1",
          "stop-1",
          { deliveries: [], idempotencyKey: "k1" } as any,
          driverPayload,
        ),
    ],
  ])(
    "%s on a SKIPPED stop: 409 STOP_SKIPPED, no transaction, no idempotency hit",
    async (_n, call) => {
      prisma.routeRunStop.findFirst.mockResolvedValue(skipped);
      await expect(call(service)).rejects.toMatchObject({
        response: expect.objectContaining({ code: "STOP_SKIPPED" }),
      });
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    },
  );

  it("a COMPLETED stop still gets the exact 400 'Stop is already completed' (mobile classifies on it)", async () => {
    prisma.routeRunStop.findFirst.mockResolvedValue({ ...skipped, status: "COMPLETED" });
    await expect(
      service.completeWithPayment("run-1", "stop-1", { deliveries: [] } as any, driverPayload),
    ).rejects.toEqual(new BadRequestException("Stop is already completed"));
  });
});
