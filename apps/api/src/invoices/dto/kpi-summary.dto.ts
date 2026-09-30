import { Matches } from "class-validator";

/**
 * B12: `GET /invoices/kpi-summary` takes the VIEWER's own calendar day
 * (`YYYY-MM-DD`) — the server never derives "today" from its own clock
 * (L-047), so the KPI tiles agree with the client's due-soon chips.
 */
export class KpiSummaryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "today must be a YYYY-MM-DD calendar date" })
  today!: string;
}
