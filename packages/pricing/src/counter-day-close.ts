import { roundMoney } from "./pricing";

// ─── Counter sale DAY CLOSE + Z REPORT — the web screen <-> API contract ────────────────────────────────────────────
//
// One close per (tenant, register) window; the window runs close-to-close (the first one starts at the start of the tenant-zone
// day of its cutoff). The close stores a SNAPSHOT: the cash drawer count, the expected cash, the variance and a summary of the
// window's money (never rows, never customer names). Routes (OPERATOR, tenant-scoped, all refused with COUNTER_SALES_DISABLED
// when the tenant has counter sales off):
//   GET  /orders/counter-sale/day-close?registerKey=     the state: the last close, sales since, and a live preview
//   POST /orders/counter-sale/day-close                  close the window (first close of a window; 409 DAY_ALREADY_CLOSED on a race)
//   POST /orders/counter-sale/day-close/:id/reopen       reopen the latest close (OPERATOR or TENANT_ADMIN)
//   POST /orders/counter-sale/day-close/:id/report       send the Z report again
// A re-close is POST day-close while the latest close is reopened: it recomputes over the SAME stored window, never moves the
// cutoff, and changes only the counted drawer, the denominations and the notes. After a close, a payment or refund dated inside the
// closed window is refused with 409 COUNTER_SALE_DAY_CLOSED. The server and the web screen import this one file; the server
// recomputes every figure, so a client `expected` or `counted` is ignored. It lives in @routeflow/pricing because the API never
// value-imports @routeflow/types (L-261).

/** Bill face values in dollars, largest first. */
export const DAY_CLOSE_BILLS = [100, 50, 20, 10, 5, 2, 1] as const;
/** Coin face values in dollars, largest first. The $1 bill and the $1 coin are different rows. */
export const DAY_CLOSE_COINS = [1, 0.25, 0.1, 0.05, 0.01] as const;
/** Most of one denomination in a drawer (whole counts, 0..this). */
export const DAY_CLOSE_MAX_COUNT = 100_000;
/** Longest note. */
export const DAY_CLOSE_NOTES_MAX = 500;
/** The opening float is whole cents, 0..this (it fits the money column). */
export const DAY_CLOSE_MAX_FLOAT = 1_000_000;

export type DenominationKind = "bill" | "coin";

export interface DenominationCount {
  kind: DenominationKind;
  value: number;
  count: number;
}

/** Every counted row the form shows, in display order. */
export const DAY_CLOSE_DENOMINATIONS: ReadonlyArray<{ kind: DenominationKind; value: number }> = [
  ...DAY_CLOSE_BILLS.map((value) => ({ kind: "bill" as const, value })),
  ...DAY_CLOSE_COINS.map((value) => ({ kind: "coin" as const, value })),
];

/** Σ roundMoney(value × count): `0.10 × 3` is `0.30`, never `0.30000000000000004`. */
export function sumDenominations(rows: ReadonlyArray<DenominationCount>): number {
  return roundMoney(rows.reduce((sum, r) => sum + roundMoney(r.value * r.count), 0));
}

/**
 * Validates and normalises the counted denominations the server accepts: a list of {kind, value, count} where (kind, value) is
 * one of the listed rows, each at most once, `count` a whole number 0..{@link DAY_CLOSE_MAX_COUNT}. Zero counts are dropped.
 * Returns the rows in display order, or null for anything else (an unlisted value, a duplicate, a fraction, a negative).
 */
export function validateDenominations(raw: unknown): DenominationCount[] | null {
  if (!Array.isArray(raw) || raw.length > DAY_CLOSE_DENOMINATIONS.length) return null;
  const seen = new Set<string>();
  const out: DenominationCount[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const { kind, value, count } = r as Record<string, unknown>;
    if (kind !== "bill" && kind !== "coin") return null;
    if (typeof value !== "number") return null;
    const listed = DAY_CLOSE_DENOMINATIONS.some((d) => d.kind === kind && d.value === value);
    const key = `${kind}:${value}`;
    if (!listed || seen.has(key)) return null;
    seen.add(key);
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > DAY_CLOSE_MAX_COUNT
    ) {
      return null;
    }
    if (count > 0) out.push({ kind, value, count });
  }
  const order = (d: DenominationCount) =>
    DAY_CLOSE_DENOMINATIONS.findIndex((x) => x.kind === d.kind && x.value === d.value);
  return out.sort((a, b) => order(a) - order(b));
}

/** The opening float: whole cents, 0..{@link DAY_CLOSE_MAX_FLOAT}. */
export function validOpeningFloat(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    n >= 0 &&
    n <= DAY_CLOSE_MAX_FLOAT &&
    roundMoney(n) === n
  );
}

// ─── The stored / emailed summary ───────────────────────────────────────────────────────────────────────────────────

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

/**
 * True when nothing at all happened in the window: no sale, no money in, no refund, no store credit, nothing taken off the till.
 * A second close of the same day is refused for such a window (a double click, or nothing new to count), and the web hides the
 * button for it. One definition so the server and the screen cannot disagree.
 */
export function dayCloseWindowIsEmpty(t: DayCloseTotals): boolean {
  return (
    t.salesCount === 0 &&
    t.moneyIn.total === 0 &&
    t.refunds.count === 0 &&
    t.storeCreditUsed === 0 &&
    t.storeCreditIssued.count === 0 &&
    t.notAtTill === 0
  );
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
