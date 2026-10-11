// ─── Counter day close + Z report: the DTOs (web, mobile and API) ───────────────────────────────────────────────────
//
// The money math (denominations, the sum, the validators, the empty-window rule) lives in @routeflow/pricing; these are the
// request/response shapes the screen and the API share. The API imports them type-only (L-261).

export type DenominationKind = "bill" | "coin";

export interface DenominationCount {
  kind: DenominationKind;
  value: number;
  count: number;
}

/**
 * The summary of one window. NEVER rows, NEVER customer names. It is the Today's-sales fold over the close window instead of
 * the calendar day, with the till-cash rules applied (a payment counts as till cash only on a counter tender row of this
 * register) and what was NOT taken at the till shown apart.
 */
export interface DayCloseTotals {
  /** live counter sales rung in the window */
  salesCount: number;
  salesTotal: number;
  /** PAID money that came in at the till in the window, by method */
  moneyIn: { cash: number; card: number; check: number; other: number; total: number };
  refunds: {
    count: number;
    cash: number;
    card: number;
    check: number;
    other: number;
    total: number;
    /** false while ANY refund in the window has no recorded tender (it sits in `other`, never subtracted from the drawer) */
    tenderKnown: boolean;
    unknownTenderCount: number;
  };
  /** credit-note and advance applications in the window: NOT money in */
  storeCreditUsed: number;
  storeCreditIssued: { count: number; amount: number };
  /** the window's sales total minus everything paid on those sales, never below 0 */
  onAccount: number;
  /** moneyIn.total - refunds.total */
  netCollected: number;
  /** payments on counter invoices taken at the office or by a driver (not at this till): shown, never in the expected cash */
  notAtTill: number;
}

export interface DayCloseSnapshot {
  id: string;
  registerKey: string;
  /** the tenant-zone date of the cutoff ("YYYY-MM-DD"): a label, not a key */
  day: string;
  /** the IANA zone the window was cut in */
  zone: string;
  windowStart: string;
  windowEnd: string;
  closedAt: string;
  closedById: string | null;
  closedByName: string | null;
  openingFloat: number;
  /** openingFloat + till cash - cash refunds, computed by the server */
  expectedCash: number;
  /** from the denominations, computed by the server */
  countedCash: number;
  /** countedCash - expectedCash */
  variance: number;
  denominations: DenominationCount[];
  totals: DayCloseTotals;
  notes: string | null;
  reopenedAt: string | null;
  reopenedById: string | null;
  /** the Z report email: true = sent to the admins, false = it did not go ("Report not sent - Resend"), null = never attempted */
  reportSent: boolean | null;
}

/** The live figures for the open window, so the form can show expected and variance as the drawer is counted. */
export interface DayClosePreview {
  windowStart: string;
  /** "now": the real cutoff is taken at close, so the final figures can differ by sales rung meanwhile */
  windowEnd: string;
  /** the last close's float for this register, else 0 */
  suggestedOpeningFloat: number;
  /** cash taken at this till in the window (before the float) */
  tillCash: number;
  cashRefunds: number;
  totals: DayCloseTotals;
}

export interface DayCloseState {
  registerKey: string;
  zone: string;
  /** the latest close for this register (open or reopened), null before the first */
  lastClose: DayCloseSnapshot | null;
  /** counter sales rung after the last close's cutoff */
  salesSince: number;
  /** the window the next close (or the re-close of a reopened one) would cover */
  preview: DayClosePreview;
}

/** POST /orders/counter-sale/day-close */
export interface DayCloseRequest {
  openingFloat: number;
  denominations: DenominationCount[];
  notes?: string;
  registerKey?: string;
}
