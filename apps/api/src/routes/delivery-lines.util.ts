import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  deliveredSoFarForLine,
  fetchEvidenceByLine,
  isNotOrdered,
  lineRemaining,
} from "./delivered-so-far";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-151 review: `stop.status === "COMPLETED"` is checked BEFORE the caller's transaction in
 * both `completeStop`/`completeWithPayment`, so two overlapping submits (double-tap, a retried
 * request that actually landed) can both pass it and both reach here — a plain `update` would
 * let both write evidence (and, on the paid path, collect payment) — up to 2x. Atomically
 * re-checks against the CURRENT row (same B283/REG-B283 pattern as orders.service.ts's
 * DRAFT→PENDING claim) and throws 409 for whichever submit loses the race.
 */
export async function claimStopCompletion(
  tx: any,
  stopId: string,
  data: Record<string, unknown>,
): Promise<void> {
  // #2409: only a PENDING / IN_PROGRESS stop can be completed — a SKIPPED one (the office skipped
  // it while a completion sat in the driver's offline queue) must never flip to COMPLETED.
  const claimed = await tx.routeRunStop.updateMany({
    where: { id: stopId, status: { in: COMPLETABLE_STOP_STATUSES } },
    data,
  });
  if (claimed.count === 0) {
    const current = await tx.routeRunStop.findUnique({
      where: { id: stopId },
      select: { status: true },
    });
    assertStopNotSkipped(current?.status);
    throw new ConflictException("This stop was already completed by another request.");
  }
}

/**
 * #2415: the compare-and-swap for updateStopStatus (skip / arrive). The old check-then-`update`
 * let a skip that read PENDING overwrite a completion that committed in between — COMPLETED became
 * SKIPPED and its DeliveryMutation / invoice / payment were stranded. The write now only lands on a
 * row that is still not COMPLETED; losing to a completion answers 409 STOP_ALREADY_COMPLETED.
 * (`not COMPLETED`, not `in [PENDING, IN_PROGRESS]`: a SKIPPED stop may still be marked
 * IN_PROGRESS, as before — only the race with a completion is closed.)
 */
export async function claimStopStatusChange(
  db: any,
  stopId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const claimed = await db.routeRunStop.updateMany({
    where: { id: stopId, status: { not: "COMPLETED" } },
    data,
  });
  if (claimed.count > 0) return;
  const current = await db.routeRunStop.findUnique({
    where: { id: stopId },
    select: { status: true },
  });
  if (current?.status === "COMPLETED") {
    throw new ConflictException({
      code: API_ERROR_CODES.STOP_ALREADY_COMPLETED,
      message:
        "This stop was just completed. Reopen it instead — that reverses the delivery correctly.",
    });
  }
  throw new NotFoundException("Stop not found");
}

/** #2409: the stop statuses a completion may claim from. */
/** #2514: RF-003's run-status refusal, called AFTER the B72 ownership check (never before it). */
export function assertRunInProgress(status: string): void {
  if (status !== "IN_PROGRESS") {
    throw new ForbiddenException(
      `Cannot complete a stop on a run that is not in progress (current status: ${status}).`,
    );
  }
}

/**
 * #2631 / SA-550: the completion's in-tx run re-check. Called RIGHT AFTER claimStopCompletion (which
 * holds this stop's row lock), a plain read — NO run lock, so the completion adds no RouteRun edge.
 * Correct under READ COMMITTED: a terminal status committed before our stop lock was granted is
 * visible to this statement; a terminal transition that starts later locks the run's stop rows FIRST
 * (lockRunStopsForTerminalStatus) and so waits on ours until we commit. Same refusal as the pre-tx
 * assertRunInProgress (reused, not copied); the throw rolls the whole completion back.
 */
export async function assertRunStillInProgress(tx: any, runId: string): Promise<void> {
  // The same unique read as the completion's pre-tx check, now on the transaction client.
  const run = await tx.routeRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run) throw new NotFoundException("Route run not found");
  assertRunInProgress(run.status);
}

/**
 * SA-706f: the house order is Orders -> STOP rows -> RouteRun, on every path. A run's terminal move
 * locks every Order `releaseUndeliveredOrders` may write (attached to the run OR to one of its
 * stops), FOR UPDATE by id, BEFORE the stop rows: completeStop / completeWithPayment lock a stop's
 * Orders first, so Stop -> Order here was a 40P01 with the driver as the victim. Returns the locked
 * ids; the release writes ONLY inside that set (an order attached later waits for the next pass).
 */
export async function lockRunOrdersForTerminalStatus(tx: any, runId: string): Promise<string[]> {
  if (!runId) throw new Error("SA-706f: run id missing for the terminal-status order lock");
  const rows: Array<{ id: string }> = await tx.$queryRaw`
    SELECT id FROM "Order" WHERE "routeRunId" = ${runId}
      OR "routeRunStopId" IN (SELECT id FROM "RouteRunStop" WHERE "routeRunId" = ${runId})
    ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/**
 * A completion's auto-complete release (RF-016): the Orders attached to the run's OTHER stops,
 * FOR UPDATE by id, so `releaseUndeliveredOrders` writes only rows it holds (SA-706f).
 */
export async function lockStopsOrdersForRelease(tx: any, stopIds: string[]): Promise<string[]> {
  if (stopIds.length === 0) return [];
  const rows: Array<{ id: string }> = await tx.$queryRaw`
    SELECT id FROM "Order" WHERE "routeRunStopId" IN (${Prisma.join(stopIds)}) ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/**
 * The same terminal move's second step (after the Orders, SA-706f): the run's CURRENT stop rows
 * FOR UPDATE by id BEFORE the run row, so a stop completion in flight is waited for, never
 * overtaken (#2631 / SA-550). A run with no stop rows locks the run row directly.
 */
export async function lockRunStopsForTerminalStatus(tx: any, runId: string): Promise<void> {
  // SA-511c: an undefined id would lock nothing and silently skip the serialization.
  if (!runId) throw new Error("#2631: run id missing for the terminal-status stop lock");
  const stops: unknown[] = await tx.$queryRaw`
    SELECT id FROM "RouteRunStop" WHERE "routeRunId" = ${runId} ORDER BY id FOR UPDATE`;
  if (stops.length === 0)
    await tx.$queryRaw`SELECT id FROM "RouteRun" WHERE id = ${runId} FOR UPDATE`;
}

/**
 * #2514 (SA-533 / 533e): a stop status PATCH (IN_PROGRESS / SKIPPED) on a LIVE run only. One
 * transaction, in the house lock order for this family, STOP rows → RouteRun, the order
 * completeStop / completeWithPayment (claimStopCompletion, then the RF-016 run auto-complete) and
 * reopenStop already take:
 *   1. the #2415 stop CAS (takes the stop row lock; a completed stop ⇒ 409 STOP_ALREADY_COMPLETED);
 *   2. `RouteRun … FOR UPDATE`, re-read the status, a COMPLETED/CANCELLED run ⇒ 409 (same text as
 *      the pre-lock check) — the throw rolls the stop CAS back.
 * A run that completes or is cancelled while this PATCH waits is seen under the run lock, never
 * overwritten after. (SA-533's original run-first order inverted the completion paths' stop → run
 * order and could deadlock — SA-E84.)
 */
export async function claimStopStatusChangeOnLiveRun(
  prisma: { tenantTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> },
  runId: string,
  stopId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await prisma.tenantTransaction(async (tx) => {
    await claimStopStatusChange(tx, stopId, data); // stop row FIRST (house order)
    await tx.$executeRaw`SELECT id FROM "RouteRun" WHERE id = ${runId} FOR UPDATE`;
    const run = await tx.routeRun.findFirst({ where: { id: runId }, select: { status: true } });
    if (!run) throw new NotFoundException("Route run not found");
    if (run.status === "COMPLETED" || run.status === "CANCELLED") {
      throw new ConflictException(
        `Cannot change a stop on a ${String(run.status).toLowerCase()} run.`,
      );
    }
  });
}

export const COMPLETABLE_STOP_STATUSES = ["PENDING", "IN_PROGRESS"];

/**
 * #2409: a SKIPPED stop refuses a completion with a readable 409 — the pre-transaction guard in
 * both completeStop and completeWithPayment, and the loser branch of claimStopCompletion. A
 * replayed offline completion then dead-letters on the driver's device (a 4xx), with the failed
 * badge, instead of silently turning a skipped stop into a completed one (201).
 */
export function assertStopNotSkipped(status: string | null | undefined): void {
  if (status === "SKIPPED") {
    throw new ConflictException({
      code: API_ERROR_CODES.STOP_SKIPPED,
      message:
        "This stop was skipped by dispatch, so it can't be completed. Ask dispatch to reopen it.",
    });
  }
}

/**
 * #2292: the pieces-per-unit of a units_v1 line, by the SA-388 count derivation the driver's
 * stepper uses — the count is `boxes` when a positive integer, else `qty ÷ unitsPerBox` (the
 * sale-time snapshot) when that factor is an integer ≥ 1 and qty a positive whole multiple of it;
 * the factor is then `qty ÷ count`. Null when the line is not a unit line (no `unitLabel`: a pack
 * line) or its count is LOCKED (no whole count can be derived — never guessed).
 */
export function unitLineFactor(line: {
  qty: unknown;
  boxes?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: string | null;
}): number | null {
  if (!line.unitLabel?.trim()) return null;
  const qty = Number(line.qty);
  const boxes = Number(line.boxes);
  const upb = Number(line.unitsPerBox);
  let count: number | null = null;
  if (Number.isInteger(boxes) && boxes > 0) count = boxes;
  else if (Number.isInteger(upb) && upb >= 1 && qty > 0 && Number.isInteger(qty / upb)) {
    count = qty / upb;
  }
  if (count == null) return null;
  const factor = qty / count;
  return Number.isInteger(factor) && factor >= 1 ? factor : null;
}

/** "3 Cases" / "1 Case" / "0 Cases" — the same plural rule as `formatQtySplit`'s `boxLabel`. */
function unitCount(n: number, unit: string): string {
  const plural = unit.endsWith("s") ? unit : `${unit}s`;
  return `${n} ${n === 1 ? unit : plural}`;
}

/**
 * #2292: the "left / delivered earlier" part of a cap refusal, in the unit the driver sees. A pack
 * line is unchanged (bare numbers). A unit line states whole units when BOTH figures are whole
 * multiples of its factor ("3 Cases left, 7 Cases delivered earlier"); a LOCKED line, or a
 * remainder that is not a whole unit, states pieces labelled "pieces" — never a fractional Case.
 */
export function capRefusalCounts(
  line: { qty: unknown; boxes?: unknown; unitsPerBox?: unknown; unitLabel?: string | null },
  remaining: number,
  deliveredSoFar: number,
): string {
  if (!line.unitLabel?.trim()) return `${remaining} left, ${deliveredSoFar} delivered earlier`;
  const factor = unitLineFactor(line);
  const unit = line.unitLabel.trim();
  if (
    factor != null &&
    Number.isInteger(remaining / factor) &&
    Number.isInteger(deliveredSoFar / factor)
  ) {
    return `${unitCount(remaining / factor, unit)} left, ${unitCount(deliveredSoFar / factor, unit)} delivered earlier`;
  }
  return `${remaining} pieces left, ${deliveredSoFar} pieces delivered earlier`;
}

/**
 * Refuse a delivery payload BEFORE any write. Every line must (1) belong to an order carried by
 * THIS stop — a driver owns the run, not the tenant's other orders, and each line drives a
 * DeliveryMutation, `deliveredQty` and the delivered-basis invoice reconcile of the order it
 * names — and (2) deliver a finite quantity within [0, REMAINING qty]: `billQty` is
 * `deliveredQty` unclamped, so an over-delivered line would bill units nobody ordered. An item id
 * may appear once (each duplicate would pass the cap on its own), and an id that resolves to no
 * item — the read is tenant-scoped, so a foreign tenant's item looks exactly like a missing one —
 * is a 404. Every refusal names the offending item.
 *
 * B785/SA-116/SA-133: the cap is `ordered qty − deliveredSoFar`, not the full ordered qty — a
 * second visit (re-delivery, a reopened partial) must never be allowed to deliver more than the
 * order still has outstanding. `deliveredSoFar` excludes THIS stop's own rows (`delivered-so-far.ts`,
 * shared with the run/stop read projection) — the ordinary flow calls this before any row of
 * this completion is written, so there is nothing of this stop's to exclude yet, but the
 * exclusion still guards an idempotency replay or a defensive re-check from double-counting this
 * stop's own prior attempt. A REFUSED evidence row contributes 0, so a previously-refused line's
 * full ordered qty remains available to a later re-delivery attempt.
 *
 * F-05 (#2093, owner ruling 2026-09-25): at-door delivery may never sell what was not ordered, and a line
 * that was CANCELLED — or on a CANCELLED / DRAFT order still riding a stop — was not ordered any more:
 * its ceiling is 0, so a driver cannot deliver (and bill) units of it. Delivering 0 is still allowed.
 *
 * `tx` is the tenant-scoped transaction client (tenantTransaction), so the item read can never
 * see another tenant's rows.
 */
export async function assertDeliveriesFitStop(
  tx: any,
  stopId: string,
  stopOrders: readonly { id: string }[],
  deliveries: readonly { orderItemId: string; quantityDelivered: number }[] | undefined,
): Promise<void> {
  if (!deliveries || deliveries.length === 0) return;
  const items: {
    id: string;
    orderId: string;
    qty: unknown;
    deliveredQty?: unknown;
    boxes?: unknown;
    unitsPerBox?: unknown;
    unitLabel?: string | null;
    name: string | null;
    product: { name: string } | null;
    status?: string;
    order?: { status?: string } | null;
  }[] = await tx.orderItem.findMany({
    where: { id: { in: deliveries.map((d) => d.orderItemId) } },
    select: {
      id: true,
      orderId: true,
      qty: true,
      deliveredQty: true,
      boxes: true,
      unitsPerBox: true,
      unitLabel: true,
      name: true,
      product: { select: { name: true } },
      status: true,
      order: { select: { status: true } },
    },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const onStop = new Set(stopOrders.map((o) => o.id));
  const evidenceByLine = await fetchEvidenceByLine(tx, [...new Set(items.map((i) => i.orderId))]);
  const seen = new Set<string>();
  for (const d of deliveries) {
    if (seen.has(d.orderItemId)) {
      throw new BadRequestException(
        `Order item ${d.orderItemId} appears in more than one delivery line`,
      );
    }
    seen.add(d.orderItemId);
    const item = byId.get(d.orderItemId);
    if (!item) throw new NotFoundException(`Order item ${d.orderItemId} was not found`);
    if (!onStop.has(item.orderId)) {
      throw new BadRequestException(`Order item ${d.orderItemId} does not belong to this stop`);
    }
    const deliveredSoFar = deliveredSoFarForLine(
      evidenceByLine[item.orderId]?.[item.id],
      stopId,
      item.deliveredQty,
      item.qty,
    );
    // SA-366: ONE figure for the bound and the run projection's served `remaining` — clamped at 0
    // (SA-151: a data anomaly, deliveredSoFar > qty, never surfaces as a negative remaining) and
    // exactly 0 for a line that is no longer ordered (F-05).
    const notOrdered = isNotOrdered(item.status, item.order?.status);
    const remaining = lineRemaining({
      qty: item.qty,
      lineStatus: item.status,
      orderStatus: item.order?.status,
      deliveredSoFar,
    });
    const q = Number(d.quantityDelivered);
    // SA-365 R2: the ceilings nest (remaining ≤ qty). A ceiling of 0 is EXACT (no epsilon): 0.0005 of
    // a cancelled line is still a delivery of nothing ordered.
    const over = notOrdered ? q !== 0 : q > remaining + 0.0005;
    if (!Number.isFinite(q) || q < 0 || over) {
      // SA-151 review / SA-365 R4: driver-readable, not a bare orderItemId UUID (payment.tsx
      // surfaces this verbatim in a toast) — the product name, what's actually left, and what
      // already happened elsewhere, with the one actionable next step.
      const label = item.product?.name ?? item.name ?? "This item";
      throw new BadRequestException(
        notOrdered
          ? item.order?.status === "DRAFT"
            ? `${label} belongs to an order that is not confirmed yet — nothing can be delivered against it`
            : `${label} was cancelled — nothing can be delivered against it`
          : `${label}: ${capRefusalCounts(item, remaining, deliveredSoFar)} — refresh the stop`,
      );
    }
  }
}
