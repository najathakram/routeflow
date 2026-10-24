import { csvCell } from "../common/csv";

export const PAYMENTS_CSV_HEADER =
  "Payment#,Date,Bank Date,Customer,Invoice#,Method,Reference,Bank Charges,Amount,Status";

/**
 * The payments export (B953). Every text cell goes through the canonical guarded cell
 * (common/csv.ts); Bank Charges and Amount are `toFixed(2)` strings, so a negative amount
 * ("-12.50") hits the plain-decimal exemption and is never prefixed. Lines are joined with "\n",
 * no BOM, exactly as before.
 */
export function buildPaymentsCsv(rows: any[]): string {
  const cell = (v: string | number | null | undefined) => csvCell(v == null ? "" : String(v));
  const lines = rows.map((r) =>
    [
      cell(r.paymentNumber ?? ""),
      cell(r.paidAt ? new Date(r.paidAt).toISOString().split("T")[0] : ""),
      cell(r.settledAt ? new Date(r.settledAt).toISOString().split("T")[0] : ""),
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
