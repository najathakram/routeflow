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
// closed window is refused with 409 COUNTER_SALE_DAY_CLOSED. The server and the web screen import this one file for the money
// math; the server recomputes every figure, so a client `expected` or `counted` is ignored. It lives in @routeflow/pricing because
// the API never value-imports @routeflow/types (L-261); the request/response DTOs live in packages/types/api/counter-day-close.ts.

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

/** A counted denomination row. The shared DTO shape (`DenominationCount`) lives in @routeflow/types; this is its structural twin. */
type DenominationKindLocal = "bill" | "coin";
interface DenominationRow {
  kind: DenominationKindLocal;
  value: number;
  count: number;
}

/** Every counted row the form shows, in display order. */
export const DAY_CLOSE_DENOMINATIONS: ReadonlyArray<{
  kind: DenominationKindLocal;
  value: number;
}> = [
  ...DAY_CLOSE_BILLS.map((value) => ({ kind: "bill" as const, value })),
  ...DAY_CLOSE_COINS.map((value) => ({ kind: "coin" as const, value })),
];

/** Σ roundMoney(value × count): `0.10 × 3` is `0.30`, never `0.30000000000000004`. */
export function sumDenominations(rows: ReadonlyArray<DenominationRow>): number {
  return roundMoney(rows.reduce((sum, r) => sum + roundMoney(r.value * r.count), 0));
}

/**
 * Validates and normalises the counted denominations the server accepts: a list of {kind, value, count} where (kind, value) is
 * one of the listed rows, each at most once, `count` a whole number 0..{@link DAY_CLOSE_MAX_COUNT}. Zero counts are dropped.
 * Returns the rows in display order, or null for anything else (an unlisted value, a duplicate, a fraction, a negative).
 */
export function validateDenominations(raw: unknown): DenominationRow[] | null {
  if (!Array.isArray(raw) || raw.length > DAY_CLOSE_DENOMINATIONS.length) return null;
  const seen = new Set<string>();
  const out: DenominationRow[] = [];
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
  const order = (d: DenominationRow) =>
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

/** The slice of the close's totals the empty-window rule reads (structurally a `DayCloseTotals` from @routeflow/types). */
interface DayCloseWindowTotals {
  salesCount: number;
  moneyIn: { total: number };
  refunds: { count: number };
  storeCreditUsed: number;
  storeCreditIssued: { count: number };
  notAtTill: number;
  /** absent on closes made before the field existed */
  handOver?: { count: number };
}

/**
 * True when nothing at all happened in the window: no sale, no money in, no refund, no store credit, nothing taken off the till.
 * A second close of the same day is refused for such a window (a double click, or nothing new to count), and the web hides the
 * button for it. One definition so the server and the screen cannot disagree.
 */
export function dayCloseWindowIsEmpty(t: DayCloseWindowTotals): boolean {
  return (
    t.salesCount === 0 &&
    t.moneyIn.total === 0 &&
    t.refunds.count === 0 &&
    t.storeCreditUsed === 0 &&
    t.storeCreditIssued.count === 0 &&
    t.notAtTill === 0 &&
    (t.handOver?.count ?? 0) === 0
  );
}

/**
 * The Z report's "Cash from sales" line: the cash taken at the till in the window, before the float and before cash refunds.
 * The stored close carries `expectedCash` (= openingFloat + tillCash - cashRefunds, computed by the server) and the refunds by
 * tender, so the line is derived once, here, for the email and the screen alike: expectedCash - openingFloat + cash refunds.
 */
export function dayCloseCashFromSales(
  expectedCash: number,
  openingFloat: number,
  cashRefunds: number,
): number {
  return roundMoney(expectedCash - openingFloat + cashRefunds);
}

// ─── The Z report, in the order the flow plan fixes (SA-750r3 §4) ─────────────────────────────────────────────────────
//
// ONE definition of what a Z report shows and in what order, used by the Z email (API) and the screen (web), so they cannot
// drift. Pure data: the renderers format money and write the date/time/closer lines themselves. Every row is always present
// (a zero prints as $0.00, never a dash); only a figure that was NEVER recorded (a close made before the field existed) is
// `amount: null`, which the renderer prints as "Not recorded".

export interface ZReportInput {
  openingFloat: number;
  expectedCash: number;
  countedCash: number;
  variance: number;
  totals: {
    moneyIn: { cash: number; card: number; check: number; other: number; total: number };
    refunds: {
      cash: number;
      card: number;
      check: number;
      other: number;
      total: number;
      tenderKnown: boolean;
    };
    storeCreditUsed: number;
    storeCreditIssued: { amount: number };
    onAccount: number;
    netCollected: number;
    notAtTill: number;
    handOver?: { count: number; cash: number };
  };
}

export interface ZRow {
  label: string;
  /** dollars; null = never recorded (print "Not recorded") */
  amount: number | null;
  /** a count shown beside the amount, e.g. the number of pickup hand-overs */
  count?: number;
  bold?: boolean;
  /** an over/short row is signed: positive = over, negative = short */
  signed?: boolean;
}
export interface ZGroup {
  heading: string;
  rows: ZRow[];
}
export interface ZSections {
  /** "Counted $412.50 · Short $2.50" / "Even $0.00" / "Over $1.00" */
  headline: { counted: number; verdict: "short" | "even" | "over"; amount: number };
  groups: ZGroup[];
  /** false -> print "Some refunds have no method. Expected cash may be high." */
  refundsTenderKnown: boolean;
}

/**
 * "Thu, Oct 9" from a close's own calendar date ("YYYY-MM-DD"): the Z report's date on the screen title and in the Z email
 * (title and subject). Read as a calendar date at UTC noon so no tenant zone can shift it; a malformed date is returned as is.
 */
export function dayCloseDateLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/**
 * The ONE variance wording (owner ruling 10-12), on the count form, the closed card, the Z report and the Z email:
 * "Balanced", "Short $2.50" or "Over $1.00". `amount` is the already-formatted magnitude (each surface formats money its own
 * way); a balanced drawer carries none. Never "Even", "Under" or "Over/short".
 */
export function dayCloseVerdictText(
  verdict: ZSections["headline"]["verdict"],
  amount: string,
): string {
  if (verdict === "even") return "Balanced";
  return `${verdict === "short" ? "Short" : "Over"} ${amount}`;
}

/** "1 hand-over" / "3 hand-overs": the count beside the hand-over cash on the Z report and the Z email. */
export function dayCloseHandOvers(count: number): string {
  return count === 1 ? "1 hand-over" : `${count} hand-overs`;
}

export function dayCloseZSections(s: ZReportInput): ZSections {
  const t = s.totals;
  const variance = roundMoney(s.variance);
  return {
    headline: {
      counted: roundMoney(s.countedCash),
      verdict: variance < 0 ? "short" : variance > 0 ? "over" : "even",
      amount: Math.abs(variance),
    },
    groups: [
      {
        heading: "Drawer",
        rows: [
          { label: "Opening float", amount: s.openingFloat },
          {
            label: "Cash from sales",
            amount: dayCloseCashFromSales(s.expectedCash, s.openingFloat, t.refunds.cash),
          },
          { label: "Expected cash", amount: s.expectedCash, bold: true },
          { label: "Counted", amount: s.countedCash },
          { label: "Variance", amount: variance, signed: true },
          // money on a counter sale that the till did not take (an office payment, a pickup still unpaid): part of the drawer's story
          { label: "Unpaid pickups", amount: t.notAtTill },
        ],
      },
      {
        heading: "Money in",
        rows: [
          { label: "Cash", amount: t.moneyIn.cash },
          { label: "Card", amount: t.moneyIn.card },
          { label: "Check", amount: t.moneyIn.check },
          { label: "Other", amount: t.moneyIn.other },
          { label: "Total", amount: t.moneyIn.total },
          t.handOver
            ? {
                label: "Pickup hand-overs (in till cash)",
                amount: t.handOver.cash,
                count: t.handOver.count,
              }
            : { label: "Pickup hand-overs (in till cash)", amount: null },
        ],
      },
      {
        heading: "Credit & account",
        rows: [
          { label: "Store credit used", amount: t.storeCreditUsed },
          { label: "Store credit issued", amount: t.storeCreditIssued.amount },
          { label: "On account", amount: t.onAccount },
        ],
      },
      {
        heading: "Refunds & net",
        rows: [
          { label: "Cash refunds", amount: t.refunds.cash },
          { label: "Card refunds", amount: t.refunds.card },
          { label: "Check refunds", amount: t.refunds.check },
          { label: "Other refunds", amount: t.refunds.other },
          { label: "Net collected", amount: t.netCollected, bold: true },
        ],
      },
    ],
    refundsTenderKnown: t.refunds.tenderKnown,
  };
}
