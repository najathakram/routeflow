/**
 * B1415 M1b (SA-1504 R5): the Idempotency-Key of a stock adjustment on mobile (the Adjust stock sheet).
 *
 * `POST /inventory/movements/adjustment` replays an `Idempotency-Key`, so a retry of an adjustment that may have
 * landed (a dropped connection, a timeout) applies once. The key is minted by the SHEET (one holder per open) and put
 * into the mutation's args (`idempotencyKey`), so two taps carry identical args and still collapse in a single-flight
 * guard. It travels as the HEADER, never in the body (`adjustmentRequest`). The holder is the shared
 * `createAttemptKeyHolder` (`@routeflow/types/sale-attempt`): the key is kept while the body is unchanged (a retry),
 * dropped on a success or a refusal that wrote nothing (the next deliberate adjustment is fresh), and re-minted when
 * the body is edited.
 */
import { createAttemptKeyHolder } from "@routeflow/types/sale-attempt";

export const createAdjustmentAttemptKey = createAttemptKeyHolder;
export type AdjustmentAttemptKey = ReturnType<typeof createAttemptKeyHolder>;

/** What the key is bound to: the adjustment's own fields, in a fixed order, without the key itself. */
export function adjustmentFingerprint(dto: object): string {
  const { idempotencyKey: _key, ...rest } = dto as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(rest)
      .sort()
      .map((k) => [k, rest[k]]),
  );
}

/** The POST body (the dto without the key) and the request config carrying the key as the `Idempotency-Key` header. */
export function adjustmentRequest<T extends object>(
  dto: T & { idempotencyKey?: string },
): { body: Omit<T, "idempotencyKey">; config?: { headers: Record<string, string> } } {
  const { idempotencyKey, ...body } = dto;
  return {
    body: body as Omit<T, "idempotencyKey">,
    config: idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : undefined,
  };
}
