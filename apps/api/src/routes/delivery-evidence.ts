import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockRunOrdersForTerminalStatus } from "./delivery-lines.util";

/**
 * SA-842 (B209 / #1402): a route or run is deletable only while it holds NO delivery evidence.
 *
 * Deleting a RouteRunStop removes the SOLE pointers to its POD objects (`podPhotoUrls`, `signatureUrl`,
 * `podHistory`), its arrival / completion / ID-check record, and strips the stop link from the change
 * requests, delivery mutations and batches that reference it. Run STATUS is not a proxy for "recorded
 * nothing": a CANCELLED run keeps its delivered stops, and IN_PROGRESS -> SCHEDULED is a legal edge.
 *
 * Every delete path asks `routeHasDeliveryEvidence` INSIDE its transaction, after `lockRunsForDelete`
 * (lock, then check, then write; a refusal throws and rolls everything back), so the answer cannot go
 * stale between the read and the delete. `delivery-evidence.tripwire.spec.ts` fails the build for a
 * deleter that skips it. A new evidence column is ONE clause below.
 *
 * Deliberately NOT evidence (each would strand an empty route): stop `notes`, `safeDropEnabled`,
 * `ageCheckRequired` / `identityCheckRequired` (set at dispatch); run `startedAt` alone, `notes`,
 * `manuallyReordered`; DriverLocation and Message.runId (they survive the delete); an InvoicePayment
 * found only by order pin (an office prepayment would read as evidence; a driver's door payment always
 * comes with a COMPLETED stop, which already counts). Over-refusal is recoverable (deactivate the route
 * instead); under-refusal is not.
 */

/** Id lists are probed in chunks so one statement never carries thousands of bind values. */
const CHUNK = 1000;
const chunks = <T>(items: T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) =>
    items.slice(i * CHUNK, (i + 1) * CHUNK),
  );

/** The 409 every delete path throws on refusal; clients branch on the code and offer Deactivate. */
export function deliveryEvidenceRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.ROUTE_HAS_DELIVERY_EVIDENCE,
    message:
      "This route has delivery records (proof of delivery, signatures or payments), so it can't be deleted. Deactivate it to hide it from dispatch.",
  });
}

/** A RouteRunStop that recorded anything the driver did or captured. */
const STOP_EVIDENCE = [
  { status: { in: ["IN_PROGRESS", "COMPLETED", "SKIPPED"] } },
  { arrivedAt: { not: null } },
  { completedAt: { not: null } },
  { podPhotoUrls: { isEmpty: false } },
  { signatureUrl: { not: null } },
  { podHistory: { not: Prisma.AnyNull } },
  { driverNote: { not: null } },
  { skipReason: { not: null } },
  { ageVerified: true },
  { identityVerified: true },
  { identityType: { not: null } },
  { identityVerifiedAt: { not: null } },
];

/** Rows that point at a RouteRunStop and outlive nothing without it (Return has no FK, so it is probed too). */
const STOP_LINKED_MODELS = ["deliveryMutation", "deliveryBatch", "changeRequest", "return"];

const hit = async (probe: Promise<unknown>) => (await probe) != null;

/** A run that is live or finished, or closed with a cash settlement (REG-B96 stays refused). */
function runRecordsDelivery(r: {
  status: string;
  completedAt: unknown;
  settlementVariance: unknown;
  settlementNote: unknown;
}): boolean {
  return (
    r.status === "IN_PROGRESS" ||
    r.status === "COMPLETED" ||
    r.completedAt != null ||
    r.settlementVariance != null ||
    r.settlementNote != null
  );
}

/** EXISTS probes over the indexed run / stop ids of one chunk. */
async function runsHaveEvidence(tx: any, runIds: string[]): Promise<boolean> {
  const select = { id: true };
  if (
    await hit(
      tx.routeRunStop.findFirst({
        where: { routeRunId: { in: runIds }, OR: STOP_EVIDENCE },
        select,
      }),
    )
  ) {
    return true;
  }
  // The driver's door cash: `RUN:<runId>:STOP:<stopId>`, `:REVERSED` included (invoices.service).
  const cash = runIds.map((id) => ({ reference: { startsWith: `RUN:${id}:` } }));
  if (await hit(tx.advancePayment.findFirst({ where: { OR: cash }, select }))) return true;
  const delivered = { deliveredQty: { gt: 0 } };
  if (
    await hit(
      tx.orderItem.findFirst({
        where: { ...delivered, order: { routeRunId: { in: runIds } } },
        select,
      }),
    )
  ) {
    return true;
  }
  const stops: Array<{ id: string }> = await tx.routeRunStop.findMany({
    where: { routeRunId: { in: runIds } },
    select,
  });
  for (const stopIds of chunks(stops.map((s) => s.id))) {
    const linked = { routeRunStopId: { in: stopIds } };
    for (const model of STOP_LINKED_MODELS) {
      if (await hit(tx[model].findFirst({ where: linked, select }))) return true;
    }
    if (await hit(tx.orderItem.findFirst({ where: { ...delivered, order: linked }, select }))) {
      return true;
    }
  }
  return false;
}

/**
 * True when the route (or, with `opts.runId`, that one run) holds delivery evidence. Re-reads the run
 * and stop ids on `tx`, never a caller-passed list; call it only after `lockRunsForDelete`.
 */
export async function routeHasDeliveryEvidence(
  tx: any,
  routeId: string,
  opts: { runId?: string } = {},
): Promise<boolean> {
  const runs: Array<{ id: string } & Parameters<typeof runRecordsDelivery>[0]> =
    await tx.routeRun.findMany({
      where: opts.runId ? { routeId, id: opts.runId } : { routeId },
      select: {
        id: true,
        status: true,
        completedAt: true,
        settlementVariance: true,
        settlementNote: true,
      },
    });
  if (runs.some(runRecordsDelivery)) return true;
  for (const runIds of chunks(runs.map((r) => r.id))) {
    if (await runsHaveEvidence(tx, runIds)) return true;
  }
  return false;
}

/**
 * The lock phase of a delete: Route -> Orders -> stop rows -> RouteRun, the house order (SA-214 /
 * SA-706f), then the run and stop ids re-read on `tx` for the caller's writes. A route delete takes the
 * Route lock `createRun` takes first; a single-run delete (`scope.runId`) takes none. Delete strength:
 * `FOR UPDATE`, deliberately NOT `lockRunStopsForTerminalStatus` (a row delete needs more than
 * `NO KEY UPDATE`, and that helper may weaken).
 */
export async function lockRunsForDelete(
  tx: any,
  scope: { routeId: string; runId?: string; tenantId: string | null },
): Promise<{ runIds: string[]; runStopIds: string[] }> {
  if (!scope.runId) {
    await tx.$queryRaw`SELECT id FROM "Route" WHERE id = ${scope.routeId} FOR UPDATE`;
  }
  const runs: Array<{ id: string }> = await tx.routeRun.findMany({
    where: scope.runId ? { id: scope.runId } : { routeId: scope.routeId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const runIds = runs.map((r) => r.id);
  for (const runId of runIds) {
    await lockRunOrdersForTerminalStatus(tx, runId, scope.tenantId);
    await tx.$queryRaw`SELECT id FROM "RouteRunStop" WHERE "routeRunId" = ${runId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "RouteRun" WHERE id = ${runId} FOR UPDATE`;
  }
  const stops: Array<{ id: string }> = runIds.length
    ? await tx.routeRunStop.findMany({
        where: { routeRunId: { in: runIds } },
        select: { id: true },
      })
    : [];
  return { runIds, runStopIds: stops.map((s) => s.id) };
}

/**
 * SA-842b: has a stop of this run completed? Only asked for IN_PROGRESS -> SCHEDULED (the one edge the
 * answer changes); every other transition answers false without a query.
 */
export async function runHasCompletedStop(
  db: any,
  run: { id: string; status: string },
  to: string,
): Promise<boolean> {
  if (run.status !== "IN_PROGRESS" || to !== "SCHEDULED") return false;
  return hit(
    db.routeRunStop.findFirst({
      where: { routeRunId: run.id, status: "COMPLETED" },
      select: { id: true },
    }),
  );
}
