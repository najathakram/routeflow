import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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

// Campaign batch F11 — REG-B129 / REG-B211 proofs (red-gate). See
// .claude/pipeline/2026-09-02-F11-run-cancel-skip/{spec,test-plan}.md. Every
// test below must fail on an ASSERTION against the pre-implementation
// (c60fe214) behavior of RoutesService — a run going terminal (CANCELLED or
// COMPLETED) does not yet release the undelivered orders of its non-COMPLETED
// stops, and reopenStop does not yet refuse a released SKIPPED stop.

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

// ─── The stateful in-memory order table (T5, T12, T14 share it) ───────────
// The table knows nothing about F11 — it answers whatever `where` the
// service emits. If the implementation emits a shape `matches` does not
// understand, extend `matches`, never the assertion (test-plan "Oracle
// discipline").

type Row = {
  id: string;
  customerId: string;
  status: string;
  routeRunId: string | null;
  routeRunStopId: string | null;
  fulfillPath: "ROUTE" | "SHIP";
};

// Stop status BY STOP ID, the oracle behind the relation filter
// `routeRunStop: { status: { not: "COMPLETED" } }` (T15's race). A test that
// never touches it leaves every stop "unknown", which the filter passes — a
// stop row the test did not pin has no status to contradict the predicate, so
// the pre-existing table tests are unaffected. Reset per test.
let stopStatus: Record<string, string> = {};

function matches(row: Row, where: any): boolean {
  if (where.id?.in && !where.id.in.includes(row.id)) return false;
  if (where.customerId && row.customerId !== where.customerId) return false;
  if (where.fulfillPath && row.fulfillPath !== where.fulfillPath) return false;
  if ("routeRunStopId" in where) {
    const w = where.routeRunStopId;
    if (w === null && row.routeRunStopId !== null) return false;
    if (w?.in && !w.in.includes(row.routeRunStopId)) return false;
  }
  if (where.routeRunStop?.status) {
    // Prisma semantics: a to-one relation filter requires the relation to
    // EXIST, so an unlinked order never satisfies it.
    if (row.routeRunStopId === null) return false;
    const st = stopStatus[row.routeRunStopId];
    const w = where.routeRunStop.status;
    if (st !== undefined) {
      if ("not" in w && st === w.not) return false;
      if (typeof w === "string" && st !== w) return false;
    }
  }
  if (typeof where.status === "string" && row.status !== where.status) return false;
  if (where.status?.notIn && where.status.notIn.includes(row.status)) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  return true;
}

function applyUpdateMany(table: Row[], where: any, data: any): { count: number } {
  let count = 0;
  for (const row of table) {
    if (matches(row, where)) {
      Object.assign(row, data);
      count++;
    }
  }
  return { count };
}

function wireTable(table: Row[], ...mocks: jest.Mock[]) {
  for (const m of mocks) {
    m.mockImplementation(async ({ where, data }: any) => applyUpdateMany(table, where, data));
  }
}

// The read half of the same oracle. `releaseUndeliveredOrders` reads the row
// set it is about to unlink (so the ChangeRequest decline can be scoped to
// exactly those ids), and that read answers the SAME `where` the write does.
function wireTableReads(table: Row[], ...mocks: jest.Mock[]) {
  for (const m of mocks) {
    m.mockImplementation(async ({ where }: any) =>
      table.filter((row) => matches(row, where)).map((row) => ({ id: row.id })),
    );
  }
}

describe("RoutesService — F11 run-terminal release (REG-B129 / REG-B211)", () => {
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
      | "emitDriverStatusUpdated"
    >
  >;
  let notifications: jest.Mocked<Pick<NotificationsService, "sendToDriver">>;
  let messaging: { notify: jest.Mock; notifyEvent: jest.Mock };
  let invoicesService: { recordDeliveryPaymentInTx: jest.Mock; reverseRunAdvancesInTx: jest.Mock };
  let storage: { upload: jest.Mock; presignedUrl: jest.Mock; delete: jest.Mock };

  // An explicit tx client for tests that must prove a write happened ON THE
  // TX CLIENT, not the top-level proxy (build-plan.md §1 TP1). Each field the
  // helper/RF-016 path touches gets its OWN jest.fn() so it is falsifiable
  // independently of the shared model mocks `prisma` carries.
  function makeTx(over: Partial<Record<string, any>> = {}) {
    return {
      ...prisma,
      routeRun: { ...prisma.routeRun, update: jest.fn() },
      routeRunStop: {
        ...prisma.routeRunStop,
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      order: {
        ...prisma.order,
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // The release reads the rows it is about to unlink; its own fn so a
        // test can prove the read ran ON THE TX and control what it returns.
        findMany: jest.fn().mockResolvedValue([]),
      },
      changeRequest: {
        ...prisma.changeRequest,
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      orderItem: { ...prisma.orderItem, findFirst: jest.fn().mockResolvedValue(null) },
      deliveryMutation: { ...prisma.deliveryMutation, create: jest.fn() },
      invoicePayment: { ...prisma.invoicePayment, findMany: jest.fn().mockResolvedValue([]) },
      advancePayment: { ...prisma.advancePayment, findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(0),
      ...over,
    };
  }

  beforeEach(async () => {
    stopStatus = {};
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
      emitDriverStatusUpdated: jest.fn(),
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

  // ─── R1 / R2 / REG-B129 — the release helper + cancel tx placement ───────

  describe("updateRunStatus — cancel releases non-COMPLETED stops' orders (R1 R2 / REG-B129)", () => {
    it("T1 — REG-B129: cancelling a run releases the undelivered orders of every non-COMPLETED stop inside the status transaction", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      const tx = makeTx();
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "CANCELLED", driver: null });
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }, { id: "s3" }]);
      tx.order.updateMany.mockResolvedValue({ count: 2 });
      tx.order.findMany.mockResolvedValue([{ id: "B" }, { id: "C" }]);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(tx.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
      );
      expect(tx.routeRunStop.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ routeRunId: "run-1", status: { not: "COMPLETED" } }),
        }),
      );
      // Exact deep-equal on where+data — an over-broad release (e.g. scoped by
      // routeRunId alone, which would also strip a DELIVERED order's pointer)
      // fails this even though it "releases something". `routeRunStop.status`
      // re-checks the stop in the same statement (the T15 race) and `id.in`
      // pins the write to the rows the read just returned.
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["B", "C"] },
          routeRunStopId: { in: ["s2", "s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        data: { routeRunId: null, routeRunStopId: null },
      });
      // That read runs on the tx too, under the SAME predicate minus `id`.
      expect(tx.order.findMany).toHaveBeenCalledWith({
        where: {
          routeRunStopId: { in: ["s2", "s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        select: { id: true },
      });
      // The write is on the tx, not beside it.
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it("T2 — REG-B129: the OUT_FOR_DELIVERY → CONFIRMED revert is scoped to the released stops and runs before the unlink", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      const tx = makeTx();
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "CANCELLED", driver: null });
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }, { id: "s3" }]);
      tx.order.findMany.mockResolvedValue([{ id: "B" }, { id: "C" }]);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      expect(tx.order.updateMany).toHaveBeenCalledTimes(2);
      const calls = tx.order.updateMany.mock.calls;
      expect(calls[0][0]).toEqual({
        where: {
          routeRunStopId: { in: ["s2", "s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: "OUT_FOR_DELIVERY",
        },
        data: { status: "CONFIRMED" },
      });
      expect(calls[1][0]).toEqual({
        where: {
          id: { in: ["B", "C"] },
          routeRunStopId: { in: ["s2", "s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        data: { routeRunId: null, routeRunStopId: null },
      });
      expect(tx.order.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        tx.order.updateMany.mock.invocationCallOrder[1],
      );
    });

    it("T3 — REG-B129: a run with no non-COMPLETED stops cancels without any order write", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      const tx = makeTx();
      tx.routeRunStop.findMany.mockResolvedValue([]);
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "CANCELLED", driver: null });
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await expect(
        service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload),
      ).resolves.toBeDefined();

      // Positive first — this is what makes the test red pre-impl: today's
      // bare update is NOT on a tx client.
      expect(tx.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
      );
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it("T4 — REG-B129: the driver status broadcast fires only after the cancel transaction has committed", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      const tx = makeTx();
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }, { id: "s3" }]);
      tx.routeRun.update.mockResolvedValue({
        id: "run-1",
        status: "CANCELLED",
        driver: { id: "drv-1", contactName: "D" },
      });
      const order: string[] = [];
      (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) => {
        const result = await fn(tx);
        order.push("tx-done");
        return result;
      });
      (gateway.emitDriverStatusUpdated as jest.Mock).mockImplementation(() => {
        order.push("emit");
      });

      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      expect(gateway.emitDriverStatusUpdated).toHaveBeenCalledTimes(1);
      expect(gateway.emitDriverStatusUpdated).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ driverId: "drv-1", status: "CANCELLED" }),
      );
      expect(order).toEqual(["tx-done", "emit"]);
    });
  });

  // ─── R3 R1 / REG-B129 (path) — cancel → un-cancel → re-dispatch ──────────

  describe("cancel → un-cancel → re-cancel → re-dispatch, end to end (R3 R1 / REG-B129 path)", () => {
    it("T5 — REG-B129 (path): cancel → operator un-cancel → re-cancel → re-dispatch — the released orders are re-collected by the new run's sweep and the un-cancel re-pins nothing", async () => {
      const table: Row[] = [
        {
          id: "A",
          customerId: "c1",
          status: "DELIVERED",
          routeRunId: "run-1",
          routeRunStopId: "s1",
          fulfillPath: "ROUTE",
        },
        {
          id: "B",
          customerId: "c2",
          status: "CONFIRMED",
          routeRunId: "run-1",
          routeRunStopId: "s2",
          fulfillPath: "ROUTE",
        },
        {
          id: "C",
          customerId: "c3",
          status: "OUT_FOR_DELIVERY",
          routeRunId: "run-1",
          routeRunStopId: "s3",
          fulfillPath: "ROUTE",
        },
        {
          id: "D",
          customerId: "c2",
          status: "CONFIRMED",
          routeRunId: null,
          routeRunStopId: null,
          fulfillPath: "ROUTE",
        },
        {
          id: "E",
          customerId: "c2",
          status: "CONFIRMED",
          routeRunId: "run-9",
          routeRunStopId: "s9",
          fulfillPath: "ROUTE",
        },
      ];
      // The SHARED mock (no explicit txMock) so the sweep's forTenant().order.updateMany
      // and the tx's order.updateMany both hit the same table.
      wireTable(table, prisma.order.updateMany);
      // The release's pre-unlink read answers the same table (no other read
      // path in cancel / un-cancel / createRun calls order.findMany).
      wireTableReads(table, prisma.order.findMany);

      prisma.routeRun.findUnique
        .mockResolvedValueOnce({ ...RUN_FIXTURE, status: "IN_PROGRESS" }) // W1 fetch
        .mockResolvedValueOnce({ ...RUN_FIXTURE, status: "CANCELLED" }); // W2 fetch
      prisma.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }, { id: "s3" }]);
      prisma.routeRun.update
        .mockResolvedValueOnce({ id: "run-1", status: "CANCELLED", driver: null }) // W1
        .mockResolvedValueOnce({ id: "run-1", status: "IN_PROGRESS", driver: null }); // W2

      // W1 — cancel.
      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      expect(table.find((r) => r.id === "B")).toEqual(
        expect.objectContaining({ routeRunId: null, routeRunStopId: null }),
      );
      expect(table.find((r) => r.id === "C")).toEqual(
        expect.objectContaining({ routeRunId: null, routeRunStopId: null, status: "CONFIRMED" }),
      );
      expect(table.find((r) => r.id === "A")).toEqual(
        expect.objectContaining({ routeRunId: "run-1", routeRunStopId: "s1", status: "DELIVERED" }),
      );
      expect(table.find((r) => r.id === "E")).toEqual(
        expect.objectContaining({ routeRunId: "run-9", routeRunStopId: "s9" }),
      );

      const snapshotAfterW1 = JSON.stringify(table);
      const callCountAfterW1 = (prisma.order.updateMany as jest.Mock).mock.calls.length;

      // W2 — operator un-cancels (status-only restore).
      await service.updateRunStatus("run-1", { status: "IN_PROGRESS" } as any, operatorPayload);

      expect(JSON.stringify(table)).toEqual(snapshotAfterW1);
      expect((prisma.order.updateMany as jest.Mock).mock.calls.length).toBe(callCountAfterW1);

      // W3 — the operator cancels again. Un-cancel restored the RUN row, not
      // its order set, and createRun refuses a route that already carries a
      // SCHEDULED/IN_PROGRESS run — so the route cannot be re-dispatched while
      // run-1 is live. Cancelling again is the way forward, and it is inert:
      // the release re-issues its predicate against stops that no longer hold
      // any order.
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      prisma.routeRun.update.mockResolvedValue({
        id: "run-1",
        status: "CANCELLED",
        driver: null,
      });

      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      expect(JSON.stringify(table)).toEqual(snapshotAfterW1);

      // W4 — re-dispatch: createRun's sweep re-collects the released orders.
      // `routeRun.findFirst` returns null because run-1 is CANCELLED — the
      // duplicate-run guard only looks for SCHEDULED/IN_PROGRESS runs.
      prisma.route.findUnique.mockResolvedValue({
        id: "r",
        kind: "SCHEDULED",
        driverId: null,
        depotLat: null,
        depotLng: null,
        depotAddress: null,
        stops: [
          { id: "rs2", stopNumber: 1, customerId: "c2", customerAddressId: "a2" },
          { id: "rs3", stopNumber: 2, customerId: "c3", customerAddressId: "a3" },
        ],
      });
      prisma.routeRun.findFirst.mockResolvedValue(null);
      prisma.routeRun.create.mockResolvedValue({
        id: "run-2",
        driverId: null,
        route: { id: "r", name: "R" },
        scheduledDate: new Date(),
        stops: [
          { id: "n2", customerId: "c2" },
          { id: "n3", customerId: "c3" },
        ],
      });

      await service.createRun(
        { routeId: "r", scheduledDate: "2026-09-03" } as any,
        operatorPayload,
      );

      expect(table.find((r) => r.id === "B")).toEqual(
        expect.objectContaining({ routeRunId: "run-2", routeRunStopId: "n2" }),
      );
      expect(table.find((r) => r.id === "D")).toEqual(
        expect.objectContaining({ routeRunId: "run-2", routeRunStopId: "n2" }),
      );
      expect(table.find((r) => r.id === "C")).toEqual(
        expect.objectContaining({ routeRunId: "run-2", routeRunStopId: "n3" }),
      );
      expect(table.find((r) => r.id === "A")).toEqual(
        expect.objectContaining({ routeRunId: "run-1", routeRunStopId: "s1" }),
      );
      expect(table.find((r) => r.id === "E")).toEqual(
        expect.objectContaining({ routeRunId: "run-9", routeRunStopId: "s9" }),
      );
    });
  });

  // ─── R4 / REG-B129 — findOneRun's legacy fallback ────────────────────────

  describe("findOneRun — no legacy backfill for a terminal run (R4 / REG-B129 / REG-B211)", () => {
    it("T7 — REG-B129: findOneRun does not backfill a cancelled run's stops from the customers' current open orders", async () => {
      const stopFixture = {
        id: "s2",
        stopNumber: 1,
        customerId: "c2",
        orders: [] as any[],
        customer: { id: "c2" },
        customerAddress: null as any,
        routeStop: null as any,
        deliveryMutations: [] as any[],
      };
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "CANCELLED",
        route: { id: "route-1", kind: "SCHEDULED" },
        stops: [stopFixture],
      });
      prisma.customerAddress.findMany.mockResolvedValue([]);

      const result: any = await service.findOneRun("run-1");

      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(result.stops[0].orders).toEqual([]);

      // Control — the SAME shape on a live run still hits the fallback.
      (prisma.order.findMany as jest.Mock).mockClear();
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "IN_PROGRESS",
        route: { id: "route-1", kind: "SCHEDULED" },
        stops: [stopFixture],
      });
      prisma.order.findMany.mockResolvedValue([]);

      await service.findOneRun("run-1");

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ customerId: { in: ["c2"] } }) }),
      );
    });

    it("T7b — REG-B211: findOneRun does not backfill a COMPLETED run's stops either — a run completed with every stop skipped has released its orders the same way", async () => {
      // A driver may complete a route by skipping every stop (the COMPLETED
      // gate accepts all-SKIPPED), and that completion releases every one of
      // those stops' orders — the same "no stop has linked orders" shape as a
      // cancel, on a run that is COMPLETED rather than CANCELLED.
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "COMPLETED",
        route: { id: "route-1", kind: "SCHEDULED" },
        stops: [
          {
            id: "s2",
            stopNumber: 1,
            customerId: "c2",
            status: "SKIPPED",
            orders: [] as any[],
            customer: { id: "c2" },
            customerAddress: null as any,
            routeStop: null as any,
            deliveryMutations: [] as any[],
          },
        ],
      });
      prisma.customerAddress.findMany.mockResolvedValue([]);

      const result: any = await service.findOneRun("run-1");

      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(result.stops[0].orders).toEqual([]);

      // Control — a COMPLETED run whose stops are ALL COMPLETED was never
      // released by F11 (the helper only ever sees non-COMPLETED stop ids), so
      // its empty `orders` arrays are the genuine legacy/seeded shape this
      // fallback exists for (demo-seed writes exactly that) and the backfill
      // must still run.
      (prisma.order.findMany as jest.Mock).mockClear();
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "COMPLETED",
        route: { id: "route-1", kind: "SCHEDULED" },
        stops: [
          {
            id: "s2",
            stopNumber: 1,
            customerId: "c2",
            status: "COMPLETED",
            orders: [] as any[],
            customer: { id: "c2" },
            customerAddress: null as any,
            routeStop: null as any,
            deliveryMutations: [] as any[],
          },
        ],
      });
      prisma.order.findMany.mockResolvedValue([]);

      await service.findOneRun("run-1");

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ customerId: { in: ["c2"] } }) }),
      );
    });
  });

  // ─── R6 / REG-B211 — the COMPLETED half, at all three entry points ───────

  describe("updateRunStatus — PATCH COMPLETED releases SKIPPED stops' orders (R6 / REG-B211)", () => {
    it("T8 — REG-B211: completing a run via PATCH releases the orders of its SKIPPED stops in the same transaction as the status write", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      prisma.routeRunStop.findMany.mockResolvedValue([
        { id: "s1", status: "COMPLETED" },
        { id: "s3", status: "SKIPPED" },
      ]);
      const tx = makeTx();
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "COMPLETED", driver: null });
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s3" }]);
      tx.order.findMany.mockResolvedValue([{ id: "B" }]);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await service.updateRunStatus("run-1", { status: "COMPLETED" } as any, operatorPayload);

      expect(tx.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "COMPLETED", completedAt: expect.any(Date) }),
        }),
      );
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["B"] },
          routeRunStopId: { in: ["s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        data: { routeRunId: null, routeRunStopId: null },
      });
      const calls = tx.order.updateMany.mock.calls;
      expect(calls.every((c: any) => !JSON.stringify(c[0].where).includes('"s1"'))).toBe(true);
    });
  });

  describe("completeStop — RF-016 auto-completion releases SKIPPED stops' orders (R6 / REG-B211)", () => {
    it("T9 — REG-B211: RF-016 auto-completion inside completeStop releases the skipped stops' orders in the same transaction", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "s2",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          { id: "B", status: "CONFIRMED", customerId: "c2", orderNumber: "ORD-B", total: 100 },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const tx = makeTx();
      tx.routeRunStop.findMany.mockResolvedValue([
        { id: "s1", status: "COMPLETED" },
        { id: "s2", status: "COMPLETED" },
        { id: "s3", status: "SKIPPED" },
      ]);
      tx.order.findMany.mockResolvedValue([{ id: "C" }]);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "s2", status: "COMPLETED" });

      await service.completeStop("run-1", "s2", {} as any, operatorPayload);

      // "autoCompleted" has no field on completeStop's response (verified at
      // c60fe214: it returns only the stop row) — the load-bearing proof that
      // the internal flag became true IS the COMPLETED write below, which the
      // real code sets it from directly.
      expect(tx.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
      );
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["C"] },
          routeRunStopId: { in: ["s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        data: { routeRunId: null, routeRunStopId: null },
      });
      // Control — the pre-existing DELIVERED flip still fires, proving the
      // fixture actually completed the stop.
      expect(tx.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "DELIVERED" } }),
      );
    });
  });

  describe("completeWithPayment — RF-016 auto-completion releases SKIPPED stops' orders (R6 / REG-B211)", () => {
    it("T10 — REG-B211: RF-016 in completeWithPayment releases skipped stops' orders — and the just-completed stop is never released", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      prisma.routeRunStop.findFirst.mockResolvedValue({
        id: "s2",
        routeRunId: "run-1",
        status: "PENDING",
        signatureUrl: null,
        orders: [
          { id: "B", status: "CONFIRMED", customerId: "c2", orderNumber: "ORD-B", total: 100 },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue(null);
      const tx = makeTx();
      // Deliberately shows s2 still PENDING to exercise the `id !== stopId`
      // clause — allDone is still true because s.id===stopId short-circuits it.
      tx.routeRunStop.findMany.mockResolvedValue([
        { id: "s2", status: "PENDING" },
        { id: "s3", status: "SKIPPED" },
      ]);
      tx.order.findMany.mockResolvedValue([{ id: "C" }]);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
      prisma.routeRunStop.findUniqueOrThrow.mockResolvedValue({ id: "s2", status: "COMPLETED" });

      await service.completeWithPayment("run-1", "s2", { deliveries: [] } as any, operatorPayload);

      // Exact array — a mutation that drops the `id !== stopId` clause would
      // release ["s2","s3"] instead, which fails this deep-equal.
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["C"] },
          routeRunStopId: { in: ["s3"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        data: { routeRunId: null, routeRunStopId: null },
      });
      expect(tx.routeRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) }),
      );
    });
  });

  // ─── R7 / REG-B211 (path) — reopenStop refuses a released SKIPPED stop ───

  describe("reopenStop refuses a released SKIPPED stop (R7 / REG-B211 path)", () => {
    it("T12 — REG-B211 (path): complete-with-SKIPPED → reopenStop on the released stop is refused before any write", async () => {
      const table: Row[] = [
        {
          id: "B",
          customerId: "c3",
          status: "CONFIRMED",
          routeRunId: "run-1",
          routeRunStopId: "s3",
          fulfillPath: "ROUTE",
        },
      ];
      wireTable(table, prisma.order.updateMany);
      wireTableReads(table, prisma.order.findMany);

      const runState: any = { ...RUN_FIXTURE, status: "IN_PROGRESS" };
      (prisma.routeRun.update as jest.Mock).mockImplementation(async ({ data }: any) => {
        runState.status = data.status ?? runState.status;
        if ("completedAt" in data) runState.completedAt = data.completedAt;
        return { ...runState, driver: null };
      });

      // Realistic post-release shape for reopenStop's own read: once B's
      // pointer is nulled, a live query returns no orders for the stop.
      let stopFixture: any = {
        id: "s3",
        status: "SKIPPED",
        orders: [] as any[],
        signatureUrl: null,
        podPhotoUrls: [],
        ageVerified: false,
        identityVerified: false,
        identityType: null,
        identityVerifiedAt: null,
        driverNote: null,
        completedAt: null,
        safeDropEnabled: false,
      };
      (prisma.routeRun.findUnique as jest.Mock).mockImplementation(async () => ({
        ...runState,
        stops: [stopFixture],
      }));
      prisma.routeRunStop.findMany.mockResolvedValue([
        { id: "s1", status: "COMPLETED" },
        { id: "s3", status: "SKIPPED" },
      ]);

      // W1 — complete the run via PATCH; the SKIPPED stop s3 releases B.
      await service.updateRunStatus("run-1", { status: "COMPLETED" } as any, operatorPayload);
      expect(runState.status).toBe("COMPLETED");
      expect(table[0].routeRunStopId).toBeNull();

      const txCalls = (prisma.tenantTransaction as jest.Mock).mock.calls.length;

      // W2 — reopenStop on the now-released SKIPPED stop is refused before any write.
      const err: any = await service
        .reopenStop("run-1", "s3", operatorPayload)
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/released to dispatch/);
      expect((prisma.tenantTransaction as jest.Mock).mock.calls.length).toBe(txCalls);
      expect(prisma.routeRunStop.update).not.toHaveBeenCalled();
      expect(prisma.deliveryMutation.deleteMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
      expect(runState.status).toBe("COMPLETED");

      // Variant — the pre-fix stranded shape (order still attached, D4 repair
      // not yet run) must ALSO be refused: the predicate is run/stop STATUS,
      // not `orders.length === 0` (that alternative was rejected — spec R7).
      // Its MESSAGE differs, because for that data the orders were never
      // released — telling the operator to "dispatch them on a new run" would
      // send them to a trip builder that cannot see the orders at all.
      stopFixture = { ...stopFixture, orders: [{ id: "B", status: "CONFIRMED", lineItems: [] }] };
      const errVariant: any = await service
        .reopenStop("run-1", "s3", operatorPayload)
        .catch((e: any) => e);
      expect(errVariant).toBeInstanceOf(BadRequestException);
      expect(errVariant.message).toMatch(/still attached to it/);
      expect(errVariant.message).toMatch(/stranded-order repair/);
      expect(errVariant.message).not.toMatch(/released to dispatch/);

      // Variant 2 — a POST-fix stop still holding only DELIVERED / CANCELLED
      // orders. The release deliberately leaves those pinned, so this row does
      // NOT predate the fix and the D4 repair (same status filter) would find
      // nothing to free: it must read the released message, not the repair one.
      stopFixture = {
        ...stopFixture,
        orders: [
          { id: "C", status: "CANCELLED", lineItems: [] },
          { id: "D", status: "DELIVERED", lineItems: [] },
        ],
      };
      const errPinned: any = await service
        .reopenStop("run-1", "s3", operatorPayload)
        .catch((e: any) => e);
      expect(errPinned).toBeInstanceOf(BadRequestException);
      expect(errPinned.message).toMatch(/released to dispatch/);
      expect(errPinned.message).not.toMatch(/stranded-order repair/);

      // W3 control — reopening a COMPLETED stop on a COMPLETED run is
      // unaffected: the refusal is SKIPPED-specific.
      runState.status = "COMPLETED";
      stopFixture = { ...stopFixture, status: "COMPLETED", orders: [] };
      prisma.invoice.findFirst.mockResolvedValue(null);
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.reopenStop("run-1", "s3", operatorPayload);
      expect(runState.status).toBe("IN_PROGRESS");
    });

    it("T13 — REG-B211: the reopen refusal is decided before ownership and before any transaction — a driver on a released stop sees the same refusal", async () => {
      prisma.routeRun.findUnique.mockResolvedValue({
        ...RUN_FIXTURE,
        status: "COMPLETED",
        driverId: "drv-1",
        stops: [
          {
            id: "s3",
            status: "SKIPPED",
            orders: [] as any[],
            signatureUrl: null,
            podPhotoUrls: [],
            ageVerified: false,
            identityVerified: false,
            identityType: null,
            identityVerifiedAt: null,
            driverNote: null,
            completedAt: null,
            safeDropEnabled: false,
          },
        ],
      });
      prisma.driver.findFirst.mockResolvedValue({ id: "drv-1" });

      const err: any = await service.reopenStop("run-1", "s3", driverPayload).catch((e: any) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err).not.toBeInstanceOf(ForbiddenException);
      expect(err.message).toMatch(/released to dispatch/);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
  });

  // ─── R2 §3 / REG-B129 — idempotent second cancel ─────────────────────────

  describe("updateRunStatus — a second CANCELLED PATCH is idempotent (R2 §3 / REG-B129)", () => {
    it("T14 — REG-B129: a second cancel of an already-CANCELLED run is idempotent — no throw, same release predicate re-issued, zero rows matched", async () => {
      const table: Row[] = [
        {
          id: "B",
          customerId: "c2",
          status: "CONFIRMED",
          routeRunId: null,
          routeRunStopId: null,
          fulfillPath: "ROUTE",
        },
      ];
      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "CANCELLED" });
      const tx = makeTx();
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }]);
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "CANCELLED", driver: null });
      wireTable(table, prisma.order.updateMany, tx.order.updateMany);
      wireTableReads(table, prisma.order.findMany, tx.order.findMany);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await expect(
        service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload),
      ).resolves.toBeDefined();

      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: [] },
          routeRunStopId: { in: ["s2"] },
          routeRunStop: { status: { not: "COMPLETED" } },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        data: { routeRunId: null, routeRunStopId: null },
      });
      // Nothing was released, so no ChangeRequest is touched either.
      expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
      // The unlink is the SECOND order.updateMany call (the OUT_FOR_DELIVERY
      // revert runs first) — it re-issues but matches zero rows the second
      // time around, which is what makes two racing cancels converge.
      await expect(tx.order.updateMany.mock.results[1].value).resolves.toEqual({ count: 0 });
      expect(table[0]).toEqual({
        id: "B",
        customerId: "c2",
        status: "CONFIRMED",
        routeRunId: null,
        routeRunStopId: null,
        fulfillPath: "ROUTE",
      });
    });
  });

  // ─── REG-B129 — the read→write race the relation filter closes ───────────

  describe("releaseUndeliveredOrders re-checks the stop's status in every write (REG-B129)", () => {
    it("T27 — REG-B129: a stop completed at the door between the cancel's stop read and its order writes is excluded — that order keeps its run pointers while still-open stops release", async () => {
      const table: Row[] = [
        {
          id: "B",
          customerId: "c2",
          status: "CONFIRMED",
          routeRunId: "run-1",
          routeRunStopId: "s2",
          fulfillPath: "ROUTE",
        },
        {
          id: "C",
          customerId: "c3",
          status: "OUT_FOR_DELIVERY",
          routeRunId: "run-1",
          routeRunStopId: "s3",
          fulfillPath: "ROUTE",
        },
      ];
      stopStatus = { s2: "PENDING", s3: "PENDING" };

      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      const tx = makeTx();
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "CANCELLED", driver: null });
      // The cancel tx's own read still sees BOTH stops as non-COMPLETED — this
      // is the snapshot the driver's commit is about to invalidate.
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }, { id: "s3" }]);

      // The driver's completeWithPayment on s2 commits AFTER that read and
      // BEFORE the order writes: s2 → COMPLETED and its order B →
      // PARTIALLY_DELIVERED with at-door CASH recorded. It never took the run
      // row (s3 is still PENDING, so RF-016 did not fire), so nothing
      // serialises the two transactions and, under READ COMMITTED, the cancel's
      // writes re-evaluate their WHERE against this committed state.
      let driverCommitted = false;
      const driverCommits = () => {
        if (driverCommitted) return;
        driverCommitted = true;
        stopStatus.s2 = "COMPLETED";
        table.find((r) => r.id === "B")!.status = "PARTIALLY_DELIVERED";
      };
      tx.order.updateMany.mockImplementation(async ({ where, data }: any) => {
        driverCommits();
        return applyUpdateMany(table, where, data);
      });
      tx.order.findMany.mockImplementation(async ({ where }: any) => {
        driverCommits();
        return table.filter((row) => matches(row, where)).map((row) => ({ id: row.id }));
      });
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      expect(driverCommitted).toBe(true);

      // (a) BOTH writes carry the stop re-check — not just the unlink. The
      // OUT_FOR_DELIVERY revert would otherwise flip a status on a stop the
      // driver had just closed.
      expect(tx.order.updateMany).toHaveBeenCalledTimes(2);
      for (const [args] of tx.order.updateMany.mock.calls) {
        expect(args.where.routeRunStop).toEqual({ status: { not: "COMPLETED" } });
      }

      // (b) B keeps BOTH pointers and its status. PARTIALLY_DELIVERED is not in
      // the notIn list (a partially-delivered order on a genuinely open stop
      // must still release), so the relation filter is the only thing holding
      // it — and holding it is what keeps its at-door cash inside
      // getRunCashCollections' `invoice.order.routeRunId` join and keeps the
      // order out of the trip builder.
      expect(table.find((r) => r.id === "B")).toEqual({
        id: "B",
        customerId: "c2",
        status: "PARTIALLY_DELIVERED",
        routeRunId: "run-1",
        routeRunStopId: "s2",
        fulfillPath: "ROUTE",
      });
      // The still-PENDING stop's order releases exactly as before — the filter
      // narrows the race, not the feature.
      expect(table.find((r) => r.id === "C")).toEqual({
        id: "C",
        customerId: "c3",
        status: "CONFIRMED",
        routeRunId: null,
        routeRunStopId: null,
        fulfillPath: "ROUTE",
      });
    });
  });

  // ─── REG-B129 — the released orders' PENDING change requests ─────────────

  describe("releaseUndeliveredOrders declines the released orders' PENDING change requests (REG-B129)", () => {
    it("T28 — REG-B129: cancelling a run declines every PENDING ChangeRequest on the orders it actually released, silently, and leaves a non-released order's request open", async () => {
      const table: Row[] = [
        // A sits on the COMPLETED stop s1, so it is never in the release's
        // scope — its buyer is still inside a live delivery.
        {
          id: "A",
          customerId: "c1",
          status: "CONFIRMED",
          routeRunId: "run-1",
          routeRunStopId: "s1",
          fulfillPath: "ROUTE",
        },
        {
          id: "B",
          customerId: "c2",
          status: "CONFIRMED",
          routeRunId: "run-1",
          routeRunStopId: "s2",
          fulfillPath: "ROUTE",
        },
      ];
      stopStatus = { s1: "COMPLETED", s2: "PENDING" };

      // A PENDING request on each. B's must be declined: once B is released it
      // has no run, so the buyer is back in the direct-edit window while the
      // driver of a LATER run could still approve the same request and apply
      // the items a second time.
      const changeRequests = [
        {
          id: "cr-A",
          orderId: "A",
          status: "PENDING",
          resolution: null as string | null,
          resolutionReason: null as string | null,
          resolvedAt: null as Date | null,
        },
        {
          id: "cr-B",
          orderId: "B",
          status: "PENDING",
          resolution: null as string | null,
          resolutionReason: null as string | null,
          resolvedAt: null as Date | null,
        },
      ];

      prisma.routeRun.findUnique.mockResolvedValue({ ...RUN_FIXTURE, status: "IN_PROGRESS" });
      const tx = makeTx();
      tx.routeRun.update.mockResolvedValue({ id: "run-1", status: "CANCELLED", driver: null });
      tx.routeRunStop.findMany.mockResolvedValue([{ id: "s2" }]);
      wireTable(table, tx.order.updateMany);
      wireTableReads(table, tx.order.findMany);
      tx.changeRequest.updateMany.mockImplementation(async ({ where, data }: any) => {
        let count = 0;
        for (const cr of changeRequests) {
          if (where.orderId?.in && !where.orderId.in.includes(cr.orderId)) continue;
          if (where.status && cr.status !== where.status) continue;
          Object.assign(cr, data);
          count++;
        }
        return { count };
      });
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));

      await service.updateRunStatus("run-1", { status: "CANCELLED" } as any, operatorPayload);

      // Scoped to the ids the unlink ACTUALLY released — not to the stop, and
      // not to the whole run.
      expect(tx.changeRequest.updateMany).toHaveBeenCalledTimes(1);
      const crArgs = tx.changeRequest.updateMany.mock.calls[0][0];
      expect(crArgs.where).toEqual({ orderId: { in: ["B"] }, status: "PENDING" });
      expect(crArgs.data).toEqual({
        status: "DECLINED",
        resolution: "DECLINED",
        resolutionReason: RELEASED_CHANGE_REQUEST_REASON,
        resolvedAt: expect.any(Date),
      });
      expect(RELEASED_CHANGE_REQUEST_REASON).toBe("Run cancelled — order released to dispatch");
      // On the tx, so it commits or rolls back with the release itself.
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();

      expect(changeRequests.find((c) => c.id === "cr-B")).toEqual({
        id: "cr-B",
        orderId: "B",
        status: "DECLINED",
        resolution: "DECLINED",
        resolutionReason: RELEASED_CHANGE_REQUEST_REASON,
        resolvedAt: expect.any(Date),
      });
      // A was never released, so its request stays PENDING and untouched.
      expect(changeRequests.find((c) => c.id === "cr-A")).toEqual({
        id: "cr-A",
        orderId: "A",
        status: "PENDING",
        resolution: null,
        resolutionReason: null,
        resolvedAt: null,
      });

      // Silent by ruling: no requester notification of any kind fires from the
      // release (notifyRequester is a follow-up row).
      expect(messaging.notify).not.toHaveBeenCalled();
      expect(messaging.notifyEvent).not.toHaveBeenCalled();
      expect(notifications.sendToDriver).not.toHaveBeenCalled();
    });
  });
});
