import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** The minimal client surface the guard reads; the raw client and a transaction both satisfy it. */
export interface RegulatedRecordsDb {
  regulatedSalesLedger: { findFirst(args: any): Promise<unknown> };
  tobaccoReport: { findFirst(args: any): Promise<unknown> };
  regulatedFiling: { findFirst(args: any): Promise<unknown> };
}

export const FINANCIAL_WIPE_BLOCKED_REGULATED_MESSAGE =
  "This business has regulated sales records (tobacco or tracked products) that must be kept, so financial data can't be cleared here. Contact support.";

/**
 * 683 (SA-896, ruling (b)): the financial wipe deletes invoices, payments and the rest, but the compliance records must be
 * kept, and the regulated ledger has no FK to the invoices it describes. So the wipe is REFUSED while the tenant holds ANY
 * `RegulatedSalesLedger` row, `TobaccoReport` or `RegulatedFiling`, in any status. Settling the ledger to zero instead would
 * book reversals in the open period: a false negative filing. A tenant with none of these wipes as before.
 * Explicit `tenantId` filters: the wipe runs on the raw client (no tenant proxy).
 */
export async function assertNoRegulatedRecords(
  db: RegulatedRecordsDb,
  tenantId: string,
): Promise<void> {
  const where = { where: { tenantId }, select: { id: true } };
  const held =
    (await db.regulatedSalesLedger.findFirst(where)) ??
    (await db.tobaccoReport.findFirst(where)) ??
    (await db.regulatedFiling.findFirst(where));
  if (held) {
    throw new ConflictException({
      code: API_ERROR_CODES.FINANCIAL_WIPE_BLOCKED_REGULATED,
      message: FINANCIAL_WIPE_BLOCKED_REGULATED_MESSAGE,
    });
  }
}
