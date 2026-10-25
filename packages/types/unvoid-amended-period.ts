/**
 * SA-839 §3 / G7: an unvoid books the restored sale in the CURRENT month (never into the sale's or the
 * void's month). When the void sat in a month whose regulated filing is already GENERATED or LOCKED, the
 * unvoid response carries that period (`amendedPeriod`, the SA-182 `FiledPeriod` shape) and the success
 * toast adds one line saying so. Web and mobile both build the line here.
 */

/** A filed (GENERATED or LOCKED) regulated filing period, as the API returns it. */
export interface FiledPeriod {
  periodKey: string; // "YYYY-MM"
  status: string;
  trackedCategoryId: string;
}

/** POST /invoices/:id/unvoid: the restored DRAFT invoice plus the filed month of the void it undid. */
export interface UnvoidInvoiceResult {
  amendedPeriod?: FiledPeriod | null;
}

const monthLabel = (year: number, monthIndex: number): string =>
  new Date(Date.UTC(year, monthIndex, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** The extra toast line, or null when the void's month is not filed (or the shape is unreadable). */
export function unvoidAmendedPeriodNote(
  amendedPeriod: FiledPeriod | null | undefined,
  now: Date = new Date(),
): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(amendedPeriod?.periodKey ?? "");
  if (!m) return null;
  const voidMonth = monthLabel(Number(m[1]), Number(m[2]) - 1);
  // The ledger books in UTC months (regulated/period.ts periodBucketOf).
  const bookedMonth = monthLabel(now.getUTCFullYear(), now.getUTCMonth());
  return `Restored. The void was in ${voidMonth}, which is already filed. This sale is booked in ${bookedMonth}; an amended return for ${voidMonth} may be needed.`;
}

/**
 * SA-839 §3, the undo twin: a cancelled return or a voided credit note whose regulated reversal sat in
 * a FILED month. The correction books in the current month; the response carries `amendedPeriod`.
 */
export function undoAmendedPeriodNote(
  amendedPeriod: FiledPeriod | null | undefined,
  what: "return" | "credit note",
  now: Date = new Date(),
): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(amendedPeriod?.periodKey ?? "");
  if (!m) return null;
  const filedMonth = monthLabel(Number(m[1]), Number(m[2]) - 1);
  const bookedMonth = monthLabel(now.getUTCFullYear(), now.getUTCMonth());
  return `This ${what} was in the ${filedMonth} filing, which is already filed. The correction is booked in ${bookedMonth}; an amended return for ${filedMonth} may be needed.`;
}
