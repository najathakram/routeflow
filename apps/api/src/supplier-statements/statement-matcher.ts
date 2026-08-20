import { roundMoney } from "../common/pricing";
import { normalizeInvoiceNumber } from "../import/duplicate-match.service";
import type { ParsedStatementLine } from "./dto/statement.dto";

/**
 * Deterministic reconciliation matching — PURE, no model call, no Prisma
 * import. The service fetches the candidate bills and the parsed lines; this
 * module only compares numbers it is handed. Money-critical logic lives here
 * specifically so it is auditable and unit-testable without mocking an SDK
 * or a database.
 */
export type MatchTier = "EXACT_REF" | "FUZZY" | "UNMATCHED";

/** Enough of a VendorBill to match against — the service selects this shape. */
export interface MatchableBill {
  id: string;
  billNumber: string;
  supplierInvoiceNumber: string | null;
  totalOwed: number;
  billDate: Date | string | null;
  /** VOID bills are filtered out internally regardless of what the caller passes. */
  status: string;
}

export interface StatementLineMatch {
  line: ParsedStatementLine;
  tier: MatchTier;
  billId: string | null;
  candidates: { billId: string; billNumber: string; total: number; date: string | null }[];
  /** Only an EXACT_REF match whose amount also agrees is pre-checked. */
  preChecked: boolean;
}

export interface MatchStatementLinesOptions {
  openingBalance?: number | null;
  closingBalance?: number | null;
}

/** Decimal(10,2)-ish money columns compared as floats — same window as duplicate-match.service.ts. */
const AMOUNT_TOLERANCE = 0.005;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Closing-balance sanity guard tolerance — a full cent of drift is suspect. */
const CLOSING_BALANCE_TOLERANCE = 0.01;

const TIER_RANK: Record<MatchTier, number> = { EXACT_REF: 0, FUZZY: 1, UNMATCHED: 2 };

function toIsoDateOrNull(date: Date | string | null): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Absolute difference in whole days between a line's date and a bill's date, or null if either is unusable. */
function dateDiffDays(lineDate: string | null, billDate: Date | string | null): number | null {
  if (!lineDate || !billDate) return null;
  const lineMs = Date.parse(lineDate);
  const billMs = billDate instanceof Date ? billDate.getTime() : Date.parse(String(billDate));
  if (!Number.isFinite(lineMs) || !Number.isFinite(billMs)) return null;
  return Math.abs(lineMs - billMs) / DAY_MS;
}

function candidateShape(bill: MatchableBill) {
  return {
    billId: bill.id,
    billNumber: bill.billNumber,
    total: bill.totalOwed,
    date: toIsoDateOrNull(bill.billDate),
  };
}

/**
 * Signed contribution of one statement line to the running balance: an
 * INVOICE increases what we owe the supplier, a PAYMENT or CREDIT reduces it.
 * ADJUSTMENT carries its own sign from the model (it can move the balance
 * either way) and is passed through as parsed rather than forced positive.
 */
function signedAmount(line: ParsedStatementLine): number {
  const amount = Number(line.amount) || 0;
  switch (line.kind) {
    case "INVOICE":
      return Math.abs(amount);
    case "PAYMENT":
    case "CREDIT":
      return -Math.abs(amount);
    case "ADJUSTMENT":
    default:
      return amount;
  }
}

function sumSigned(lines: ParsedStatementLine[]): number {
  return roundMoney(lines.reduce((sum, line) => sum + signedAmount(line), 0));
}

/**
 * Match every statement line against the supplier's candidate bills, in three
 * tiers of decreasing confidence:
 *
 *  1. EXACT_REF — the line's normalized ref number equals a bill's normalized
 *     `supplierInvoiceNumber`. Pre-checked only when the amount also agrees
 *     within `AMOUNT_TOLERANCE`; an exact ref with a differing amount stays
 *     EXACT_REF (it IS the right document) but is never pre-checked.
 *  2. FUZZY — amount agrees within `AMOUNT_TOLERANCE` AND the date is within
 *     ±1 day. Never pre-checked; always needs a look.
 *  3. UNMATCHED — everything else.
 *
 * A bill may be the PRIMARY match (`billId` / pre-check target) of at most
 * one line: collisions are resolved by preferring the higher tier, then the
 * closer amount, then the closer date, then the earlier line, then bill id —
 * fully deterministic so the same input always resolves the same way. Losing
 * candidates stay visible in `candidates` for the review screen's picker.
 *
 * VOID bills are never candidates, whatever the caller passes in.
 *
 * Finally, a closing-balance sanity guard: if the parsed lines don't
 * reconcile to the statement's own stated closing balance, the read is
 * suspect, so EVERY row is demoted out of `preChecked` rather than trusting a
 * pre-check we can't verify. The model proposes; it never auto-applies.
 */
export function matchStatementLines(
  lines: ParsedStatementLine[],
  bills: MatchableBill[],
  options: MatchStatementLinesOptions = {},
): StatementLineMatch[] {
  const activeBills = bills.filter((bill) => bill.status !== "VOID");

  interface Candidate {
    bill: MatchableBill;
    amountDiff: number;
    dateDiff: number | null;
  }
  interface LineEntry {
    index: number;
    line: ParsedStatementLine;
    tier: MatchTier;
    candidates: Candidate[];
  }

  const perLine: LineEntry[] = lines.map((line, index): LineEntry => {
    const lineAmount = Math.abs(Number(line.amount) || 0);
    const refTarget = line.refNumber ? normalizeInvoiceNumber(line.refNumber) : "";

    if (refTarget) {
      const exact = activeBills.filter(
        (bill) =>
          bill.supplierInvoiceNumber &&
          normalizeInvoiceNumber(bill.supplierInvoiceNumber) === refTarget,
      );
      if (exact.length > 0) {
        return {
          index,
          line,
          tier: "EXACT_REF",
          candidates: exact.map((bill) => ({
            bill,
            amountDiff: Math.abs(bill.totalOwed - lineAmount),
            dateDiff: dateDiffDays(line.date, bill.billDate),
          })),
        };
      }
    }

    const fuzzy = activeBills
      .map((bill) => ({
        bill,
        amountDiff: Math.abs(bill.totalOwed - lineAmount),
        dateDiff: dateDiffDays(line.date, bill.billDate),
      }))
      .filter((c) => c.amountDiff <= AMOUNT_TOLERANCE && c.dateDiff !== null && c.dateDiff <= 1);
    if (fuzzy.length > 0) {
      return { index, line, tier: "FUZZY", candidates: fuzzy };
    }

    return { index, line, tier: "UNMATCHED", candidates: [] };
  });

  // Global, deterministic collision resolution for the PRIMARY pick only —
  // `candidates` below stays un-deduped so the review screen's picker can
  // still offer a bill that another line ended up winning.
  interface Opportunity {
    lineIndex: number;
    billId: string;
    tier: MatchTier;
    amountDiff: number;
    dateDiff: number;
  }
  const opportunities: Opportunity[] = [];
  for (const entry of perLine) {
    for (const c of entry.candidates) {
      opportunities.push({
        lineIndex: entry.index,
        billId: c.bill.id,
        tier: entry.tier,
        amountDiff: c.amountDiff,
        dateDiff: c.dateDiff ?? Number.POSITIVE_INFINITY,
      });
    }
  }
  opportunities.sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (a.amountDiff !== b.amountDiff) return a.amountDiff - b.amountDiff;
    if (a.dateDiff !== b.dateDiff) return a.dateDiff - b.dateDiff;
    if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
    return a.billId.localeCompare(b.billId);
  });

  const claimedBills = new Set<string>();
  const primaryPick = new Map<number, { billId: string; tier: MatchTier; amountDiff: number }>();
  for (const opp of opportunities) {
    if (primaryPick.has(opp.lineIndex) || claimedBills.has(opp.billId)) continue;
    primaryPick.set(opp.lineIndex, {
      billId: opp.billId,
      tier: opp.tier,
      amountDiff: opp.amountDiff,
    });
    claimedBills.add(opp.billId);
  }

  const matches: StatementLineMatch[] = perLine.map((entry) => {
    const pick = primaryPick.get(entry.index);
    const preChecked =
      pick !== undefined && pick.tier === "EXACT_REF" && pick.amountDiff <= AMOUNT_TOLERANCE;
    return {
      line: entry.line,
      tier: entry.tier,
      billId: pick?.billId ?? null,
      candidates: entry.candidates.map((c) => candidateShape(c.bill)),
      preChecked,
    };
  });

  const { openingBalance = null, closingBalance = null } = options;
  const linesAgree =
    closingBalance == null ||
    Math.abs(roundMoney(openingBalance ?? 0) + sumSigned(lines) - roundMoney(closingBalance)) <=
      CLOSING_BALANCE_TOLERANCE;
  if (!linesAgree) matches.forEach((m) => (m.preChecked = false));

  return matches;
}
