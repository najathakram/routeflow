import { BadRequestException, ConflictException, HttpException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { txConflictState } from "../common/tx-retry";
import { describeUniqueViolation, uniqueViolationOn } from "../common/prisma-unique";

/**
 * #2648/#2848 (SA-608): the credit-note refusals carry a machine-readable `body.code` from the
 * closed CREDIT_NOTE_* set (packages/types/api/error-codes.ts). The web and mobile clients map
 * each code to FIXED copy and never render `message`; `message` stays for logs and API callers.
 */
export type CreditNoteCode = Extract<
  (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES],
  `CREDIT_NOTE_${string}`
>;

export const cnBad = (code: CreditNoteCode, message: string) =>
  new BadRequestException({ code, message });

export const cnConflict = (code: CreditNoteCode, message: string) =>
  new ConflictException({ code, message });

/** The `body.code` of an HttpException, or null. */
export function codeOf(err: unknown): string | null {
  if (!(err instanceof HttpException)) return null;
  const body = err.getResponse();
  return typeof body === "object" && body !== null
    ? ((body as { code?: string }).code ?? null)
    : null;
}

/** The `body.message` of an HttpException as one string. */
export function messageOf(err: HttpException): string {
  const body = err.getResponse();
  const m =
    typeof body === "object" && body !== null ? (body as { message?: unknown }).message : body;
  if (Array.isArray(m)) return m.map(String).join("; ");
  return typeof m === "string" ? m : err.message;
}

/**
 * Exhausted serialization retries (40001 / 40P01 / P2034) and a credit-note-number collision (P2002)
 * are 409 CHANGED_CONCURRENTLY, never a raw 500. The one shared mapping for the void and the reissue
 * (SA-608h). Only the creditNoteNumber constraint is a "number conflict" (like create()); the real
 * P2002 target is logged either way and any other unique violation propagates untouched.
 */
export function asReadableConflict(err: unknown, logger: { warn(message: string): void }): unknown {
  if (txConflictState(err))
    return cnConflict(
      API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY,
      "Another change to this credit note or its invoice was in progress. Nothing was changed; please retry.",
    );
  if ((err as { code?: string })?.code === "P2002") {
    logger.warn(`Credit note write failed code=P2002 target=${describeUniqueViolation(err)}`);
    if (uniqueViolationOn(err, "CreditNote_tenantId_creditNoteNumber_key", { exact: true }))
      return cnConflict(
        API_ERROR_CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY,
        "Credit note number conflict — please retry.",
      );
  }
  return err;
}
