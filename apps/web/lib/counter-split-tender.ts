import {
  TENDER_RULES,
  centsToDollars,
  dollarsToCents,
  planTenderLegs,
  roundMoney,
} from "@routeflow/pricing";
import {
  API_ERROR_CODES,
  type CounterSalePayment,
  type CounterSalePaymentMethod,
  type CounterSaleRequest,
} from "@routeflow/types";

/**
 * Split payment at the counter (pure logic; no React). The rules are READ from `TENDER_RULES.counter` in
 * @routeflow/pricing (max legs, one cash line, On account alone); every figure is INTEGER CENTS until it is written to the
 * wire, where it goes out as decimal dollars exactly like the single `payment.amount` does (`roundMoney(cents / 100)`).
 */

export const SPLIT_RULE = TENDER_RULES.counter;

// The wire codes of the split-payment contract: every one is the shared API_ERROR_CODES constant.
export const SPLIT_CODES = {
  COUNTER_TOO_MANY_LEGS: API_ERROR_CODES.COUNTER_TOO_MANY_LEGS,
  TENDER_METHOD_NOT_ALLOWED: API_ERROR_CODES.TENDER_METHOD_NOT_ALLOWED,
  COUNTER_ON_ACCOUNT_NOT_SPLIT: API_ERROR_CODES.COUNTER_ON_ACCOUNT_NOT_SPLIT,
  COUNTER_DUPLICATE_CASH_LEG: API_ERROR_CODES.COUNTER_DUPLICATE_CASH_LEG,
  COUNTER_CHECK_NUMBER_REQUIRED: API_ERROR_CODES.COUNTER_CHECK_NUMBER_REQUIRED,
  COUNTER_LEG_AMOUNT_REQUIRED: API_ERROR_CODES.COUNTER_LEG_AMOUNT_REQUIRED,
  COUNTER_LEG_NOT_CENTS: API_ERROR_CODES.COUNTER_LEG_NOT_CENTS,
  COUNTER_PAYMENT_EXCEEDS_TOTAL: API_ERROR_CODES.COUNTER_PAYMENT_EXCEEDS_TOTAL,
  COUNTER_TENDER_SHORT: API_ERROR_CODES.COUNTER_TENDER_SHORT,
  COUNTER_PAYMENT_SHAPE_CONFLICT: API_ERROR_CODES.COUNTER_PAYMENT_SHAPE_CONFLICT,
  COUNTER_TENDER_CHANGED: API_ERROR_CODES.COUNTER_TENDER_CHANGED,
} as const;

/**
 * FIXED copy per code / client problem (the G7 brief's strings, verbatim). The server's own text is never shown. The
 * walk-in "still due" line carries the amount, so the screen builds it with `stillDueCopy`; COUNTER_TENDER_SHORT here is the
 * amount-less line for the server's own 400.
 */
export const SPLIT_PROBLEM_COPY = {
  COUNTER_TOO_MANY_LEGS: `Up to ${SPLIT_RULE.maxLegs} payments per sale.`,
  TENDER_METHOD_NOT_ALLOWED: "That payment method can't be used at the counter.",
  COUNTER_ON_ACCOUNT_NOT_SPLIT:
    "On account can't be combined with other payments. Use it on its own.",
  COUNTER_DUPLICATE_CASH_LEG: "Only one cash payment per sale.",
  COUNTER_CHECK_NUMBER_REQUIRED: "Enter the check number.",
  COUNTER_LEG_AMOUNT_REQUIRED: "Enter an amount on every payment line, or remove the line.",
  COUNTER_LEG_NOT_CENTS: "Enter the amount in dollars and cents.",
  COUNTER_PAYMENT_EXCEEDS_TOTAL: "Card and check can't be more than the total.",
  COUNTER_TENDER_SHORT: "A walk-in customer must pay the full balance.",
  COUNTER_PAYMENT_SHAPE_CONFLICT:
    "This sale can't be completed as entered. Review the payment and try again.",
  COUNTER_TENDER_CHANGED: "This sale was already paid a different way. Check recent sales.",
} as const;
export type SplitPaymentProblem = keyof typeof SPLIT_PROBLEM_COPY;

/** The post-commit over-cover answer (201, `paymentRecorded: false`): the balance fell while the sale was being rung. */
export const COUNTER_BALANCE_CHANGED_COPY = "The balance changed — take the payment again";

/** The fixed copy for a response/error code of the split contract, or null when the code is not one of ours. */
export function splitProblemCopyForCode(code: unknown): string | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(SPLIT_PROBLEM_COPY, code)
    ? SPLIT_PROBLEM_COPY[code as SplitPaymentProblem]
    : null;
}

/** 409 COUNTER_TENDER_CHANGED: the held legs no longer match what is stored. The sale EXISTS; a retry can never succeed. */
export function isCounterTenderChanged(err: unknown): boolean {
  const res = (
    err as { response?: { status?: number; data?: { code?: unknown } } } | null | undefined
  )?.response;
  return res?.status === 409 && res.data?.code === SPLIT_CODES.COUNTER_TENDER_CHANGED;
}

// ─── wire ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One split leg on the wire is the shared `CounterSalePayment` (amount in decimal dollars, whole cents). */
export type SplitWireLeg = CounterSalePayment;

/** What a body rang as its tender: leg 0's method (the server echoes it top-level) and the cash entered, if any. */
export function attemptTender(dto: Pick<CounterSaleRequest, "payment" | "payments">): {
  method: CounterSalePaymentMethod;
  cashAmount: number | null;
} {
  const legs = dto.payments ?? (dto.payment ? [dto.payment] : []);
  const cash = legs.find((l) => l.method === "CASH");
  return { method: legs[0]?.method ?? "CASH", cashAmount: cash?.amount ?? null };
}

// ─── cents ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A sale total (a `roundMoney` figure) to integer cents, through the shared pricing conversion. */
export const totalToCents = (dollars: number): number => dollarsToCents(roundMoney(dollars));

/**
 * "12.5" -> 1250. Empty is 0. Returns null for anything that is not a non-negative amount in whole cents (a letter,
 * a minus sign, three decimals): such an entry is never rounded into a different charge.
 */
export function amountTextToCents(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  const m = /^(\d{0,9})(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return null;
  return Number(m[1] || "0") * 100 + Number(((m[2] ?? "") + "00").slice(0, 2));
}

// ─── leg rows ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SplitLegRow {
  id: string;
  method: CounterSalePaymentMethod;
  /** what the clerk typed, in dollars */
  amount: string;
  /** a check number (CHECK rows only) */
  reference: string;
}

let rowSeq = 0;
const newRow = (method: CounterSalePaymentMethod, amount = "", reference = ""): SplitLegRow => ({
  id: `leg-${++rowSeq}`,
  method,
  amount,
  reference,
});

/** G7: a split opens with two empty lines, Card first, then Cash. */
export const newSplitRows = (): SplitLegRow[] => [newRow("CARD"), newRow("CASH")];

/** Shown only while the sale still has money to take, and never past the shared maximum. */
export const canAddLeg = (rows: readonly SplitLegRow[], remainingCents: number): boolean =>
  rows.length < SPLIT_RULE.maxLegs &&
  remainingCents > 0 &&
  !rows.some((r) => SPLIT_RULE.singleLegOnly.includes(r.method));
/** The "x" shows from two lines up (one line is a plain single payment: "Pay one way" is the way back). */
export const canRemoveLeg = (rows: readonly SplitLegRow[]): boolean => rows.length >= 2;

/** The new line takes the first method that is still allowed (cash while no cash line exists, else card). */
export function addLeg(rows: readonly SplitLegRow[], remainingCents: number): SplitLegRow[] {
  if (!canAddLeg(rows, remainingCents)) return [...rows];
  const hasCash = rows.some((r) => r.method === "CASH");
  return [...rows, newRow(hasCash ? "CARD" : "CASH")];
}
export const removeLeg = (rows: readonly SplitLegRow[], id: string): SplitLegRow[] =>
  canRemoveLeg(rows) ? rows.filter((r) => r.id !== id) : [...rows];
export const patchLeg = (
  rows: readonly SplitLegRow[],
  id: string,
  patch: Partial<Omit<SplitLegRow, "id">>,
): SplitLegRow[] => rows.map((r) => (r.id === id ? { ...r, ...patch } : r));

/**
 * The methods a leg's segment offers: the shared rule's list minus the single-leg-only ones (On account is never part of a
 * split), in the order of the single-payment row.
 */
export const SPLIT_SEGMENT_METHODS: readonly CounterSalePaymentMethod[] = (
  ["CASH", "CARD", "CHECK"] as const
).filter((m) => SPLIT_RULE.allowed.includes(m) && !SPLIT_RULE.singleLegOnly.includes(m));

/** Whether `method` may be picked on line `id`: allowed here, and one cash line at most. */
export function legMethodAllowed(
  rows: readonly SplitLegRow[],
  id: string,
  method: CounterSalePaymentMethod,
): boolean {
  if (!SPLIT_SEGMENT_METHODS.includes(method)) return false;
  if (method === "CASH" && SPLIT_RULE.maxCashLegs <= 1)
    return !rows.some((r) => r.id !== id && r.method === "CASH");
  return true;
}

/**
 * "Pay one way": the split closes onto its FIRST line's method; every amount is cleared (the check number of a first
 * check line is kept, it is not an amount).
 */
export function payOneWay(rows: readonly SplitLegRow[]): {
  method: CounterSalePaymentMethod;
  reference: string;
} {
  const first = rows[0];
  return {
    method: first?.method ?? "CASH",
    reference: first?.method === "CHECK" ? first.reference : "",
  };
}

// ─── the live summary ──────────────────────────────────────────────────────────────────────────────────────────────

export const formatCents = (cents: number): string => `$${centsToDollars(cents).toFixed(2)}`;
/** Walk-in short: what the lines still owe, as the inline line under the last leg. */
export const stillDueCopy = (cents: number): string => `${formatCents(cents)} is still due.`;

export interface SplitSummary {
  totalCents: number;
  enteredCents: number;
  /** total minus everything entered, never below 0 */
  remainingCents: number;
  /** cash handed over beyond what the sale still owed */
  changeCents: number;
  /** a named customer's unpaid rest (stays on account); always 0 for a walk-in, who must pay in full */
  leftOnAccountCents: number;
  /** the first rule that stops the sale (a key of SPLIT_PROBLEM_COPY), or null */
  problem: SplitPaymentProblem | null;
  /** the line the problem belongs under; null when it is about the whole sale */
  problemRowId: string | null;
  /** every other rule holds and nothing is left to take (remaining <= $0.00) */
  covered: boolean;
}

const isCash = (r: SplitLegRow) => r.method === "CASH";

/** The lines that go on the wire: those with an amount above zero (an empty line is "not used", never sent), in row order. */
export const activeLegs = (rows: readonly SplitLegRow[]): SplitLegRow[] =>
  rows.filter((r) => (amountTextToCents(r.amount) ?? 1) > 0);

/** Mirrors the server's PRE-WRITE rules over the lines, in the order the server raises them. */
export function summarizeSplit(input: {
  rows: readonly SplitLegRow[];
  totalCents: number;
  isWalkIn: boolean;
}): SplitSummary {
  const { rows, totalCents, isWalkIn } = input;
  const cents = rows.map((r) => amountTextToCents(r.amount));
  const badRow = rows.find((_, i) => cents[i] === null);
  const amountOf = (r: SplitLegRow): number => cents[rows.indexOf(r)] ?? 0;
  const live = activeLegs(rows);
  const enteredCents = live.reduce((s, r) => s + amountOf(r), 0);
  const nonCash = live.reduce((s, r) => (isCash(r) ? s : s + amountOf(r)), 0);
  const cash = live.reduce((s, r) => (isCash(r) ? s + amountOf(r) : s), 0);

  let changeCents = 0;
  if (!badRow && nonCash <= totalCents) {
    changeCents = planTenderLegs(
      [{ id: "sale", balanceCents: totalCents }],
      live.map((r) => ({ method: r.method, amountCents: amountOf(r) })),
    ).changeCents;
  }

  let problem: SplitPaymentProblem | null = null;
  let problemRowId: string | null = null;
  const cashLines = live.filter(isCash);
  if (live.length > SPLIT_RULE.maxLegs) problem = "COUNTER_TOO_MANY_LEGS";
  else if (live.some((r) => !SPLIT_RULE.allowed.includes(r.method)))
    problem = "TENDER_METHOD_NOT_ALLOWED";
  else if (live.length > 1 && live.some((r) => SPLIT_RULE.singleLegOnly.includes(r.method)))
    problem = "COUNTER_ON_ACCOUNT_NOT_SPLIT";
  else if (cashLines.length > SPLIT_RULE.maxCashLegs) {
    problem = "COUNTER_DUPLICATE_CASH_LEG";
    problemRowId = cashLines[SPLIT_RULE.maxCashLegs].id;
  } else if (badRow) {
    problem = "COUNTER_LEG_NOT_CENTS";
    problemRowId = badRow.id;
  } else if (live.length === 0) {
    problem = "COUNTER_LEG_AMOUNT_REQUIRED";
    problemRowId = rows[rows.length - 1]?.id ?? null;
  } else if (live.some((r) => r.method === "CHECK" && !r.reference.trim())) {
    problem = "COUNTER_CHECK_NUMBER_REQUIRED";
    problemRowId = live.find((r) => r.method === "CHECK" && !r.reference.trim())!.id;
  } else if (nonCash > totalCents || (cash > 0 && nonCash >= totalCents)) {
    problem = "COUNTER_PAYMENT_EXCEEDS_TOTAL";
    // the line that tips the non-cash sum over the total; else the cash line that has nothing left to take
    let running = 0;
    const tipping = live.find((r) => {
      if (isCash(r)) return false;
      running += amountOf(r);
      return running > totalCents;
    });
    problemRowId = (tipping ?? cashLines[0]).id;
  } else if (isWalkIn && enteredCents < totalCents) {
    problem = "COUNTER_TENDER_SHORT";
    problemRowId = live[live.length - 1].id;
  }

  const remainingCents = Math.max(0, totalCents - enteredCents);
  return {
    totalCents,
    enteredCents,
    remainingCents,
    changeCents,
    leftOnAccountCents: isWalkIn ? 0 : remainingCents,
    problem,
    problemRowId,
    covered: problem === null && remainingCents === 0,
  };
}

/** Problems the clerk is told about while typing; the rest wait for an attempt to finish (Enter on the last line). */
const LIVE_PROBLEMS: ReadonlySet<SplitPaymentProblem> = new Set([
  "COUNTER_TOO_MANY_LEGS",
  "COUNTER_DUPLICATE_CASH_LEG",
  "COUNTER_LEG_NOT_CENTS",
  "COUNTER_PAYMENT_EXCEEDS_TOTAL",
]);

export interface SplitIssue {
  rowId: string;
  text: string;
}

/**
 * The inline line under a leg, or null. A rule broken by what was typed shows at once; "still due" and the check number
 * wait for an attempt to complete (a fresh split reads "Remaining $70.00", never an error).
 */
export function splitIssue(summary: SplitSummary, attempted: boolean): SplitIssue | null {
  const { problem, problemRowId } = summary;
  if (!problem || !problemRowId) return null;
  if (!LIVE_PROBLEMS.has(problem) && !attempted) return null;
  if (problem === "COUNTER_TENDER_SHORT" || problem === "COUNTER_LEG_AMOUNT_REQUIRED")
    return { rowId: problemRowId, text: stillDueCopy(summary.remainingCents) };
  return { rowId: problemRowId, text: SPLIT_PROBLEM_COPY[problem] };
}

/** The checkout bar's `change-due` slot while split: "Remaining $40.00" -> "Change $10.00" -> "Change $0.00"; never a dash. */
export const splitBarText = (summary: SplitSummary): string =>
  summary.remainingCents > 0
    ? `Remaining ${formatCents(summary.remainingCents)}`
    : `Change ${formatCents(summary.changeCents)}`;

/** The cash line's own target: what the sale still owes once every OTHER line is counted (for its Exact / quick buttons). */
export function cashDueCents(
  rows: readonly SplitLegRow[],
  cashRowId: string,
  totalCents: number,
): number {
  const others = rows.reduce(
    (s, r) => (r.id === cashRowId ? s : s + (amountTextToCents(r.amount) ?? 0)),
    0,
  );
  return Math.max(0, totalCents - others);
}

// ─── wire ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `payments` legs of the body, in row order (never re-sorted): every leg carries its amount; a check carries its number. */
export function buildSplitPayments(rows: readonly SplitLegRow[]): SplitWireLeg[] {
  return activeLegs(rows).map((r) => ({
    method: r.method,
    amount: centsToDollars(amountTextToCents(r.amount) ?? 0),
    ...(r.method === "CHECK" && r.reference.trim() ? { reference: r.reference.trim() } : {}),
  }));
}

/** A held attempt's rows, rebuilt from its stored legs: what the clerk sees after a reload is what is replayed. */
export function rowsFromWire(legs: readonly SplitWireLeg[]): SplitLegRow[] {
  return legs.map((l) =>
    newRow(l.method, l.amount != null ? String(l.amount) : "", l.reference ?? ""),
  );
}

// ─── display order ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The order a sale's tender is LISTED in (receipt, reprint, Today's sales): everything that is not cash in the order given,
 * then cash. A display partition only: the request keeps the clerk's own line order and the server places the legs.
 */
export function tenderDisplayOrder<T extends { method: string }>(items: readonly T[]): T[] {
  return [...items.filter((i) => i.method !== "CASH"), ...items.filter((i) => i.method === "CASH")];
}

/**
 * Whether a sale's stored methods are a SPLIT tender: two or more that took money (a credit-note / advance application is
 * "Store credit", never money in, so cash plus store credit stays a one-tender sale).
 */
export const isSplitTender = (methods: ReadonlyArray<{ method: string }>): boolean =>
  methods.filter((m) => m.method !== "STORE_CREDIT").length > 1;
