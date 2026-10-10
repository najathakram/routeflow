import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isNsfLine, type NsfLineFacts } from "./nsf-line";

/**
 * #2656 / SA-549: the NSF bounce-fee line is NEVER taxed. Every server write that accepts a per-line
 * taxRate (invoice create, the PATCH edit, recurring templates) refuses a line that IS the NSF line
 * with a rate > 0 — 400 `{ code: NSF_LINE_UNTAXED }`, before anything is written. "Is the NSF line" is
 * decided by the STORED row the payload line matched (the edit), else by the line's own description
 * (a new line; the shared predicate's prefix leg). Clients lock the field at 0, so a legacy DRAFT whose
 * NSF line was stored taxed heals on its next save.
 *
 * @param items the payload lines
 * @param rows  optional: the stored row each payload line matched (same index; null = a new line)
 */
export function assertNsfLinesUntaxed(
  items: ReadonlyArray<{ taxRate?: number | null; description?: string | null }>,
  // A stored InvoiceItem row (StoredEditRow is an open record) — read for its NsfLineFacts only.
  rows?: ReadonlyArray<object | null>,
): void {
  items.forEach((item, i) => {
    const row = rows?.[i] ?? null;
    const nsf = row
      ? isNsfLine(row as NsfLineFacts)
      : isNsfLine({ systemKind: null, description: item.description ?? null });
    if (nsf && Number(item.taxRate ?? 0) > 0)
      throw new BadRequestException({
        code: API_ERROR_CODES.NSF_LINE_UNTAXED,
        message: "The NSF fee line is never taxed — set its tax rate to 0.",
      });
  });
}

/**
 * #2656 / B142 ("billing must never pause"): the UNATTENDED recurring run never refuses. A legacy
 * template line that IS the NSF fee line (by its description) and still carries a rate is billed at
 * 0 instead — the caller logs it. Interactive writes keep the 400 (assertNsfLinesUntaxed).
 * @returns the rate to bill and whether it was zeroed
 */
export function nsfSafeTaxRate(item: { taxRate?: unknown; description?: string | null }): {
  taxRate: number;
  zeroed: boolean;
} {
  const rate = Number(item.taxRate ?? 0) || 0;
  if (rate > 0 && isNsfLine({ systemKind: null, description: item.description ?? null }))
    return { taxRate: 0, zeroed: true };
  return { taxRate: rate, zeroed: false };
}
