import { ConflictException } from "@nestjs/common";
import type { RouteRunStop } from "@prisma/client";
import { createHash } from "crypto";
import { toCents } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { IdempotencyService } from "../common/idempotency.service";
import { IDEMPOTENCY_KEY_CONFLICT } from "../orders/merge-idempotency";
import type { CompleteWithPaymentDto } from "./dto/complete-with-payment.dto";

/**
 * SA-953 S1, S2: the key behind a stop completion. The lookup runs right after the ownership check
 * and ahead of every state check, because a committed stop would otherwise answer "already completed"
 * and a run's last stop "not in progress" before the key is ever read. The key row commits in the
 * completion's own transaction, so a committed completion and its key can't part.
 *
 * Rows with no request hash can't reach this code: the shared service's tenant-scoped hash can't
 * match a row the old helpers wrote, so those keys miss and fall to the state checks.
 */

// The service holds no state or dependencies, and this saves injecting it into every RoutesService test module.
const idempotency = new IdempotencyService();

type StopCompletionPath = "completeStop" | "completeWithPayment";
type StopCompletionRequest = Pick<CompleteWithPaymentDto, "deliveries" | "payment">;

export interface StopCompletionKey {
  key: string;
  tenantId: string | null;
  scope: string;
  requestHash: string;
}

/** B870: each path's response, so a replay and a fresh call share one shape. */
export type CompletedStop = RouteRunStop;
export type CompletedStopWithPayment = CompletedStop & {
  paymentIds: string[];
  excess?: number;
  advancePaymentId?: string | null;
};

/** What the key row stores: the request's hash and the response it produced. */
interface StoredStopCompletion {
  requestHash: string;
  response: unknown;
}

/**
 * Money and quantity only. Notes, proof and gate evidence stay out: a replay returns the committed
 * attempt's result, and the proof's key-derived object names already govern retried uploads.
 */
export function stopCompletionRequestHash(dto: StopCompletionRequest): string {
  const payment = dto.payment
    ? [dto.payment.invoiceId ?? null, toCents(dto.payment.amount), dto.payment.method.toUpperCase()]
    : null;
  const deliveries = [...(dto.deliveries ?? [])]
    .sort((a, b) => (a.orderItemId < b.orderItemId ? -1 : a.orderItemId > b.orderItemId ? 1 : 0))
    .map((d) => [d.orderItemId, d.type, d.quantityDelivered, d.productId ?? null]);
  return createHash("sha256").update(JSON.stringify({ payment, deliveries })).digest("hex");
}

export function stopKeyFor(
  path: StopCompletionPath,
  run: { id: string; tenantId: string | null },
  stopId: string,
  dto: StopCompletionRequest & { idempotencyKey?: string },
): StopCompletionKey | null {
  if (!dto.idempotencyKey) return null;
  return {
    key: dto.idempotencyKey,
    tenantId: run.tenantId,
    scope: `${path}:${run.id}:${stopId}`,
    requestHash: stopCompletionRequestHash(dto),
  };
}

/** The committed attempt's response, null when this key has none, or SA-824's 409 for a changed request. */
export async function replayStopKey<R>(
  prisma: { tenantTransaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> },
  stopKey: StopCompletionKey | null,
): Promise<R | null> {
  if (!stopKey) return null;
  const { key, tenantId, scope, requestHash } = stopKey;
  const stored = await prisma.tenantTransaction((tx) =>
    idempotency.check<StoredStopCompletion>(key, tenantId, scope, tx),
  );
  if (!stored) return null;
  if (stored.requestHash !== requestHash) {
    throw new ConflictException({
      code: IDEMPOTENCY_KEY_CONFLICT,
      reason: API_ERROR_CODES.PAYMENT_MISMATCH,
      message:
        "This stop was already completed with a different payment or quantity. This request wrote nothing.",
    });
  }
  return stored.response as R;
}

/** Last in the completion's transaction: the stop as committed, plus what the path adds to its response. */
export async function saveStopKey(
  tx: any,
  stopKey: StopCompletionKey | null,
  stopId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!stopKey) return;
  const { key, tenantId, scope, requestHash } = stopKey;
  const stop = await tx.routeRunStop.findUniqueOrThrow({ where: { id: stopId } });
  const stored: StoredStopCompletion = { requestHash, response: { ...stop, ...extra } };
  await idempotency.save(key, tenantId, scope, stored, tx);
}
