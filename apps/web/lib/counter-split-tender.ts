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

// The wire codes of the split-payment contract. Every one is a shared API_ERROR_CODES constant except the 409 the API
// has not registered yet: that literal lives HERE only, and moves to API_ERROR_CODES when the API side lands it.
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
  COUNTER_TENDER_CHANGED: "COUNTER_TENDER_CHANGED",
} as const;

/** FIXED copy per code / client problem. The server's own text is never shown. */
export const SPLIT_PROBLEM_COPY = {
  COUNTER_TOO_MANY_LEGS: `A sale can be split across at most ${SPLIT_RULE.maxLegs} payments.`,
  TENDER_METHOD_NOT_ALLOWED: "That payment method can't be used at the counter.",
  COUNTER_ON_ACCOUNT_NOT_SPLIT:
    "On account can't be combined with other payments. Use it on its own.",
  COUNTER_DUPLICATE_CASH_LEG: "Only one cash line is allowed. Put all the cash on one line.",
  COUNTER_CHECK_NUMBER_REQUIRED: "Enter the check number.",
  COUNTER_LEG_AMOUNT_REQUIRED: "Enter an amount on every payment line, or remove the line.",
  COUNTER_LEG_NOT_CENTS: "Amounts must be in dollars and cents, like 12.50.",
  COUNTER_PAYMENT_EXCEEDS_TOTAL:
    "The payments add up to more than the sale total. Lower the card or check amounts.",
  COUNTER_TENDER_SHORT: "A walk-in customer must pay the full balance.",
  COUNTER_PAYMENT_SHAPE_CONFLICT:
    "This sale can't be completed as entered. Review the payment and try again.",
  COUNTER_TENDER_CHANGED:
    "Part of this payment was already taken differently. Check recent sales before ringing it again.",
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

/** The panel opens with two lines: the method already chosen (On account is never split) and the other of cash/card. */
export function newSplitRows(current: CounterSalePaymentMethod): SplitLegRow[] {
  const first: CounterSalePaymentMethod = current === "ON_ACCOUNT" ? "CARD" : current;
  return [newRow(first), newRow(first === "CASH" ? "CARD" : "CASH")];
}

export const canAddLeg = (rows: readonly SplitLegRow[]): boolean =>
  rows.length < SPLIT_RULE.maxLegs &&
  !rows.some((r) => SPLIT_RULE.singleLegOnly.includes(r.method));
export const canRemoveLeg = (rows: readonly SplitLegRow[]): boolean => rows.length > 2;

/** The new line takes the first method that is still allowed (cash while no cash line exists, else card). */
export function addLeg(rows: readonly SplitLegRow[]): SplitLegRow[] {
  if (!canAddLeg(rows)) return [...rows];
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

/** Whether `method` may be picked on line `id`: allowed here, one cash line, On account alone (never while split). */
export function legMethodAllowed(
  rows: readonly SplitLegRow[],
  id: string,
  method: CounterSalePaymentMethod,
): boolean {
  if (!SPLIT_RULE.allowed.includes(method)) return false;
  if (SPLIT_RULE.singleLegOnly.includes(method) && rows.length > 1) return false;
  if (method === "CASH" && SPLIT_RULE.maxCashLegs <= 1)
    return !rows.some((r) => r.id !== id && r.method === "CASH");
  return true;
}

// ─── the live summary ──────────────────────────────────────────────────────────────────────────────────────────────

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
}

const isCash = (r: SplitLegRow) => r.method === "CASH";

/** Mirrors the server's PRE-WRITE rules over the rows, in the order the server raises them. */
export function summarizeSplit(input: {
  rows: readonly SplitLegRow[];
  totalCents: number;
  isWalkIn: boolean;
}): SplitSummary {
  const { rows, totalCents, isWalkIn } = input;
  const cents = rows.map((r) => amountTextToCents(r.amount));
  const valid = cents.every((c) => c !== null);
  const amounts = cents.map((c) => c ?? 0);
  const enteredCents = amounts.reduce((a, b) => a + b, 0);
  const nonCash = rows.reduce((s, r, i) => (isCash(r) ? s : s + amounts[i]), 0);
  const cash = rows.reduce((s, r, i) => (isCash(r) ? s + amounts[i] : s), 0);

  let changeCents = 0;
  if (valid && nonCash <= totalCents) {
    changeCents = planTenderLegs(
      [{ id: "sale", balanceCents: totalCents }],
      rows.map((r, i) => ({ method: r.method, amountCents: amounts[i] })),
    ).changeCents;
  }

  let problem: SplitPaymentProblem | null = null;
  if (rows.length > SPLIT_RULE.maxLegs) problem = "COUNTER_TOO_MANY_LEGS";
  else if (rows.some((r) => !SPLIT_RULE.allowed.includes(r.method)))
    problem = "TENDER_METHOD_NOT_ALLOWED";
  else if (rows.length > 1 && rows.some((r) => SPLIT_RULE.singleLegOnly.includes(r.method)))
    problem = "COUNTER_ON_ACCOUNT_NOT_SPLIT";
  else if (rows.filter(isCash).length > SPLIT_RULE.maxCashLegs)
    problem = "COUNTER_DUPLICATE_CASH_LEG";
  else if (!valid) problem = "COUNTER_LEG_NOT_CENTS";
  else if (rows.some((r) => r.method === "CHECK" && !r.reference.trim()))
    problem = "COUNTER_CHECK_NUMBER_REQUIRED";
  else if (amounts.some((a) => a <= 0)) problem = "COUNTER_LEG_AMOUNT_REQUIRED";
  else if (nonCash > totalCents || (cash > 0 && nonCash >= totalCents))
    problem = "COUNTER_PAYMENT_EXCEEDS_TOTAL";
  else if (isWalkIn && enteredCents < totalCents) problem = "COUNTER_TENDER_SHORT";

  const remainingCents = Math.max(0, totalCents - enteredCents);
  return {
    totalCents,
    enteredCents,
    remainingCents,
    changeCents,
    leftOnAccountCents: isWalkIn ? 0 : remainingCents,
    problem,
  };
}

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

/** The `payments` legs of the body, in row order: every leg carries its amount; a check carries its number. */
export function buildSplitPayments(rows: readonly SplitLegRow[]): SplitWireLeg[] {
  return rows.map((r) => ({
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
