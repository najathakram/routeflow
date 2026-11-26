import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1415 M1b (SA-1404 / SA-1504): the server-side replay key of POST /inventory/movements/adjustment.
 *
 * A retried adjustment (a dropped connection, a double tap the client guard missed) must apply ONCE. The route reads
 * an `Idempotency-Key` and `InventoryService.recordAdjustment` replays through the shared `IdempotencyService`:
 *
 *  - R1 inside the stock tx, before any stock write: `acquireLock` (fails closed), `check`, then on a miss apply and
 *       `save` in the SAME tx. A 40P01 retry re-runs all of it.
 *  - R2 per tenant (`SCOPE`), the service's 24h window, a client UUID of at most `MAX_KEY_LENGTH` characters.
 *  - R3 a replay returns the stored response (same body), writes no movement. The date gate runs after the read.
 *  - R4 the same key with a different body is 409 IDEMPOTENCY_KEY_REUSED and writes nothing. The table stores no
 *       request, so the saved response carries a sha256 of the canonical body.
 *  - R5 no header: applies as before, with a warn line (legacy builds).
 */
export const ADJUSTMENT_KEY_SCOPE = "stock.adjustment";
export const ADJUSTMENT_KEY_MAX_LENGTH = 200;

const logger = new Logger("AdjustmentIdempotency");

/** R5: a request with no key applies as today; this line is the signal that a legacy build still posts without one. */
export function warnNoAdjustmentKey(productId: string): void {
  logger.warn(
    `recordAdjustment without an Idempotency-Key (legacy client): a retry would apply twice (product ${productId})`,
  );
}

/** What `save` keeps under the key: the first call's response and the hash of the body it answered. */
export interface StoredAdjustment {
  bodyHash: string;
  response: unknown;
}

/** The trimmed key, or undefined for no header (a legacy build). Longer than the cap is a 400, before anything runs. */
export function normalizeAdjustmentKey(raw: string | undefined): string | undefined {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return undefined;
  if (key.length > ADJUSTMENT_KEY_MAX_LENGTH) {
    throw new BadRequestException(
      `Idempotency-Key must be at most ${ADJUSTMENT_KEY_MAX_LENGTH} characters`,
    );
  }
  return key;
}

interface AdjustmentBody {
  productId: string;
  quantity: number | string;
  notes?: string | null;
  reference?: string | null;
  reason?: string | null;
  reasonNote?: string | null;
  effectiveDate?: string | null;
}

/** sha256 of the canonical body: the fields the adjustment is made of, absent and null alike, quantity as a number. */
export function adjustmentBodyHash(dto: AdjustmentBody): string {
  const canonical = {
    productId: dto.productId,
    quantity: Number(dto.quantity),
    notes: dto.notes ?? null,
    reference: dto.reference ?? null,
    reason: dto.reason ?? null,
    reasonNote: dto.reasonNote ?? null,
    effectiveDate: dto.effectiveDate ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(canonical).sort(([a], [b]) => (a < b ? -1 : 1))))
    .digest("hex");
}

/** The stored response for a replay of the same body; a different body under the same key is refused (nothing written). */
export function replayOf<T>(hit: StoredAdjustment, bodyHash: string): T {
  if (hit.bodyHash !== bodyHash) {
    throw new ConflictException({
      code: API_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      message: "That Idempotency-Key was used for a different stock adjustment.",
    });
  }
  return hit.response as T;
}
