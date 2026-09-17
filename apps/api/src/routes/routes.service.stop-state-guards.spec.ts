import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoutesService } from "./routes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MessagingService } from "../messaging/messaging.service";
import { InvoicesService } from "../invoices/invoices.service";
// F03/F05 own the "counts as collected money" predicate — R1's live-money
// reopen guard must pin to THIS shared const rather than a literal
// `status: "PAID"`, same convention as every other confirmed-money read.
import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";
import { StorageService } from "../storage/storage.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { geocodeAddress } from "../common/geocode.util";
import { compressImage } from "../storage/compress.util";
import { createMockPrisma } from "../testing/prisma-mock";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
// Real sharp is exercised by compress.util.spec.ts; here it's mocked so POD
// unit tests need no real image fixtures.
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed"),
    mimeType: "image/jpeg",
    ext: "jpg",
  }),
}));

// Campaign batch F10 — REG-B54/B55/B71/B72/B120/B121. Every test below is a
// RED-GATE proof: written before the fix lands, each must fail on an
// assertion (never a compile/import error) against the CURRENT
// (pre-implementation) behavior of RoutesService. See
// .claude/pipeline/2026-09-01-F10-reopen-stop-state-guards/{spec,test-plan}.md.

const operatorPayload = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;
const driverPayload = { sub: "user-drv", role: "DRIVER", tenantId: "t1" } as any;

const RUN_FIXTURE = {
  id: "run-1",
  driverId: "drv-1",
  status: "SCHEDULED" as const,
  startedAt: null as Date | null,
  settlementNote: null as string | null,
  settlementVariance: null as number | null,
};

// The order carried by reopenStop's stop fixture — status DELIVERED so the
// reversal's order-demotion step (step 4) is exercised.
const REOPEN_ORDER = { id: "order-1", status: "DELIVERED", lineItems: [] as unknown[] };

const REOPEN_STOP_BASE = {
  id: "stop-1",
  status: "COMPLETED" as const,
  orders: [REOPEN_ORDER],
  signatureUrl: null as string | null,
  podPhotoUrls: [] as string[],
  ageVerified: false,
  identityVerified: false,
  identityType: null as string | null,
  identityVerifiedAt: null as Date | null,
  completedAt: null as Date | null,
  safeDropEnabled: false,
  driverNote: null as string | null,
};

const SIG_DATA_URL = "data:image/png;base64,aGk=";
const PHOTO_DATA_URL = "data:image/jpeg;base64,/9j/fake";

describe("RoutesService — F10 stop-state guards (REG-B54/B55/B71/B72/B120/B121)", () => {
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
  let invoicesService: { recordDeliveryPaymentInTx: jest.Mock; reverseRunAdvancesInTx: jest.Mock };
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // R6's archival write targets `tx.auditLog.create`; `createMockPrisma()`
    // carries `auditLog` in its shared model list, so the top-level mock and the
    // default tenantTransaction client are the SAME jest.fn — which is what makes
    // T16's "was NOT the call site" assertion mean something. Never re-attach it
    // by hand here: that would fork the two and the assertion would pass vacuously.

    invoicesService = {
      recordDeliveryPaymentInTx: jest
        .fn()
        .mockResolvedValue({ applied: 0, invoiceIds: [], paymentIds: [] }),
      reverseRunAdvancesInTx: jest.fn().mockResolvedValue(0),
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
        // Feature grants v2 brief C (PR-5): resolves "unset" so every existing test in this
        // file keeps exercising today's (every-kind-allowed) dispatch behavior unchanged.
        {
          provide: FeatureConfigStore,
          useValue: {
            getMode: jest.fn().mockResolvedValue({ value: "unset", source: "REGISTRY_DEFAULT" }),
          },
        },
      ],
    }).compile();

    service = module.get<RoutesService>(RoutesService);
  });

  // ─── R1 / REG-B54 — live-money guard blocks reopen ───────────────────────

  describe("reopenStop — live-money guard (R1 / REG-B54)", () => {
    // T1 and T2 drive the SAME collaborator call, so a plain truthy resolve
    // cannot tell R1's two OR arms apart — either test would stay green with
    // one arm deleted from the guard. This returns the row only when the arm
    // under test is actually present in the `where`, so the confirmed-payment
    // arm (T1) and the PAID/PARTIAL status arm (T2) are separately falsifiable.
    const invoiceHitOnArm = (id: string, matchesArm: (arm: any) => boolean) => async (args: any) =>
      ((args?.where?.OR ?? []) as any[]).some(matchesArm) ? { id } : null;

    beforeEach(() => {
      prisma.transaction.findMany.mockResolvedValue([]); // legacy guard stays clear
    });

    it("T1 — REG-B54: a CONFIRMED InvoicePayment on a stop order blocks the reopen before any reversal", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        stops: [{ ...REOPEN_STOP_BASE }],
      });
      // Hits ONLY on the confirmed-payment arm: drop it from the guard and
      // this test goes red on its own, without T2 or T3 moving.
      (prisma.invoice.findFirst as jest.Mock).mockImplementation(
        invoiceHitOnArm("inv-1", (arm) => Boolean(arm?.payments?.some)),
      );

      const err: any = await service
        .reopenStop("run-1", "stop-1", operatorPayload)
        .catch((e: any) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toEqual(expect.stringContaining("Payment already recorded"));
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("T2 — REG-B54: a PARTIAL invoice blocks the reopen even with no payment rows returned", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        stops: [{ ...REOPEN_STOP_BASE }],
      });
      // A PARTIAL-status hit with no payment rows: the row comes back ONLY if
      // the guard still carries the PAID/PARTIAL status arm. Narrow that arm to
      // PAID (or delete it) and this test goes red while T1 stays green.
      (prisma.invoice.findFirst as jest.Mock).mockImplementation(
        invoiceHitOnArm("inv-2", (arm) =>
          ((arm?.status?.in ?? []) as string[]).includes("PARTIAL"),
        ),
      );

      const err: any = await service
        .reopenStop("run-1", "stop-1", operatorPayload)
        .catch((e: any) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toEqual(expect.stringContaining("Payment already recorded"));
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("T3 — REG-B54: the live-money guard queries invoices by the stop's orderIds with the shared CONFIRMED_PAYMENT predicate — and a clean stop still reopens", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        stops: [{ ...REOPEN_STOP_BASE }],
      });
      prisma.invoice.findFirst.mockResolvedValue(null);

      const result = await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            orderId: { in: ["order-1"] },
            OR: expect.arrayContaining([
              expect.objectContaining({ payments: { some: CONFIRMED_PAYMENT } }),
              expect.objectContaining({
                status: expect.objectContaining({
                  in: expect.arrayContaining(["PAID", "PARTIAL"]),
                }),
              }),
            ]),
          }),
        }),
      );
    });
  });

  // ─── R2 / REG-B55 — reopen writes no stock ───────────────────────────────

  describe("reopenStop — no stock reversal (R2 / REG-B55)", () => {
    beforeEach(() => {
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        stops: [{ ...REOPEN_STOP_BASE }],
      });
      prisma.deliveryMutation.findMany.mockResolvedValue([
        {
          productId: "prod-1",
          quantityDelivered: 5,
          type: "DELIVERED",
          order: { orderNumber: "ORD-1" },
        },
      ]);
    });

    it("T4 — REG-B55: reopen writes no stock movement and never touches currentStock", async () => {
      await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it("T5 — REG-B55: the reversal still deletes mutations and resets items, order and stop — while writing no stock", async () => {
      await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(prisma.deliveryMutation.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { routeRunStopId: "stop-1" } }),
      );
      expect(prisma.orderItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CONFIRMED" }) }),
      );
      expect(prisma.routeRunStop.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "PENDING", signatureUrl: null }),
        }),
      );
      // Red anchor — everything above already passes pre-impl.
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    // T21 — found by the Fable final pass after 5 review lenses, 34 refuters and
    // 6 mutation probes had all passed over it. `completeWithPayment` writes
    // `OrderItem.deliveredQty` per item regardless of whether money changed
    // hands, and `reconcileOrderDraftInvoice(basis:"delivered")` bills
    // `Number(li.deliveredQty ?? 0)`. A reversal that resets `status` but not
    // `deliveredQty` therefore bills the delivery it just undid: complete on
    // account (item A 5, item B 3, $0) → reopen (allowed — the B54 guard sees no
    // confirmed money) → re-deliver only A with payment, and B is invoiced for 3
    // units nobody delivered. Note the coupling: it is precisely the
    // no-confirmed-money case that B54 permits, so B54's own fix is what opens
    // the path to this one.
    it("T21 — REG-B55: the reversal zeroes OrderItem.deliveredQty, so a re-delivery cannot bill the undone delivery", async () => {
      await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(prisma.orderItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderId: "order-1" },
          data: expect.objectContaining({ status: "PENDING", deliveredQty: 0 }),
        }),
      );
    });
  });

  // ─── R3 / REG-B71 — updateStopStatus from-state guards ───────────────────

  describe("updateStopStatus — from-state guards (R3 / REG-B71)", () => {
    it("T6 — REG-B71: a COMPLETED stop cannot be PATCHed to SKIPPED — reopen is the only exit", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
      });
      // The parent run is loaded for EVERY caller before any state verdict
      // (ownership-first ordering, T23), so a stop-state test must supply it —
      // otherwise the run 404s first and this test passes for the wrong reason.
      prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1", status: "IN_PROGRESS" });

      await expect(
        service.updateStopStatus("run-1", "stop-1", { status: "SKIPPED" }, operatorPayload),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
    });

    it("T7 — REG-B71: no stop transition is accepted on a COMPLETED or CANCELLED run", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
      });

      prisma.routeRun.findFirst.mockResolvedValueOnce({ driverId: "drv-1", status: "COMPLETED" });
      await expect(
        service.updateStopStatus("run-1", "stop-1", { status: "IN_PROGRESS" }, operatorPayload),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();

      prisma.routeRun.findFirst.mockResolvedValueOnce({ driverId: "drv-1", status: "CANCELLED" });
      await expect(
        service.updateStopStatus("run-1", "stop-1", { status: "IN_PROGRESS" }, operatorPayload),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
    });

    it("T8 — REG-B71: a normal PATCH still succeeds and now consults the run's status for every caller", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        arrivedAt: null,
      });
      prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1", status: "IN_PROGRESS" });
      prisma.routeRunStop.update.mockResolvedValue({});

      await service.updateStopStatus("run-1", "stop-1", { status: "IN_PROGRESS" }, operatorPayload);

      expect(prisma.routeRunStop.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "stop-1" },
          data: expect.objectContaining({ arrivedAt: expect.any(Date) }),
        }),
      );
      // Red anchor — today the operator path never loads the run at all.
      expect(prisma.routeRun.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "run-1" } }),
      );

      // SKIPPED → IN_PROGRESS stays allowed.
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "SKIPPED",
        arrivedAt: null,
      });
      await service.updateStopStatus("run-1", "stop-1", { status: "IN_PROGRESS" }, operatorPayload);
      expect(prisma.routeRunStop.update).toHaveBeenCalledTimes(2);
    });
  });

  // ─── R4 / REG-B72 — updateRunStatus deny-list matrix ──────────────────────

  describe("updateRunStatus — from-state deny-list (R4 / REG-B72)", () => {
    it("T9 — REG-B72: a CANCELLED run cannot be declared COMPLETED", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "CANCELLED" });

      await expect(
        service.updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRun.update).not.toHaveBeenCalled();
    });

    it("T9b — REG-B72: an operator CAN restart a cancelled run that already recorded deliveries — CANCELLED is not an absorbing state", async () => {
      // The recovery pin. deleteRun refuses any run with a deliveryMutation and
      // reopenStop refuses a cancelled run, so un-cancel is the only path back
      // for the RUN itself. Since F11 the cancel already released the run's
      // undelivered orders (routeRunStopId nulled inside the cancel
      // transaction), so this restore is status-only — it does not re-pin them
      // and does not re-run the release; a fresh dispatch re-collects them.
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "CANCELLED" });
      prisma.routeRun.update.mockResolvedValue({ id: "run-1", status: "IN_PROGRESS" });

      await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, operatorPayload);

      expect(prisma.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1" },
          data: expect.objectContaining({ status: "IN_PROGRESS" }),
        }),
      );
    });

    it("T9c — REG-B72: a driver cannot restart a cancelled run — un-cancelling is the operator's call", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "CANCELLED" });
      // The driver OWNS this run (drv-1 === RUN_FIXTURE.driverId), so the R5
      // ownership check cannot be what throws — only the un-cancel gate can.
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      const err: any = await service
        .updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, driverPayload)
        .catch((e: any) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.message).toEqual(expect.stringContaining("ask your operator to restart it"));
      expect(prisma.routeRun.update).not.toHaveBeenCalled();
    });

    it("T10 — REG-B72: a COMPLETED run cannot be re-SCHEDULED", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "COMPLETED" });

      await expect(
        service.updateRunStatus("run-1", { status: "SCHEDULED" as any }, operatorPayload),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRun.update).not.toHaveBeenCalled();
    });

    it("T11 — REG-B72: the transition matrix is exported from the DTO module and encodes exactly the deny-list", () => {
      const dtoModule = require("./dto/update-run-status.dto");

      // Red anchor — forbiddenRunTransition does not exist pre-impl.
      expect(dtoModule.forbiddenRunTransition).toBeDefined();

      const f = dtoModule.forbiddenRunTransition;
      expect(f("SCHEDULED", "IN_PROGRESS")).toBeNull();
      expect(f("IN_PROGRESS", "COMPLETED")).toBeNull();
      expect(f("SCHEDULED", "CANCELLED")).toBeNull();
      expect(f("IN_PROGRESS", "CANCELLED")).toBeNull();
      expect(f("SCHEDULED", "SCHEDULED")).toBeNull();
      expect(f("IN_PROGRESS", "IN_PROGRESS")).toBeNull();
      expect(f("COMPLETED", "COMPLETED")).toBeNull();
      expect(f("CANCELLED", "CANCELLED")).toBeNull();
      // Documented non-goal: COMPLETED → IN_PROGRESS stays allowed.
      expect(f("COMPLETED", "IN_PROGRESS")).toBeNull();
      // The un-cancel stays legal at the matrix level — it is the only recovery
      // path a cancelled run has (see T9b). Who may use it is updateRunStatus's
      // call, not the matrix's.
      expect(f("CANCELLED", "SCHEDULED")).toBeNull();
      expect(f("CANCELLED", "IN_PROGRESS")).toBeNull();

      expect(typeof f("CANCELLED", "COMPLETED")).toBe("string");
      expect(typeof f("COMPLETED", "SCHEDULED")).toBe("string");
    });

    // T22 — the matrix is EDGE-wise, so verifying every (from,to) pair cannot
    // find a two-step path that composes into a forbidden one. The refuters
    // checked each pair and all passed; the final pass walked the path.
    // COMPLETED→IN_PROGRESS is a documented non-goal (legal) and
    // IN_PROGRESS→SCHEDULED is never denied, so two legal PATCHes re-schedule a
    // completed run — the exact state the matrix's contract says cannot exist.
    // `completedAt` survives the first hop (updateRunStatus only ever SETS it),
    // which is the durable evidence the service guards on.
    it("T22 — REG-B72: a completed run cannot be re-scheduled via the two-step COMPLETED → IN_PROGRESS → SCHEDULED path", async () => {
      // Second hop: the run now reads IN_PROGRESS, so the edge-wise matrix
      // permits it — only the surviving completedAt reveals the composite.
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        completedAt: new Date("2026-08-30T10:00:00Z"),
      });

      await expect(
        service.updateRunStatus("run-1", { status: "SCHEDULED" as any }, operatorPayload),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRun.update).not.toHaveBeenCalled();

      // A run that has never completed still schedules normally — the guard keys
      // on completedAt, not on the status alone.
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        completedAt: null,
      });
      await service.updateRunStatus("run-1", { status: "SCHEDULED" as any }, operatorPayload);
      expect(prisma.routeRun.update).toHaveBeenCalled();
    });
  });

  // ─── R5 / REG-B72 — driver ownership on all three write paths ────────────

  describe("driver ownership (R5 / REG-B72)", () => {
    // T23 — ordering, not just presence. The same diff put ownership BEFORE the
    // state guard in attachPodArtifact and AFTER it in updateRunStatus /
    // updateStopStatus; that internal inconsistency is the tell. Ownership-first
    // is correct: a state guard that fires first tells a driver with no claim on
    // the run whether it is CANCELLED or COMPLETED. Both must answer with the
    // uniform no-access message and read no further state.
    it("T23 — REG-B72: an unassigned driver gets the uniform no-access error and learns nothing about run or stop state", async () => {
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-2" });

      // A CANCELLED run would otherwise answer "This run was cancelled — ask
      // your operator to restart it", disclosing its state.
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "CANCELLED",
        driverId: "drv-1",
      });
      await expect(
        service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, driverPayload),
      ).rejects.toThrow(/do not have access/);

      // A COMPLETED stop on a CANCELLED run would otherwise answer with one of
      // the two Conflict messages.
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        arrivedAt: null,
      });
      prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1", status: "CANCELLED" });
      await expect(
        service.updateStopStatus("run-1", "stop-1", { status: "SKIPPED" }, driverPayload),
      ).rejects.toThrow(/do not have access/);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
    });

    it("T12 — REG-B72: a driver cannot move another driver's run — and an owning driver is verified through the driver table", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "SCHEDULED",
        driverId: "drv-1",
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-2" });

      await expect(
        service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, driverPayload),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.routeRun.update).not.toHaveBeenCalled();

      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });
      prisma.routeRun.update.mockResolvedValue({});

      await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, driverPayload);
      // Red anchor — no driver read exists today for updateRunStatus.
      expect(prisma.driver.findFirst).toHaveBeenCalledWith({
        where: { userId: driverPayload.sub },
      });
    });

    it("T13 — REG-B72: completeStop refuses a driver who is not assigned to the run, before any POD ingest or transaction", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        driverId: "drv-1",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [
          {
            id: "order-1",
            status: "CONFIRMED",
            customerId: "cust-1",
            orderNumber: "ORD-1",
            total: 100,
          },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-2" });

      await expect(
        service.completeStop("run-1", "stop-1", { signatureUrl: SIG_DATA_URL }, driverPayload),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("T14 — REG-B72: completeWithPayment refuses an unassigned driver before the transaction", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        driverId: "drv-1",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        orders: [
          {
            id: "order-1",
            status: "CONFIRMED",
            customerId: "cust-1",
            orderNumber: "ORD-1",
            total: 100,
          },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-2" });

      await expect(
        service.completeWithPayment(
          "run-1",
          "stop-1",
          { payment: { amount: 50, method: "CASH" } },
          driverPayload,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(invoicesService.recordDeliveryPaymentInTx).not.toHaveBeenCalled();
    });
  });

  // ─── R6 / REG-B120 — reopen archives the discarded POD state ─────────────

  describe("reopenStop — POD archival audit row (R6 / REG-B120)", () => {
    beforeEach(() => {
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.deliveryMutation.findMany.mockResolvedValue([]);
    });

    it("T15 — REG-B120: reopen archives the discarded POD state to the audit log inside the same transaction, then resets the stop", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "COMPLETED",
        stops: [
          {
            ...REOPEN_STOP_BASE,
            signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
            podPhotoUrls: ["tenants/t1/pod/stop-1/photo-p1.jpg"],
            ageVerified: true,
            identityType: "DL",
            // Every field carries a NON-default value so the assertion below
            // pins each of R6's ten meta keys individually — a dropped key or a
            // raw Date (unserializable in the JSON column) fails here.
            safeDropEnabled: true,
            driverNote: "Left with the store manager",
            identityVerified: true,
            identityVerifiedAt: new Date("2026-08-20T11:58:30Z"),
            completedAt: new Date("2026-08-20T12:00:00Z"),
          },
        ],
      });

      const txMock = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        deliveryMutation: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        order: { update: jest.fn().mockResolvedValue({}) },
        transaction: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        routeRunStop: { update: jest.fn().mockResolvedValue({}) },
        routeRun: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));

      await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(txMock.auditLog.create).toHaveBeenCalledTimes(1);
      expect(txMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "route_stop.reopened",
            entityType: "RouteRunStop",
            entityId: "stop-1",
            userId: operatorPayload.sub,
            meta: expect.objectContaining({
              runId: "run-1",
              signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
              podPhotoUrls: ["tenants/t1/pod/stop-1/photo-p1.jpg"],
              safeDropEnabled: true,
              driverNote: "Left with the store manager",
              ageVerified: true,
              identityVerified: true,
              identityType: "DL",
              // Both Date columns must be archived as ISO strings, not Dates.
              completedAt: "2026-08-20T12:00:00.000Z",
              identityVerifiedAt: "2026-08-20T11:58:30.000Z",
            }),
          }),
        }),
      );
      expect(txMock.routeRunStop.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "stop-1" },
          data: expect.objectContaining({
            status: "PENDING",
            signatureUrl: null,
            podPhotoUrls: [],
            // The same reset appends the displaced pointers to the stop's own
            // `podHistory` archive — the column F01 added for this write. Without
            // this pin the column stays null forever while schema.prisma claims
            // F10 wires it.
            podHistory: [
              expect.objectContaining({
                // ISO string, not a raw Date — `archivedAt` is what makes the
                // append-only archive ordered and datable in the Json column.
                archivedAt: expect.any(String),
                signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
                podPhotoUrls: ["tenants/t1/pod/stop-1/photo-p1.jpg"],
                reason: "reopen",
              }),
            ],
          }),
        }),
      );
    });

    it("T16 — REG-B120: a SKIPPED stop's reopen still writes the archival row (empty capture) on the tx client", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        stops: [{ ...REOPEN_STOP_BASE, status: "SKIPPED" }],
      });

      const txMock = {
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        deliveryMutation: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        orderItem: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        order: { update: jest.fn().mockResolvedValue({}) },
        transaction: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        routeRunStop: { update: jest.fn().mockResolvedValue({}) },
        routeRun: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));

      await service.reopenStop("run-1", "stop-1", operatorPayload);

      expect(txMock.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            // The null half of R6's conversions — T15 pins the populated one.
            meta: expect.objectContaining({
              signatureUrl: null,
              podPhotoUrls: [],
              safeDropEnabled: false,
              driverNote: null,
              ageVerified: false,
              identityVerified: false,
              identityType: null,
              completedAt: null,
              identityVerifiedAt: null,
            }),
          }),
        }),
      );
      // The archive must be written on the TX client, not the top-level one.
      expect((prisma as any).auditLog.create).not.toHaveBeenCalled();
      // A reopen that displaces no pointers appends NOTHING to the stop's
      // `podHistory` — the reset must leave the column untouched rather than
      // write an empty capture over a prior stop's archive. Delete the
      // `displaced` guard in reopenStop and this assertion goes red.
      expect(txMock.routeRunStop.update).toHaveBeenCalledTimes(1);
      const resetData = txMock.routeRunStop.update.mock.calls[0][0].data;
      expect(Object.prototype.hasOwnProperty.call(resetData, "podHistory")).toBe(false);
    });
  });

  // ─── R7 + R8 / REG-B121 — signature immutability + POD ownership ─────────

  describe("attachPodArtifact — signature immutability + ownership (R7 / R8 / REG-B121)", () => {
    beforeEach(() => {
      (prisma.getTenantId as jest.Mock).mockReturnValue("t1");
    });

    it("T17 — REG-B121: a completed stop's stored signature cannot be replaced by a different artifact", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "COMPLETED" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
        podPhotoUrls: [],
      });

      await expect(
        (service as any).attachPodArtifact(
          "run-1",
          "stop-1",
          { kind: "signature", dataUrl: SIG_DATA_URL, artifactId: "new-9" },
          operatorPayload,
        ),
      ).rejects.toThrow(ConflictException);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("T17b — REG-B121: a completed stop with NO stored signature still accepts one — the documented after-completion capture", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "COMPLETED" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        signatureUrl: null,
        podPhotoUrls: [],
      });

      const key = "tenants/t1/pod/stop-1/signature-new-9.jpg";
      const result = await (service as any).attachPodArtifact(
        "run-1",
        "stop-1",
        { kind: "signature", dataUrl: SIG_DATA_URL, artifactId: "new-9" },
        operatorPayload,
      );

      // The allowed half of R7: the guard turns on a STORED signature, not on
      // COMPLETED alone. Drop its emptiness clause and the offline queue's
      // post-completion signature replay starts 409-ing — this test goes red,
      // T17 stays green.
      expect(storage.upload).toHaveBeenCalledWith(key, expect.any(Buffer), "image/jpeg");
      expect(prisma.routeRunStop.update).toHaveBeenCalledWith({
        where: { id: "stop-1" },
        data: { signatureUrl: key },
      });
      expect(result).toEqual({ key, url: `signed:${key}` });
    });

    it("T18 — REG-B121: the assigned driver's same-artifactId replay still returns the stored artifact — and the driver binding is actually consulted", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "COMPLETED",
        driverId: "drv-1",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
        podPhotoUrls: [],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      const result = await (service as any).attachPodArtifact(
        "run-1",
        "stop-1",
        { kind: "signature", dataUrl: SIG_DATA_URL, artifactId: "old-1" },
        driverPayload,
      );

      expect(result).toEqual({
        key: "tenants/t1/pod/stop-1/signature-old-1.jpg",
        url: "signed:tenants/t1/pod/stop-1/signature-old-1.jpg",
      });
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      // Red anchor — no driver read exists in attachPodArtifact today.
      expect(prisma.driver.findFirst).toHaveBeenCalledWith({
        where: { userId: driverPayload.sub },
      });
    });

    it("T19 — REG-B121: a driver not assigned to the run cannot attach POD at all — nothing is read or written", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        driverId: "drv-1",
      });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        podPhotoUrls: [],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-2" });

      await expect(
        (service as any).attachPodArtifact(
          "run-1",
          "stop-1",
          { kind: "photo", dataUrl: PHOTO_DATA_URL, artifactId: "new-photo-1" },
          driverPayload,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.upload).not.toHaveBeenCalled();
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      expect(storage.presignedUrl).not.toHaveBeenCalled();
    });

    // The write guard above is worthless while the sibling READ endpoint
    // (GET /route-runs/:id/stops/:stopId/pod) hands the same artifacts to any
    // driver in the tenant — RouteRun.driverId is mutable via updateRun, so a
    // reassigned driver would keep presigning the signature/photos forever.
    it("T20 — REG-B121: a driver not assigned to the run cannot READ the stop's POD", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
        podPhotoUrls: ["tenants/t1/pod/stop-1/photo-a.jpg"],
      });
      prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1" });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-2" });

      await expect((service as any).getStopPod("run-1", "stop-1", driverPayload)).rejects.toThrow(
        ForbiddenException,
      );
      expect(storage.presignedUrl).not.toHaveBeenCalled();
    });

    it("T20 (pin) — the assigned driver still reads their own stop's POD", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "stop-1",
        routeRunId: "run-1",
        status: "COMPLETED",
        signatureUrl: "tenants/t1/pod/stop-1/signature-old-1.jpg",
        podPhotoUrls: [],
        driverNote: null,
        completedAt: null,
        ageCheckRequired: false,
        ageVerified: false,
        identityCheckRequired: false,
        identityVerified: false,
        identityType: null,
      });
      prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1" });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      const pod = await (service as any).getStopPod("run-1", "stop-1", driverPayload);

      expect(pod.signatureUrl).toBe("signed:tenants/t1/pod/stop-1/signature-old-1.jpg");
    });
  });
});
