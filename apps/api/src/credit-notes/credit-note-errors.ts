import { BadRequestException, ConflictException, HttpException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

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
