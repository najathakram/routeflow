/**
 * F11 — TP4: pins P1–P8, P13–P15 (test-plan.md "Pins"). GREEN pre-impl AND
 * post-impl. Titles carry NO `REG-` token by design, so the red gate's
 * `--testPathIgnorePatterns pins` excludes this whole file — every row here
 * pins behaviour that is TRUE TODAY, on the pre-F11 tree, and that F11's
 * release-on-terminal-transition change must not disturb. A red pin means the
 * pin was actually a proof and belongs in
 * `routes.service.run-terminal-release.spec.ts` instead — never retitle a red
 * pin to make it pass.
 *
 * Module setup mirrors `routes.service.stop-state-guards.spec.ts:1-141`
 * exactly (F10's house pattern for this service).
 */

import fs from "node:fs";
import path from "node:path";
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
import { FeatureConfigStore } from "../billing/feature-config.store";
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

describe("RoutesService — F11 run cancel/skip pins (no REG- token; excluded from the red gate)", () => {
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

  // ─── P1 (B129) ────────────────────────────────────────────────────────────

  it("pin (B129): a stop completed at the door is marked COMPLETED inside the payment's own transaction — the release predicate can never see it", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
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
        update: jest.fn().mockResolvedValue({}),
        // Not allDone — the RF-016 auto-complete branch stays out of this pin's way.
        findMany: jest.fn().mockResolvedValue([{ id: "stop-1", status: "PENDING" }]),
      },
      routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
      order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
      deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "stop-1", status: "COMPLETED" });
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

    expect(txMock.routeRunStop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "stop-1" },
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    // Same txMock instance passed as the FIRST arg — R1's "by construction"
    // claim, made checkable: the payment write and the stop-completion write
    // commit or roll back together.
    expect(invoicesService.recordDeliveryPaymentInTx).toHaveBeenCalledWith(
      txMock,
      expect.any(Array),
      50,
      "CASH",
      expect.any(Array),
      expect.objectContaining({ runId: "run-1", stopId: "stop-1" }),
    );
  });

  // ─── P2 (B129) ────────────────────────────────────────────────────────────

  it("pin (B129): the SCHEDULED dispatch sweep's where still deep-equals its pinned shape (createRun's sweep is untouched by F11)", async () => {
    prisma.route.findUnique.mockResolvedValue({
      id: "route-1",
      name: "Downtown Route",
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
      route: { id: "route-1", name: "Downtown Route" },
      stops: [{ id: "rrs-1", customerId: "c1" }],
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await service.createRun({ routeId: "route-1", scheduledDate: "2026-09-03" } as any);

    const sweepArgs = (prisma.order.updateMany as jest.Mock).mock.calls[0][0];
    expect(sweepArgs.where).toEqual({
      customerId: "c1",
      status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
      routeRunStopId: null,
      fulfillPath: FulfillPath.ROUTE,
    });
    expect(sweepArgs.data).toEqual({ routeRunId: "run-2", routeRunStopId: "rrs-1" });
  });

  // ─── P3 (B72) ─────────────────────────────────────────────────────────────

  it("pin (B72): an operator CAN restart a cancelled run — CANCELLED is not an absorbing state (T9b twin under the new shape)", async () => {
    // No `route` key at all — the exact F10 T9b fixture shape, kept here so
    // this file fails loudly on its own if F11's tx shape leaks into un-cancel.
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

  // ─── P4 (B211) ────────────────────────────────────────────────────────────

  it("pin (B211): reopening a COMPLETED stop on a COMPLETED run is still allowed — the refusal is SKIPPED-specific", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({
      ...RUN_FIXTURE,
      status: "COMPLETED",
      stops: [
        {
          id: "stop-1",
          status: "COMPLETED",
          orders: [],
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

    const result = await service.reopenStop("run-1", "stop-1", operatorPayload);

    expect(result).toEqual(expect.objectContaining({ success: true }));
    // The default tenantTransaction mock spreads the SAME model mocks as the
    // top-level `prisma` object (prisma-mock.ts:223-229), so asserting on
    // `prisma.routeRun.update` here is asserting on the tx write.
    expect(prisma.routeRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1" },
        data: expect.objectContaining({ status: "IN_PROGRESS", completedAt: null }),
      }),
    );
  });

  // ─── P5 (B129) ────────────────────────────────────────────────────────────

  it("pin (B129): settleRun still accepts a CANCELLED run", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "CANCELLED" });
    prisma.routeRun.update.mockResolvedValue({
      id: "run-1",
      settlementNote: "note",
      settlementVariance: 0,
    });

    const result = await service.settleRun("run-1", { countedCash: 0 } as any, operatorPayload);

    expect(result).toEqual(expect.objectContaining({ variance: 0, countedCash: 0 }));
  });

  // ─── P6 (B129) ────────────────────────────────────────────────────────────

  it("pin (B129): updateStopStatus still refuses a stop change on a CANCELLED run", async () => {
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      status: "PENDING",
    });
    prisma.routeRun.findFirst.mockResolvedValue({ driverId: "drv-1", status: "CANCELLED" });

    await expect(
      service.updateStopStatus("run-1", "stop-1", { status: "SKIPPED" }, operatorPayload),
    ).rejects.toThrow(ConflictException);
    expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
  });

  // ─── P7 (B129) ────────────────────────────────────────────────────────────

  it("pin (B129): a DRIVER cannot CANCEL a run — cancel stays an operator action", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({
      ...RUN_FIXTURE,
      status: "IN_PROGRESS",
      driverId: "drv-1",
    });
    prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

    const err: any = await service
      .updateRunStatus("run-1", { status: "CANCELLED" as any }, driverPayload)
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toEqual(expect.stringContaining("Drivers can only set"));
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  // ─── P8 (B211) ────────────────────────────────────────────────────────────

  it("pin (B211): a COMPLETED transition with a PENDING stop is still refused before any write", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findMany.mockResolvedValue([{ id: "s2", status: "PENDING" }]);

    const err: any = await service
      .updateRunStatus("run-1", { status: "COMPLETED" as any }, operatorPayload)
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toEqual(expect.stringContaining("still pending"));
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  // ─── P13 — re-homed test-plan T6 (R3) ────────────────────────────────────
  // "pre-impl this test PASSES (un-cancel already writes status only)... its
  // value is as a tripwire for the re-sweep" (test-plan.md T6 vacuity note).

  async function assertUncancelWritesStatusOnly(routeFixture: Record<string, unknown> | undefined) {
    const runFixture: any = { ...RUN_FIXTURE, status: "CANCELLED" };
    if (routeFixture !== undefined) runFixture.route = routeFixture;

    prisma.routeRun.findUnique.mockResolvedValue(runFixture);
    prisma.routeRun.update.mockResolvedValue({ id: "run-1", status: "IN_PROGRESS" });
    await service.updateRunStatus("run-1", { status: "IN_PROGRESS" as any }, operatorPayload);
    expect(prisma.routeRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IN_PROGRESS", startedAt: expect.any(Date) }),
      }),
    );

    (prisma.routeRun.update as jest.Mock).mockClear();
    prisma.routeRun.findUnique.mockResolvedValue(runFixture);
    prisma.routeRun.update.mockResolvedValue({ id: "run-1", status: "SCHEDULED" });
    await service.updateRunStatus("run-1", { status: "SCHEDULED" as any }, operatorPayload);
    expect(prisma.routeRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SCHEDULED" }) }),
    );

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  }

  it("pin (B129 / re-homed T6a): un-cancelling a SCHEDULED-kind route writes only the run status — no order write, no transaction", async () => {
    await assertUncancelWritesStatusOnly({ kind: "SCHEDULED" });
  });

  it("pin (B129 / re-homed T6b): un-cancelling an ADHOC-kind route writes only the run status — no kind branching, no re-sweep, no refusal", async () => {
    await assertUncancelWritesStatusOnly({ kind: "ADHOC" });
  });

  it("pin (B129 / re-homed T6c): un-cancelling a run with no route relation at all still writes only the run status", async () => {
    await assertUncancelWritesStatusOnly(undefined);
  });

  // ─── P14 — re-homed test-plan T11 (R6) ───────────────────────────────────
  // "pre-impl this passes (no release exists) — like T6 it is a fence, placed
  // with the proofs because it guards the R6 placement" (test-plan.md T11).

  it("pin (B211 / re-homed T11): a withheld auto-completion (unsettled cash) releases nothing and leaves the run IN_PROGRESS", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "s2",
      routeRunId: "run-1",
      status: "PENDING",
      orders: [{ id: "B", status: "CONFIRMED", customerId: "c2", orderNumber: "SO-B", total: 25 }],
    });
    prisma.driver.findFirst.mockResolvedValue(null);

    const txMock = {
      ...prisma,
      routeRunStop: {
        ...prisma.routeRunStop,
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          { id: "s1", status: "COMPLETED" },
          { id: "s2", status: "COMPLETED" },
          { id: "s3", status: "SKIPPED" },
        ]),
      },
      routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
      order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
      deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
      invoicePayment: {
        ...prisma.invoicePayment,
        findMany: jest.fn().mockResolvedValue([{ amount: 25, method: "CASH" }]),
      },
      advancePayment: {
        ...prisma.advancePayment,
        findMany: jest.fn().mockResolvedValue([]),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "s2", status: "COMPLETED" });

    await service.completeStop("run-1", "s2", {}, operatorPayload);

    // The run stays IN_PROGRESS — no auto-completion is committed.
    expect(txMock.routeRun.update).not.toHaveBeenCalled();
    // The DELIVERED flip for order B is still the ONLY order.updateMany call —
    // no second (release) call rides along with it.
    expect(txMock.order.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "DELIVERED" } }),
    );
  });

  // ─── P15 — the mid-run negative for the RF-016 release (R6) ──────────────
  // P14 covers the withheld-cash branch only; hoisting the release out of the
  // `if (allDone)` block leaves it green except by accident. This is the
  // mid-run path itself: stop 2 of 4 closes while siblings are still PENDING.

  it("pin (B211): completing a stop mid-run releases nothing — the release lives inside the auto-completion branch, not on every stop completion", async () => {
    prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
    prisma.routeRunStop.findFirst.mockResolvedValue({
      id: "s2",
      routeRunId: "run-1",
      status: "PENDING",
      signatureUrl: null,
      orders: [{ id: "B", status: "CONFIRMED", customerId: "c2", orderNumber: "SO-B", total: 25 }],
    });
    prisma.driver.findFirst.mockResolvedValue(null);

    const txMock = {
      ...prisma,
      routeRunStop: {
        ...prisma.routeRunStop,
        update: jest.fn().mockResolvedValue({}),
        // s3 is still PENDING and s4 SKIPPED — the run is NOT done, so no
        // auto-completion and no release may happen. Releasing here would null
        // the pointers of the live run's own remaining work.
        findMany: jest.fn().mockResolvedValue([
          { id: "s1", status: "COMPLETED" },
          { id: "s2", status: "COMPLETED" },
          { id: "s3", status: "PENDING" },
          { id: "s4", status: "SKIPPED" },
        ]),
      },
      routeRun: { ...prisma.routeRun, update: jest.fn().mockResolvedValue({}) },
      order: { ...prisma.order, updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
      deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
      invoicePayment: { ...prisma.invoicePayment, findMany: jest.fn().mockResolvedValue([]) },
      advancePayment: { ...prisma.advancePayment, findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(txMock));
    prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "s2", status: "COMPLETED" });

    await service.completeStop("run-1", "s2", {}, operatorPayload);

    // The run is untouched — RF-016 did not fire.
    expect(txMock.routeRun.update).not.toHaveBeenCalled();
    // Exactly the DELIVERED flip for this stop's own order, nothing else.
    expect(txMock.order.updateMany).toHaveBeenCalledTimes(1);
    expect(txMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "DELIVERED" } }),
    );
  });
});

// ── Cross-file constant pin ────────────────────────────────────────────────
// The D4 repair script cannot import from `apps/api/src` (it is a standalone
// `.mjs` run under `railway run`), so it carries its OWN copy of the reason
// literal. Nothing but this pin stops the two from drifting.
const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");
const REPAIR_SCRIPT = path.join(REPO_ROOT, "scripts", "repair-f11-stranded-orders.mjs");

describe("RoutesService — F11 repair-script parity pins (no REG- token)", () => {
  it("pin (B129): the repair script carries the same RELEASED_CHANGE_REQUEST_REASON literal as the service — the retroactive and forward declines must be indistinguishable in CR history", () => {
    const source = fs.readFileSync(REPAIR_SCRIPT, "utf8");

    // Byte-for-byte, em dash included. An operator greps CR history for this
    // exact string; a retroactive decline that reads differently from a forward
    // one is a decline nobody can attribute.
    expect(source).toContain(RELEASED_CHANGE_REQUEST_REASON);

    // Write 3's shape is pinned too: the service bumps `updatedAt` through
    // Prisma's `@updatedAt`, so the script's raw SQL has to set it explicitly or
    // a declined row keeps a stale mtime.
    expect(source).toContain('"updatedAt" = NOW()');
  });
});
