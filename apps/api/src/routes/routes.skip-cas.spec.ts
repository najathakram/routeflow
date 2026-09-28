// #2415 (tier 1): updateStopStatus checked COMPLETED and then did a plain `update`, so a skip that
// read PENDING just before a completion committed overwrote COMPLETED with SKIPPED — stranding the
// delivery's DeliveryMutation / invoice / payment. The write is now a compare-and-swap
// (claimStopStatusChange). Also: both completion paths now check the stop's STATE only after the
// B72 driver-ownership check, so an unassigned driver can't learn whether a stop is completed.
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { claimStopStatusChange } from "./delivery-lines.util";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressImage: jest.fn() }));

describe("claimStopStatusChange (#2415)", () => {
  const db = (count: number, current?: { status: string } | null) => ({
    routeRunStop: {
      updateMany: jest.fn().mockResolvedValue({ count }),
      findUnique: jest.fn().mockResolvedValue(current ?? null),
    },
  });

  it("writes only onto a row that is still not COMPLETED", async () => {
    const d = db(1);
    await claimStopStatusChange(d, "s1", { status: "SKIPPED" });
    expect(d.routeRunStop.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: { not: "COMPLETED" } },
      data: { status: "SKIPPED" },
    });
  });

  it("loses to a completion that committed in between: 409 STOP_ALREADY_COMPLETED", async () => {
    await expect(
      claimStopStatusChange(db(0, { status: "COMPLETED" }), "s1", { status: "SKIPPED" }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STOP_ALREADY_COMPLETED" }),
    });
  });

  it("a row that vanished is a 404, not a silent no-op", async () => {
    await expect(
      claimStopStatusChange(db(0, null), "s1", { status: "SKIPPED" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("RoutesService (#2415)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const operator = { sub: "op", role: "OPERATOR", tenantId: "t1" } as any;
  const strangerDriver = { sub: "user-other", role: "DRIVER", tenantId: "t1" } as any;

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
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("k") } },
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
    service = module.get(RoutesService);
  });

  it("updateStopStatus: a skip that read PENDING but lost the race to a completion is refused 409, never overwrites", async () => {
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "s1",
      routeRunId: "r1",
      status: "PENDING",
      arrivedAt: null,
    });
    prisma.routeRun.findFirst.mockResolvedValue({ driverId: "d1", status: "IN_PROGRESS" });
    prisma.routeRunStop.updateMany.mockResolvedValue({ count: 0 }); // the completion committed first
    prisma.routeRunStop.findUnique.mockResolvedValue({ status: "COMPLETED" });
    await expect(
      service.updateStopStatus("r1", "s1", { status: "SKIPPED" }, operator),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "STOP_ALREADY_COMPLETED" }),
    });
    expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      "completeWithPayment",
      (s: RoutesService) =>
        s.completeWithPayment("r1", "s1", { deliveries: [] } as any, strangerDriver),
    ],
    [
      "completeStop",
      (s: RoutesService) => s.completeStop("r1", "s1", { deliveries: [] } as any, strangerDriver),
    ],
  ])(
    "%s: an unassigned driver on a COMPLETED stop gets 403, never the state-revealing 400",
    async (_n, call) => {
      prisma.routeRun.findUnique.mockResolvedValue({
        id: "r1",
        driverId: "d1",
        status: "IN_PROGRESS",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "s1",
        status: "COMPLETED",
        orders: [],
        signatureUrl: null,
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "d-other", userId: "user-other" });
      await expect(call(service)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
});
