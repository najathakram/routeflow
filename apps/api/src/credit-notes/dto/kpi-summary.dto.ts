import { Matches } from "class-validator";

/**
 * B238: `GET /credit-notes/kpi-summary` takes the VIEWER's own calendar day
 * (`YYYY-MM-DD`) — the server never derives "today" from its own clock
 * (L-047), matching invoices' KpiSummaryDto (B12) precedent.
 */
export class KpiSummaryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "today must be a YYYY-MM-DD calendar date" })
  today!: string;
}
