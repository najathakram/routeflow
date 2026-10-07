import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * The ONE normaliser of a REQUIRED Idempotency-Key header (L-167), shared by the counter sale and
 * POST /orders/:id/pickup-complete. Same format as OrdersController.normalizeIdempotencyKey (1-128
 * printable ASCII, no spaces), but the key is REQUIRED: the tender step replays on it, so a keyless call
 * could double-charge on a retry. `action` completes "Idempotency-Key header is required to <action>".
 */
export function requireIdempotencyKey(raw: string | undefined, action: string): string {
  const key = raw?.trim();
  if (!key) {
    throw new BadRequestException({
      code: API_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      message: `Idempotency-Key header is required to ${action}`,
    });
  }
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new BadRequestException(
      "Idempotency-Key must be at most 128 printable characters with no spaces",
    );
  }
  return key;
}
