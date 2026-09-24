import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { RouteRunsController } from "./routes.controller";
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
 * B783/SA-111: completeStop is RETIRED — the bare route (POST .../stops/:stopId/complete)
 * now DELEGATES to completeWithPayment with no payment. This drives the REAL controller
 * method against a REAL RoutesService (mocked Prisma/collaborators), proving the delegation
 * reaches all the way through to the shared code a mocked-service-only test can't see: a
 * `deliveries` body on the bare route actually reaches `reconcileDeliveredOrdersInTx` (via
 * completeWithPayment's unconditional B663 reconcile step) and stamps `OrderItem.deliveredQty`.
 */
describe("RouteRunsController.completeStop — delegator pin (B783/SA-111)", () => {
  let controller: RouteRunsController;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoicesService: {
    recordDeliveryPaymentInTx: jest.Mock;
    reconcileDeliveredOrdersInTx: jest.Mock;
    reverseRunAdvancesInTx: jest.Mock;
  };

  const operatorPayload = {
    sub: "user-op",
    username: "operator",
    role: "OPERATOR" as const,
    status: "ACTIVE" as const,
    forcePasswordChange: false,
    tenantId: "t1",
  } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoicesService = {
      recordDeliveryPaymentInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
      reconcileDeliveredOrdersInTx: jest.fn().mockResolvedValue(undefined),
      reverseRunAdvancesInTx: jest.fn().mockResolvedValue(1),
    };

    // Plain construction, not `controllers: [RouteRunsController]` in the TestingModule: the
    // class carries `@UseGuards(JwtAuthGuard, AddonGuard)`, and Nest eagerly resolves a
    // registered controller's guard providers at compile() time even though nothing here ever
    // activates a guard — RouteRunsController's own constructor takes only RoutesService, so
    // there is nothing DI needs to wire beyond it.
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        {
          provide: MessagingService,
          useValue: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: InvoicesService, useValue: invoicesService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StorageService, useValue: {} },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();

    controller = new RouteRunsController(module.get(RoutesService));
  });

  it(
    "a bare-route body WITH deliveries reaches reconcileDeliveredOrdersInTx and stamps " +
      "OrderItem.deliveredQty",
    async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        id: "run-1",
        driverId: null,
        status: "IN_PROGRESS",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          {
            id: "ord-1",
            status: "OUT_FOR_DELIVERY",
            customerId: "cust-1",
            orderNumber: "SO-1",
            total: 40,
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
        routeRun: { ...prisma.routeRun, update: jest.fn() },
        order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        orderItem: {
          ...prisma.orderItem,
          findMany: jest.fn().mockResolvedValue([{ id: "oi-1", orderId: "ord-1", qty: 10 }]),
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

      const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      // The bare, retired route — never completeWithPayment directly.
      await controller.completeStop(
        "run-1",
        "stop-1",
        { deliveries: [{ orderItemId: "oi-1", type: "DELIVERED", quantityDelivered: 5 }] } as any,
        undefined,
        operatorPayload,
      );

      // Reached OrderItem.deliveredQty — proves the delegation ran completeWithPayment's real
      // step 2, not some stub.
      expect(txMock.orderItem.update).toHaveBeenCalledWith({
        where: { id: "oi-1" },
        data: { deliveredQty: 5 },
      });
      // Reached the B663 unconditional reconcile step — completeWithPayment's own job, never
      // completeStop's (which never called this at all).
      expect(invoicesService.reconcileDeliveredOrdersInTx).toHaveBeenCalledWith(
        txMock,
        ["ord-1"],
        ["ord-1"],
      );
      // The owner's gauge for any external caller still hitting the retired URL.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("run-1"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stop-1"));

      warnSpy.mockRestore();
    },
  );
});
