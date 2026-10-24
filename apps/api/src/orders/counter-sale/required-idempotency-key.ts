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
  return assertIdempotencyKeyFormat(key);
}

/**
 * SA-824: the OPTIONAL variant, for the customer payment writers (POST /invoices/payments/record,
 * POST /invoices/:id/payments, POST /customers/:id/advance-payments). Same normaliser and format; an
 * absent or blank header is `undefined` (an old client keeps today's behaviour), a malformed one is 400.
 */
export function optionalIdempotencyKey(raw: string | undefined): string | undefined {
  const key = raw?.trim();
  return key ? assertIdempotencyKeyFormat(key) : undefined;
}

function assertIdempotencyKeyFormat(key: string): string {
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    throw new BadRequestException(
      "Idempotency-Key must be at most 128 printable characters with no spaces",
    );
  }
  return key;
}
