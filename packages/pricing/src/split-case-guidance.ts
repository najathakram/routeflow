/**
 * Shared split-dialog "Case guidance" helpers (SA-234).
 *
 * Both the web SplitInvoiceModal (`apps/web/app/(dashboard)/orders/_components/
 * SplitInvoiceModal.tsx`, #2074/SA-178 item 5) and the mobile SplitInvoiceScreen
 * (`apps/mobile/lib/split-invoice-cases.ts`, PR #2084) hand-rolled the same
 * "step by whole Cases, offer the odd remainder as an explicit opt-in" picker
 * logic. This module is the ONE shared implementation both adopt (in separate,
 * later PRs — this PR only lands the package helpers, per SA-234).
 *
 * UNIT LINE (confirmed from both implementations): a line is Case-aware only
 * when it carries a non-blank `unitLabel` (units_v1 — the line's own selling
 * unit, e.g. "Case", "Pallet") together with its own `unitsPerBox` (the sale-
 * time Case-size snapshot). Web's `caseSizeFor` checks
 * `label && upb > 1` inline; mobile's `caseSizeOf` delegates the "has a label"
 * half to a dedicated `isUnitLine` (`apps/mobile/lib/invoice-line-unit.ts`,
 * B784, itself a mirror of `apps/web/lib/invoice-line-unit.ts`) —
 * `(it.unitLabel ?? "").trim() !== ""`. Both agree: a boxed-but-unlabeled
 * legacy pack line (`unitsPerBox > 1`, no `unitLabel`) is NOT a unit line and
 * gets no Case guidance, exactly like a plain per-piece line.
 *
 * TRIGGER: an INTEGER pack > 1 on a unit line. Web's `caseSizeFor` used
 * `Math.trunc(Number(it.unitsPerBox ?? 0))`, which silently floors a corrupt
 * non-integer snapshot (4.7 -> 4) into Case guidance — a bug (SA-234). This
 * module requires `Number.isInteger`, so a non-integer pack never triggers
 * guidance (mirrors mobile's already-correct `caseSizeOf`, which never had
 * this bug).
 *
 * GUIDANCE ONLY, never a block: a partial Case is always a legitimate
 * physical amount (SA-178: Cases are the selling axis, loose pieces the
 * physical axis, and the two are independent). Every helper here only picks
 * defaults, step sizes and labels; nothing refuses or clamps a caller out of
 * reaching the full remaining quantity — the remainder toggle always reaches
 * it (see `billQty`).
 *
 * MONEY: nothing here prices anything. `computeLineSubtotal` (`./pricing`)
 * still owns proration for a partial line; this module only ever produces
 * qty (integer pieces) and copy. All results are non-negative integers, and
 * every "cap" (the remaining qty a line can still be billed) is guarded
 * against negative, `NaN` and non-integer input — never thrown, never `NaN`
 * out — by clamping to a safe value before use.
 */

import { normalizeBoxesPieces, pluralizeUnitLabel } from "./pricing";

/** The line facts Case guidance needs — a subset both OrderItemForSplit (web) and
 *  SplitInvoiceItem (mobile) already carry. */
export interface CaseGuidanceLine {
  /** units_v1: the line's own selling unit ("Case", "Pallet"). Blank/absent ⇒ not a unit line. */
  unitLabel?: string | null;
  /** Sale-time Case-size snapshot (pieces per Case). Only meaningful alongside `unitLabel`. */
  unitsPerBox?: number | null;
}

/** and only the UNIT-LINE half of the trigger — see the module doc for the shared definition. */
function isUnitLine(line: CaseGuidanceLine): boolean {
  return (line.unitLabel ?? "").trim() !== "";
}

/** Non-negative integer, `NaN`/non-finite -> 0. The one cap/qty guard every helper below uses. */
function safeCount(n: number): number {
  const t = Math.trunc(Number(n));
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/** A valid Case size is an integer > 1; anything else (including `NaN`) guards to 0 ("no size"). */
function safeSize(size: number): number {
  const t = Math.trunc(Number(size));
  return Number.isFinite(t) && t > 1 ? t : 0;
}

/**
 * Pieces per Case for a unit line — an integer pack > 1 (see the module doc for both halves of
 * the trigger); `null` for any other line (plain, legacy boxed-but-unlabeled, or a corrupt
 * non-integer/≤1 snapshot).
 */
export function caseSizeOf(line: CaseGuidanceLine): number | null {
  if (!isUnitLine(line)) return null;
  const n = Number(line.unitsPerBox);
  return Number.isInteger(n) && n > 1 ? n : null;
}

/**
 * Whole Cases in `cap` pieces at `size` pieces/Case — built ON {@link normalizeBoxesPieces}
 * (the package's one boxes/pieces split), never a local `Math.floor(cap / size)`, so this
 * agrees with every other boxed-qty computation in the package by construction.
 */
export function wholeCasesOf(cap: number, size: number): number {
  const s = safeSize(size);
  if (s === 0) return 0;
  return normalizeBoxesPieces({ qty: safeCount(cap), unitsPerBox: s }).boxes ?? 0;
}

/** Loose pieces left over after whole Cases — `cap - wholeCasesOf(cap, size) * size`. 0 for a
 *  non-unit line (`size == null`) or an invalid size. */
export function remainderPieces(cap: number, size: number | null): number {
  if (size == null) return 0;
  const s = safeSize(size);
  if (s === 0) return 0;
  const c = safeCount(cap);
  return c - wholeCasesOf(c, s) * s;
}

/** Default draft qty: whole Cases only for a unit line (the odd remainder needs the explicit
 *  opt-in below); the full `cap` for any other line (`size == null`). */
export function defaultBillQty(cap: number, size: number | null): number {
  const c = safeCount(cap);
  if (size == null) return c;
  const s = safeSize(size);
  if (s === 0) return c;
  return wholeCasesOf(c, s) * s;
}

/** "Half": whole Cases only, rounded UP so a lone odd Case still goes somewhere
 *  (`ceil(wholeCases / 2) * size`); `ceil(cap / 2)` for a non-unit line. */
export function halfBillQty(cap: number, size: number | null): number {
  const c = safeCount(cap);
  if (size == null) return Math.ceil(c / 2);
  const s = safeSize(size);
  if (s === 0) return Math.ceil(c / 2);
  return Math.ceil(wholeCasesOf(c, s) / 2) * s;
}

/**
 * One stepper press on the CASES axis: `cases + dir` (dir is +1 or -1), clamped to
 * `[0, wholeCasesOf(cap, size)]` — the "+1 Case" direction can never step past the last whole
 * Case (never adds a partial Case by itself; that's what the remainder toggle in {@link billQty}
 * is for), and "-1 Case" never goes negative.
 */
export function stepCases(cases: number, dir: 1 | -1, cap: number, size: number): number {
  const s = safeSize(size);
  const maxCases = s === 0 ? 0 : wholeCasesOf(cap, s);
  const next = safeCount(cases) + dir;
  return Math.min(Math.max(0, next), maxCases);
}

/**
 * Billed qty in pieces for `cases` whole Cases plus (when `remainderOn`) the loose remainder —
 * `cases * size + (remainderOn ? remainderPieces(cap, size) : 0)`. The two axes are independent
 * (SA-178): the remainder toggle adds the loose pieces to WHATEVER Case count is selected, and
 * that survives a `stepCases` press either direction (SA-234 pins: remaining 44 at 12 ->
 * `billQty(2, true, 44, 12)` = 32, `billQty(0, true, 44, 12)` = 8, `billQty(3, true, 44, 12)` =
 * 44 = cap, `billQty(3, false, 44, 12)` = 36). With `cases` at 0 this bills the loose pieces
 * alone.
 */
export function billQty(cases: number, remainderOn: boolean, cap: number, size: number): number {
  const s = safeSize(size);
  if (s === 0) return remainderOn ? safeCount(cap) : 0;
  const c = safeCount(cases);
  return c * s + (remainderOn ? remainderPieces(cap, s) : 0);
}

// ─── Copy ──────────────────────────────────────────────────────────────────────
// Web is golden for wording ("Bill the remaining {n} pcs", a "{n} Case(s)"-style count badge);
// generalised here with `unitLabel` so "Case" becomes "Pallet" wherever the operator named the
// unit that. Every pluralization goes through `pluralizeUnitLabel` (`./pricing`, placed next to
// `invoiceLineQtyText`) — the one rule, not a second hand-rolled `n === 1 ? "" : "s"` here.

/**
 * The stepper's own Case-count badge — "4 Cases" / "1 Case" / "0 Cases". Unlike
 * `invoiceLineQtyText`/`formatQtySplit` (which render a bare "0" at zero qty, correct for a qty
 * SUMMARY), this label always names the unit, including at zero, because it labels a COUNTER,
 * not a quantity. Defaults the noun to "Case" when no `unitLabel` is given.
 */
export function caseCountLabel(cases: number, unitLabel?: string | null): string {
  const label = (unitLabel ?? "").trim() || "Case";
  const n = safeCount(cases);
  return `${n} ${pluralizeUnitLabel(label, n)}`;
}

/**
 * The +/-1 Case stepper button's visible text AND aria-label — "Add one Case" / "Remove one
 * Case", generalised: "Add one Pallet" / "Remove one Pallet" (never a hardcoded "case" — web's
 * aria-labels did that; SA-234 calls it out). Always singular ("one"), so no pluralization.
 */
export function stepCaseAriaLabel(dir: 1 | -1, unitLabel?: string | null): string {
  const label = (unitLabel ?? "").trim() || "Case";
  return dir > 0 ? `Add one ${label}` : `Remove one ${label}`;
}

/** The remainder opt-in checkbox's label — "Bill the remaining {n} pcs" (byte-identical to
 *  web's wording; "pcs" names the loose-piece axis and is not `unitLabel`-dependent). */
export function remainderCheckboxLabel(cap: number, size: number): string {
  return `Bill the remaining ${remainderPieces(cap, size)} pcs`;
}
