import { tenantTodayDay } from "../common/calendar-date";
import { csvCell } from "../common/csv";

export const PAYMENTS_CSV_HEADER =
  "Payment#,Date,Bank Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status";

/**
 * The payments export (B953). Every text cell goes through the canonical guarded cell
 * (common/csv.ts); Bank Charges and Amount are `toFixed(2)` strings, so a negative amount
 * ("-12.50") hits the plain-decimal exemption and is never prefixed. Lines are joined with "\n",
 * no BOM, exactly as before.
 *
 * Date and Bank Date are REAL instants (SA-943), so they print as the tenant's calendar day in
 * `zone` (the zone the export's own day filter uses); a null zone prints the UTC day.
 */
export function buildPaymentsCsv(rows: any[], zone: string | null = null): string {
  const cell = (v: string | number | null | undefined) => csvCell(v == null ? "" : String(v));
  const lines = rows.map((r) =>
    [
      cell(r.paymentNumber ?? ""),
      cell(r.paidAt ? tenantTodayDay(zone, new Date(r.paidAt)) : ""),
      cell(r.settledAt ? tenantTodayDay(zone, new Date(r.settledAt)) : ""),
      cell(r.invoice?.customer?.businessName ?? ""),
      cell(r.invoice?.invoiceNumber ?? ""),
      cell(r.method ?? ""),
      cell(r.reference ?? ""),
      cell(r.bankCharges != null ? Number(r.bankCharges).toFixed(2) : ""),
      cell(Number(r.amount).toFixed(2)),
      cell(r.status ?? ""),
    ].join(","),
  );
  return [PAYMENTS_CSV_HEADER, ...lines].join("\n");
}
