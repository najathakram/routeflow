/**
 * SA-842 / B209 / #1402 — the delivery-evidence predicate, the delete-strength lock helper and the
 * IN_PROGRESS -> SCHEDULED rule (SA-842b), without Nest or a database.
 *
 * The transaction is the in-memory double in testing/route-evidence-tx.ts, which EVALUATES the `where`
 * the predicate sends, so each case below is a decision from rows (does this row make the route
 * undeletable?), not a call-shape check. The Prisma where syntax itself (`isEmpty`, `Prisma.AnyNull`,
 * the relation filter) is proved on a real Postgres by delete-route-evidence.db.spec.ts.
 *
 * Inventory source: .claude/sa SA-842 section 2a. A new evidence column is ONE clause in the helper and
 * ONE row in the first table here.
 */
import { ConflictException } from "@nestjs/common";
import {
  deliveryEvidenceRefusal,
  lockRunsForDelete,
  routeHasDeliveryEvidence,
} from "./delivery-evidence";
import { forbiddenRunTransition } from "./dto/update-run-status.dto";
import { EvidenceDb, Row, createEvidenceTx, emptyEvidenceDb } from "../testing/route-evidence-tx";

const run = (extra: Row = {}): Row => ({
  id: "run-1",
  routeId: "route-1",
  status: "SCHEDULED",
  startedAt: null,
  completedAt: null,
  notes: null,
  manuallyReordered: false,
  settlementVariance: null,
  settlementNote: null,
  ...extra,
});
const stop = (id = "rrs-1", extra: Row = {}): Row => ({
  id,
  routeRunId: "run-1",
  status: "PENDING",
  arrivedAt: null,
  completedAt: null,
  notes: null,
  driverNote: null,
  skipReason: null,
  podPhotoUrls: [],
  signatureUrl: null,
  podHistory: null,
  safeDropEnabled: false,
  ageCheckRequired: false,
  identityCheckRequired: false,
  ageVerified: false,
  identityVerified: false,
  identityType: null,
  identityVerifiedAt: null,
  ...extra,
});

const has = (db: EvidenceDb, opts?: { runId?: string }) =>
  routeHasDeliveryEvidence(createEvidenceTx(db).tx, "route-1", opts);
const withRun = (runExtra: Row): EvidenceDb =>
  emptyEvidenceDb({ routeRun: [run(runExtra)], routeRunStop: [stop()] });
const withStop = (stopExtra: Row): EvidenceDb =>
  emptyEvidenceDb({ routeRun: [run()], routeRunStop: [stop("rrs-1", stopExtra)] });
const withRow = (table: keyof EvidenceDb, row: Row): EvidenceDb => {
  const db = emptyEvidenceDb({ routeRun: [run()], routeRunStop: [stop()] });
  db[table].push(row);
  return db;
};

describe("REG-B209 routeHasDeliveryEvidence — what makes a route undeletable (SA-842 §2a)", () => {
  // WRONG VALUE TODAY for every row: there is no predicate; deleteRoute refuses only IN_PROGRESS /
  // COMPLETED runs, so each of these routes (but the two live-status rows) is deleted.
  it.each<[string, EvidenceDb]>([
    ["a run IN_PROGRESS", withRun({ status: "IN_PROGRESS" })],
    ["a run COMPLETED", withRun({ status: "COMPLETED" })],
    [
      "a CANCELLED run that completed once (completedAt)",
      withRun({ status: "CANCELLED", completedAt: new Date() }),
    ],
    ["a run settlementVariance", withRun({ settlementVariance: "-2.50" })],
    ["a run settlementNote", withRun({ settlementNote: "short 2.50" })],
    ["a stop IN_PROGRESS (driver arrived)", withStop({ status: "IN_PROGRESS" })],
    ["a stop COMPLETED", withStop({ status: "COMPLETED" })],
    ["a stop SKIPPED", withStop({ status: "SKIPPED" })],
    ["a stop arrivedAt", withStop({ arrivedAt: new Date() })],
    ["a stop completedAt", withStop({ completedAt: new Date() })],
    ["a stop podPhotoUrls", withStop({ podPhotoUrls: ["tenants/t/pod/rrs-1/p.jpg"] })],
    ["a stop signatureUrl", withStop({ signatureUrl: "tenants/t/pod/rrs-1/s.png" })],
    ["a stop podHistory (B120 archive)", withStop({ podHistory: [{ archivedAt: "2026-10-01" }] })],
    ["a stop driverNote", withStop({ driverNote: "left at back door" })],
    ["a stop skipReason", withStop({ skipReason: "closed" })],
    ["a stop ageVerified", withStop({ ageVerified: true })],
    ["a stop identityVerified", withStop({ identityVerified: true })],
    ["a stop identityType", withStop({ identityType: "DRIVERS_LICENSE" })],
    ["a stop identityVerifiedAt", withStop({ identityVerifiedAt: new Date() })],
    [
      "a DeliveryMutation on the stop",
      withRow("deliveryMutation", { id: "x", routeRunStopId: "rrs-1" }),
    ],
    ["a DeliveryBatch on the stop", withRow("deliveryBatch", { id: "x", routeRunStopId: "rrs-1" })],
    ["a ChangeRequest on the stop", withRow("changeRequest", { id: "x", routeRunStopId: "rrs-1" })],
    [
      "a Return captured at the stop (no FK)",
      withRow("return", { id: "x", routeRunStopId: "rrs-1" }),
    ],
    [
      "delivered qty on an order pinned to the run",
      withRow("orderItem", {
        id: "oi",
        deliveredQty: 2,
        order: { routeRunId: "run-1", routeRunStopId: null },
      }),
    ],
    [
      "delivered qty on an order pinned to the stop",
      withRow("orderItem", {
        id: "oi",
        deliveredQty: 1,
        order: { routeRunId: null, routeRunStopId: "rrs-1" },
      }),
    ],
    [
      "door cash (AdvancePayment RUN:<run>:)",
      withRow("advancePayment", { id: "a", reference: "RUN:run-1:STOP:rrs-1" }),
    ],
    [
      "door cash reversed (…:REVERSED still counts)",
      withRow("advancePayment", { id: "a", reference: "RUN:run-1:STOP:rrs-1:REVERSED" }),
    ],
  ])("REG-B209 %s is evidence", async (_name, db) => {
    await expect(has(db)).resolves.toBe(true);
  });

  // Each would strand an empty route if counted (SA-842 "Deliberately NOT evidence").
  it.each<[string, EvidenceDb]>([
    ["no runs at all", emptyEvidenceDb()],
    [
      "a SCHEDULED run with startedAt, notes and manuallyReordered",
      withRun({ startedAt: new Date(), notes: "load early", manuallyReordered: true }),
    ],
    [
      "dispatch-time stop flags (notes, safeDrop, ageCheckRequired, identityCheckRequired)",
      withStop({
        notes: "gate code 12",
        safeDropEnabled: true,
        ageCheckRequired: true,
        identityCheckRequired: true,
      }),
    ],
    [
      "a zero delivered qty on the run's order",
      withRow("orderItem", {
        id: "oi",
        deliveredQty: 0,
        order: { routeRunId: "run-1", routeRunStopId: null },
      }),
    ],
    [
      "delivered qty on ANOTHER run's order",
      withRow("orderItem", {
        id: "oi",
        deliveredQty: 3,
        order: { routeRunId: "run-9", routeRunStopId: "rrs-9" },
      }),
    ],
    [
      "an AdvancePayment of another run (RUN:run-2:)",
      withRow("advancePayment", { id: "a", reference: "RUN:run-2:STOP:x" }),
    ],
    [
      "an AdvancePayment of run-10 (prefix trap)",
      withRow("advancePayment", { id: "a", reference: "RUN:run-10:STOP:x" }),
    ],
    [
      "an office AdvancePayment (no reference)",
      withRow("advancePayment", { id: "a", reference: null }),
    ],
    [
      "a DeliveryMutation on another route's stop",
      withRow("deliveryMutation", { id: "x", routeRunStopId: "rrs-other" }),
    ],
    ["a Return with no stop", withRow("return", { id: "x", routeRunStopId: null })],
  ])("REG-B209 %s is NOT evidence", async (_name, db) => {
    await expect(has(db)).resolves.toBe(false);
  });

  it("REG-B209 another route's delivered run does not count against this route", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run({ id: "run-x", routeId: "route-2", status: "COMPLETED" }), run()],
      routeRunStop: [stop("rrs-x", { routeRunId: "run-x", signatureUrl: "k" }), stop()],
    });
    await expect(has(db)).resolves.toBe(false);
  });

  it("REG-B209 opts.runId narrows the scope to one run (deleteRun)", async () => {
    const db = emptyEvidenceDb({
      routeRun: [run({ id: "run-1" }), run({ id: "run-2" })],
      routeRunStop: [stop("rrs-1"), stop("rrs-2", { routeRunId: "run-2", signatureUrl: "k" })],
    });
    await expect(has(db, { runId: "run-1" })).resolves.toBe(false);
    await expect(has(db, { runId: "run-2" })).resolves.toBe(true);
    await expect(has(db)).resolves.toBe(true);
  });

  it("REG-B209 reads every id list in chunks of at most 1000 (a route with thousands of runs)", async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `run-${String(i).padStart(4, "0")}`);
    const db = emptyEvidenceDb({
      routeRun: ids.map((id) => run({ id })),
      routeRunStop: ids.map((id, i) =>
        stop(`rrs-${i}`, { routeRunId: id, signatureUrl: i === 2499 ? "k" : null }),
      ),
    });
    const { tx, log } = createEvidenceTx(db);

    await expect(routeHasDeliveryEvidence(tx, "route-1")).resolves.toBe(true);

    const longest = (v: unknown): number => {
      if (Array.isArray(v)) return Math.max(v.length, ...v.map(longest), 0);
      if (v && typeof v === "object") return Math.max(0, ...Object.values(v).map(longest));
      return 0;
    };
    // The run read itself is `{ routeId }`; every LATER read carries an id list or an OR list.
    const reads = log
      .filter((e) => e.op !== "routeRun.findMany")
      .map((e) => longest(e.args?.where));
    expect(Math.max(...reads)).toBeLessThanOrEqual(1000);
    expect(log.filter((e) => e.op === "routeRunStop.findFirst").length).toBeGreaterThan(1);
  });
});

describe("REG-B209 lockRunsForDelete — Route -> Orders -> stop rows -> RouteRun, per run in id order (SA-842 §2b)", () => {
  const kind = (sql = ""): string =>
    /FROM "Route" WHERE id = \?/.test(sql)
      ? "route"
      : /FROM "Order"\s/.test(sql)
        ? "orders"
        : /FROM "RouteRunStop" WHERE "routeRunId" = \? ORDER BY id FOR UPDATE/.test(sql)
          ? "stops"
          : /FROM "RouteRun" WHERE id = \? FOR UPDATE/.test(sql)
            ? "run"
            : `OTHER ${sql}`;
  const locks = (log: Array<{ op: string; sql?: string; values?: unknown[] }>) =>
    log
      .filter((e) => e.op === "$queryRaw" || e.op === "$executeRaw")
      .map((e) => `${kind(e.sql)}:${String(e.values?.[0])}`);

  const two = (): EvidenceDb =>
    emptyEvidenceDb({
      // Seeded OUT of id order on purpose: the helper must sort, not rely on insertion order.
      routeRun: [run({ id: "run-b" }), run({ id: "run-a" })],
      routeRunStop: [
        stop("rrs-b", { routeRunId: "run-b" }),
        stop("rrs-a", { routeRunId: "run-a" }),
      ],
    });

  it("REG-B209 a route delete locks the Route first, then each run's Orders, stop rows and run row, runs in id order", async () => {
    const { tx, log } = createEvidenceTx(two());

    const got = await lockRunsForDelete(tx, { routeId: "route-1", tenantId: "t1" });

    // WRONG VALUE TODAY: no helper, no lock statement — the tx writes on a pre-tx read.
    expect(locks(log)).toEqual([
      "route:route-1",
      "orders:run-a",
      "stops:run-a",
      "run:run-a",
      "orders:run-b",
      "stops:run-b",
      "run:run-b",
    ]);
    expect(got.runIds).toEqual(["run-a", "run-b"]);
    expect([...got.runStopIds].sort()).toEqual(["rrs-a", "rrs-b"]);
  });

  it("REG-B209 a single-run delete (deleteRun) takes NO Route lock and only that run's locks", async () => {
    const { tx, log } = createEvidenceTx(two());

    const got = await lockRunsForDelete(tx, { routeId: "route-1", runId: "run-b", tenantId: "t1" });

    expect(locks(log)).toEqual(["orders:run-b", "stops:run-b", "run:run-b"]);
    expect(got).toEqual({ runIds: ["run-b"], runStopIds: ["rrs-b"] });
  });

  it("REG-B209 a route with no runs locks only the Route and answers empty id lists", async () => {
    const { tx, log } = createEvidenceTx(emptyEvidenceDb());

    await expect(lockRunsForDelete(tx, { routeId: "route-1", tenantId: "t1" })).resolves.toEqual({
      runIds: [],
      runStopIds: [],
    });
    expect(locks(log)).toEqual(["route:route-1"]);
  });

  it("REG-B209 the refusal is a 409 carrying ROUTE_HAS_DELIVERY_EVIDENCE and copy that offers Deactivate", () => {
    const err = deliveryEvidenceRefusal();
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toEqual({
      code: "ROUTE_HAS_DELIVERY_EVIDENCE",
      message: expect.stringContaining("Deactivate"),
    });
  });
});

describe("REG-B209b forbiddenRunTransition — IN_PROGRESS -> SCHEDULED after a completed stop (SA-842b)", () => {
  it("REG-B209b refuses IN_PROGRESS -> SCHEDULED when a stop has completed (a reason string)", () => {
    // WRONG VALUE TODAY: null — the deny-list has no IN_PROGRESS -> SCHEDULED edge and ignores a third argument.
    expect(
      typeof forbiddenRunTransition("IN_PROGRESS", "SCHEDULED", { hasCompletedStop: true }),
    ).toBe("string");
  });

  it("REG-B209b (guard) keeps IN_PROGRESS -> SCHEDULED legal before any stop completes, and with no context at all", () => {
    expect(
      forbiddenRunTransition("IN_PROGRESS", "SCHEDULED", { hasCompletedStop: false }),
    ).toBeNull();
    expect(forbiddenRunTransition("IN_PROGRESS", "SCHEDULED")).toBeNull();
  });

  it("REG-B209b (guard) a completed stop changes no other edge of the matrix", () => {
    const ctx = { hasCompletedStop: true };
    expect(forbiddenRunTransition("IN_PROGRESS", "IN_PROGRESS", ctx)).toBeNull();
    expect(forbiddenRunTransition("IN_PROGRESS", "CANCELLED", ctx)).toBeNull();
    expect(forbiddenRunTransition("IN_PROGRESS", "COMPLETED", ctx)).toBeNull();
    expect(forbiddenRunTransition("SCHEDULED", "SCHEDULED", ctx)).toBeNull();
    expect(forbiddenRunTransition("SCHEDULED", "IN_PROGRESS", ctx)).toBeNull();
    expect(forbiddenRunTransition("CANCELLED", "SCHEDULED", ctx)).toBeNull();
    expect(forbiddenRunTransition("CANCELLED", "IN_PROGRESS", ctx)).toBeNull();
    expect(forbiddenRunTransition("COMPLETED", "IN_PROGRESS", ctx)).toBeNull();
    expect(typeof forbiddenRunTransition("COMPLETED", "SCHEDULED", ctx)).toBe("string");
    expect(typeof forbiddenRunTransition("CANCELLED", "COMPLETED", ctx)).toBe("string");
  });
});
