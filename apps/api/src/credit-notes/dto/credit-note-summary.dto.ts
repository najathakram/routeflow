import { Matches } from "class-validator";

/**
 * B238: `GET /credit-notes/summary` takes the VIEWER's own calendar day (`YYYY-MM-DD`), as `/invoices/kpi-summary` does (B12):
 * the server never derives "today" from its own clock (L-047), so the "last 30 days" tile agrees with the viewer's date.
 */
export class CreditNoteSummaryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "today must be a YYYY-MM-DD calendar date" })
  today!: string;
}
