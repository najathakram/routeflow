/**
 * SA-842 / B209 / #1402 (tier 1) — deleteRoute / deleteRun key on DELIVERY EVIDENCE, not on run status;
 * SA-842b — IN_PROGRESS -> SCHEDULED is refused once a stop has completed.
 *
 * Service-level specs (R1-R5, the 842b refusal). The transaction is the in-memory double in
 * testing/route-evidence-tx.ts: rows are real objects, `where` clauses are evaluated, every call and
 * every raw lock statement is logged in order. The oracle is the rows the code DECIDES from and the
 * writes it issues, not which mock was touched. Every test here goes red on the wrong value in its
 * comment against master, and the R6 flip of REG-B96 lives beside the
 * original in routes.service.spec.ts. The predicate's own clause inventory is delivery-evidence.spec.ts;
 * the real-Postgres race is delete-route-evidence.db.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
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
  EvidenceDb,
  Row,
  createEvidenceTx,
  emptyEvidenceDb,
  matchesWhere,
  rawIndex,
  writeOps,
} from "../testing/route-evidence-tx";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));
jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn().mockResolvedValue({
    buffer: Buffer.from("compressed"),
    mimeType: "image/jpeg",
    ext: "jpg",
  }),
}));

const CODE = "ROUTE_HAS_DELIVERY_EVIDENCE";
const SIGNATURE = "tenants/test-tenant/pod/rrs-1/signature-x.png";
const operatorPayload = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;

const route = { id: "route-1", name: "Downtown Route", kind: "SCHEDULED", isActive: true };
const run = (status: string, extra: Row = {}): Row => ({
  id: "run-1",
  routeId: "route-1",
  status,
  startedAt: null,
  completedAt: null,
  settlementVariance: null,
  settlementNote: null,
  ...extra,
});
const stop = (id: string, extra: Row = {}): Row => ({
  id,
  routeRunId: "run-1",
  status: "PENDING",
  arrivedAt: null,
  completedAt: null,
  driverNote: null,
  skipReason: null,
  podPhotoUrls: [],
  signatureUrl: null,
  podHistory: null,
  ageVerified: false,
  identityVerified: false,
  identityType: null,
  identityVerifiedAt: null,
  ...extra,
});
const signedStop = (id: string) =>
  stop(id, { status: "COMPLETED", signatureUrl: SIGNATURE, completedAt: new Date() });

describe("REG-B209 deleteRoute / deleteRun key on delivery evidence, not run status (SA-842)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitDriverStatusUpdated: jest.fn() } },
        { provide: NotificationsService, useValue: { sendToDriver: jest.fn() } },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();
    service = module.get(RoutesService);
  });

  /**
   * The transaction sees `db`. The reads master makes OUTSIDE the transaction (deleteRoute's run read,
   * deleteRun's run read and mutation probe) see a snapshot of the SAME rows unless a test replaces it,
   * so a red result is the code's decision, not a mock that was never wired.
   */
  function wire(db: EvidenceDb) {
    const { tx, log } = createEvidenceTx(db);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
    const snapshot = () =>
      db.routeRun.map((r) => ({
        ...r,
        stops: db.routeRunStop.filter((s) => s.routeRunId === r.id).map((s) => ({ id: s.id })),
      }));
    prisma.route.findUnique.mockResolvedValue(route);
    prisma.routeRun.findMany.mockImplementation(async () => snapshot());
    prisma.routeRun.findUnique.mockImplementation(
      async (a: any) => snapshot().find((r) => r.id === a.where.id) ?? null,
    );
    prisma.deliveryMutation.findFirst.mockImplementation(
      async (a: any) => db.deliveryMutation.find((m) => matchesWhere(m, a.where)) ?? null,
    );
    return log;
  }

  async function refusal(p: Promise<unknown>) {
    const err: any = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(expect.objectContaining({ code: CODE }));
    return err;
  }

  it("REG-B209 R1: a CANCELLED run that kept a delivered (signed) stop is refused with the code and nothing is written", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("CANCELLED")],
      routeRunStop: [signedStop("rrs-1"), stop("rrs-2")],
      order: [{ id: "o-1", routeRunId: "run-1", routeRunStopId: "rrs-1" }],
    });
    const log = wire(db);

    // WRONG VALUE TODAY: resolves { success: true } and issues routeRunStop.deleteMany({ id in
    // [rrs-1, rrs-2] }) + route.delete — the cancelled run "recorded nothing" premise is false.
    await refusal(service.deleteRoute("route-1"));

    expect(writeOps(log)).toEqual([]);
    expect(db.routeRunStop.map((s) => s.id)).toEqual(["rrs-1", "rrs-2"]);
    expect(db.routeRunStop[0].signatureUrl).toBe(SIGNATURE);
    expect(db.order[0]).toEqual({ id: "o-1", routeRunId: "run-1", routeRunStopId: "rrs-1" });
  });

  it("REG-B209 R2: a run walked back IN_PROGRESS -> SCHEDULED whose stop holds POD photos (no mutation) is refused, zero writes", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("SCHEDULED", { startedAt: new Date() })],
      routeRunStop: [stop("rrs-1", { podPhotoUrls: ["tenants/test-tenant/pod/rrs-1/p1.jpg"] })],
    });
    const log = wire(db);

    // WRONG VALUE TODAY: resolves and deletes the stop (only IN_PROGRESS / COMPLETED runs are refused).
    await refusal(service.deleteRoute("route-1"));

    expect(writeOps(log)).toEqual([]);
    expect(db.routeRunStop).toHaveLength(1);
  });

  it("REG-B209 R3 (guard): a route with no runs still deletes, with the same write sequence", async () => {
    const db = emptyEvidenceDb({ routeStop: [{ id: "rs-1", routeId: "route-1" }] });
    const log = wire(db);

    await expect(service.deleteRoute("route-1")).resolves.toEqual({ success: true });

    expect(writeOps(log)).toEqual([
      "routeStop.deleteMany",
      "routeCustomer.deleteMany",
      "route.delete",
    ]);
  });

  it("REG-B209 R3 (guard): a CANCELLED run with only bare PENDING stops still deletes, keyed on the ids read in the tx", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("CANCELLED")],
      routeRunStop: [stop("rrs-1"), stop("rrs-2")],
    });
    const log = wire(db);
    // The old pre-tx read is stale and must not steer the delete: a stop the snapshot never saw.
    prisma.routeRun.findMany.mockResolvedValue([{ ...run("CANCELLED"), stops: [{ id: "stale" }] }]);

    await expect(service.deleteRoute("route-1")).resolves.toEqual({ success: true });

    expect(writeOps(log)).toEqual([
      "order.updateMany",
      "deliveryMutation.updateMany",
      "routeRunStop.deleteMany",
      "routeRun.deleteMany",
      "routeStop.deleteMany",
      "routeCustomer.deleteMany",
      "route.delete",
    ]);
    expect(log.find((e) => e.op === "routeRunStop.deleteMany")?.args.where).toEqual({
      id: { in: ["rrs-1", "rrs-2"] },
    });
    expect(log.find((e) => e.op === "routeRun.deleteMany")?.args.where).toEqual({
      id: { in: ["run-1"] },
    });
  });

  it("REG-B209 R3 (lock order): Route -> Orders -> stop rows -> RouteRun, all BEFORE the evidence read and the first write", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("CANCELLED")],
      routeRunStop: [stop("rrs-1")],
    });
    const log = wire(db);

    await service.deleteRoute("route-1");

    const iRoute = rawIndex(log, /FROM "Route" WHERE id = \? FOR UPDATE/);
    const iOrders = rawIndex(log, /FROM "Order"\s/);
    const iStops = rawIndex(
      log,
      /FROM "RouteRunStop" WHERE "routeRunId" = \? ORDER BY id FOR UPDATE/,
    );
    const iRun = rawIndex(log, /FROM "RouteRun" WHERE id = \? FOR UPDATE/);
    const iEvidence = log.findIndex((e) => e.op.endsWith(".findFirst"));
    const iWrite = log.findIndex((e) => /\.(updateMany|deleteMany|delete)$/.test(e.op));
    // WRONG VALUE TODAY: no lock statement at all (every index is -1).
    expect(iRoute).toBeGreaterThanOrEqual(0);
    expect([
      iRoute < iOrders,
      iOrders < iStops,
      iStops < iRun,
      iRun < iEvidence,
      iEvidence < iWrite,
    ]).toEqual([true, true, true, true, true]);
  });

  it("REG-B209 R4: a run that was SCHEDULED at the pre-tx read but had a stop signed before the tx is refused under the lock, S1 intact", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("IN_PROGRESS", { startedAt: new Date() })],
      routeRunStop: [signedStop("rrs-1")],
      order: [{ id: "o-1", routeRunId: "run-1", routeRunStopId: "rrs-1" }],
    });
    const log = wire(db);
    // What the old guard read (:542) before the driver started and completed S1:
    prisma.routeRun.findMany.mockResolvedValue([{ ...run("SCHEDULED"), stops: [{ id: "rrs-1" }] }]);

    // WRONG VALUE TODAY: the pre-tx guard passes on the stale SCHEDULED read, the tx never re-reads,
    // and routeRunStop.deleteMany({ id in [rrs-1] }) destroys the fresh signature.
    await refusal(service.deleteRoute("route-1"));

    expect(writeOps(log)).toEqual([]);
    expect(db.routeRunStop[0].signatureUrl).toBe(SIGNATURE);
    expect(db.order[0].routeRunStopId).toBe("rrs-1");
  });

  it("REG-B209 R5: deleteRun on a CANCELLED run whose stop has a signature and NO DeliveryMutation is refused, zero writes", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("CANCELLED")],
      routeRunStop: [signedStop("rrs-1")],
    });
    const log = wire(db);

    // WRONG VALUE TODAY: the guard (:1369-1377) only looks for a DeliveryMutation, finds none, and
    // the tx deletes the stop and its signature pointer.
    await refusal(service.deleteRun("run-1"));

    expect(writeOps(log)).toEqual([]);
    expect(db.routeRunStop).toHaveLength(1);
    expect(db.routeRun).toHaveLength(1);
  });

  it("REG-B209 R5: deleteRun on a run with a DeliveryMutation still refuses, now 409 + code (was a 400)", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("CANCELLED")],
      routeRunStop: [stop("rrs-1")],
      deliveryMutation: [{ id: "dm-1", routeRunStopId: "rrs-1" }],
    });
    const log = wire(db);

    // WRONG VALUE TODAY: BadRequestException("This run has recorded deliveries; cancel it instead…").
    await refusal(service.deleteRun("run-1"));

    expect(writeOps(log)).toEqual([]);
  });

  it("REG-B209 R5 (guard): deleteRun on a bare SCHEDULED run deletes it, locks Orders -> stop rows -> run and takes no Route lock", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run("SCHEDULED")],
      routeRunStop: [stop("rrs-1")],
    });
    const log = wire(db);

    await expect(service.deleteRun("run-1")).resolves.toEqual({ success: true });

    expect(writeOps(log)).toEqual([
      "order.updateMany",
      "deliveryMutation.updateMany",
      "routeRunStop.deleteMany",
      "routeRun.delete",
    ]);
    const iOrders = rawIndex(log, /FROM "Order"\s/);
    const iStops = rawIndex(
      log,
      /FROM "RouteRunStop" WHERE "routeRunId" = \? ORDER BY id FOR UPDATE/,
    );
    const iRun = rawIndex(log, /FROM "RouteRun" WHERE id = \? FOR UPDATE/);
    // WRONG VALUE TODAY: deleteRun's tx takes no lock at all (#2723 item 3).
    expect(iOrders).toBeGreaterThanOrEqual(0);
    expect(iOrders < iStops && iStops < iRun).toBe(true);
    expect(rawIndex(log, /FROM "Route" /)).toBe(-1);
  });

  it("REG-B209 R5: deleteRun retries a lock conflict (P2034) instead of surfacing a 500", async () => {
    const db = emptyEvidenceDb({ routeRun: [run("SCHEDULED")], routeRunStop: [stop("rrs-1")] });
    wire(db);
    const realImpl = (prisma.tenantTransaction as jest.Mock).getMockImplementation()!;
    let attempts = 0;
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(Object.assign(new Error("write conflict"), { code: "P2034" }));
      }
      return realImpl(fn);
    });

    // WRONG VALUE TODAY: no retry wrapper — the first P2034 propagates.
    await expect(service.deleteRun("run-1")).resolves.toEqual({ success: true });
    expect(attempts).toBe(2);
  });
});

describe("REG-B209b updateRunStatus refuses IN_PROGRESS -> SCHEDULED after a completed stop (SA-842b)", () => {
  let service: RoutesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const RUN = {
    id: "run-1",
    driverId: "drv-1",
    status: "IN_PROGRESS",
    startedAt: new Date("2026-10-20T08:00:00Z"),
    completedAt: null as Date | null,
    settlementNote: null,
    settlementVariance: null,
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitDriverStatusUpdated: jest.fn() } },
        { provide: NotificationsService, useValue: { sendToDriver: jest.fn() } },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: InvoicesService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue("test-key") } },
        { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("unset") },
        },
      ],
    }).compile();
    service = module.get(RoutesService);
  });

  /** The run's stops as the (whatever-shaped) completed-stop read sees them. */
  function stopsAre(...statuses: string[]) {
    const stops = statuses.map((status, i) => ({ id: `rrs-${i}`, routeRunId: "run-1", status }));
    prisma.routeRun.findUnique.mockResolvedValue(RUN);
    prisma.routeRunStop.findFirst.mockImplementation(
      async (a: any) => stops.find((s) => matchesWhere(s, a?.where)) ?? null,
    );
    prisma.routeRunStop.findMany.mockImplementation(async (a: any) =>
      stops.filter((s) => matchesWhere(s, a?.where)),
    );
  }

  it("REG-B209b: a run with a COMPLETED stop cannot go back to SCHEDULED (409), and the run row is not written", async () => {
    stopsAre("COMPLETED", "PENDING");

    // WRONG VALUE TODAY: forbiddenRunTransition("IN_PROGRESS", "SCHEDULED") is null, completedAt is
    // null, so the PATCH resolves and routeRun.update({ data: { status: "SCHEDULED" } }) runs — and a
    // SCHEDULED run is then deletable with its signatures.
    await expect(
      service.updateRunStatus("run-1", { status: "SCHEDULED" as any }, operatorPayload),
    ).rejects.toThrow(ConflictException);
    expect(prisma.routeRun.update).not.toHaveBeenCalled();
  });

  it("REG-B209b (guard): before any stop has completed, IN_PROGRESS -> SCHEDULED stays legal (PENDING / IN_PROGRESS / SKIPPED stops)", async () => {
    stopsAre("PENDING", "IN_PROGRESS", "SKIPPED");
    prisma.routeRun.update.mockResolvedValue({ id: "run-1", status: "SCHEDULED" });

    await service.updateRunStatus("run-1", { status: "SCHEDULED" as any }, operatorPayload);

    expect(prisma.routeRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SCHEDULED" }) }),
    );
  });
});
