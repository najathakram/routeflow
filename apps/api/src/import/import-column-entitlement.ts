import { ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** Longest `column` carried in the 403 body: a header is the user's own text, data only, never a server sentence. */
export const ENTITLEMENT_COLUMN_MAX = 120;

export type EntitlementColumn = "MSRP" | "TOBACCO_DEALER" | "FORECASTING";

/**
 * B987-E (c): the file-level import gate refuses a column whose entitlement the tenant lacks. Status (403) and `message`
 * are exactly what the import sent before; the body now also carries a `code` and the structured fields the web needs to
 * show fixed copy (which entitlement, which column). `column` is the user's own CSV header: capped, never rebuilt into a
 * sentence here.
 */
export function columnEntitlementDenied(
  requires: EntitlementColumn,
  column: string,
  message: string,
): ForbiddenException {
  return new ForbiddenException({
    code: API_ERROR_CODES.IMPORT_COLUMN_NEEDS_ENTITLEMENT,
    message,
    requires,
    column: column.slice(0, ENTITLEMENT_COLUMN_MAX),
  });
}
