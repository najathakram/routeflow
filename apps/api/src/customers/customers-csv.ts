import { roundMoney } from "@routeflow/pricing";
import { csvCell } from "../common/csv";

export interface CustomerCsvRow {
  businessName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  customerType: string | null;
  status?: string | null;
  /** Sum of receivableBalance per invoice (computed by the caller). */
  receivables: number;
  /** Sum of open advance-payment balances (computed by the caller). */
  credits: number;
}

export const CUSTOMERS_CSV_HEADER =
  "Business Name,Contact Name,Email,Phone,Customer Type,Status,Receivables,Credits";

/**
 * The customers export format (B953). Names, emails and phones are user-typed, so every text cell
 * goes through the canonical guarded cell (common/csv.ts: a formula-led value gets an apostrophe; a
 * plain decimal is exempt). The money columns are formatted numbers, written as-is. Lines are joined
 * with "\n" and there is no BOM, exactly as before.
 */
export function buildCustomersCsv(customers: CustomerCsvRow[]): string {
  const rows = customers.map((c) =>
    [
      csvCell(c.businessName),
      csvCell(c.contactName),
      csvCell(c.email),
      csvCell(c.phone),
      csvCell(c.customerType),
      csvCell(c.status),
      roundMoney(c.receivables).toFixed(2),
      c.credits.toFixed(2),
    ].join(","),
  );
  return [CUSTOMERS_CSV_HEADER, ...rows].join("\n");
}
