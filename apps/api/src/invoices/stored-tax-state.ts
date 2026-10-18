import { ConflictException } from "@nestjs/common";
import {
  inferredGoodsFlatRate,
  roundMoney,
  type MoneyLike,
  type SummedInvoiceTotals,
  type SumInvoiceTotalsOptions,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { sumInvoiceTotalsStrict } from "../common/money-invariants.util";
import { isNsfLine } from "./nsf-line";

/**
 * SA-814 R5-2: ONE guard for "can this invoice's stored lines reproduce its stored tax?". Every path that
 * re-derives an invoice's tax from rows already in the database (price adjustment, the DRAFT items edit and
 * the header-only discount / shipping PATCH) asks here first. A row whose rates cannot reproduce the stored
 * tax must never be re-taxed silently: the recompute (`Σ subtotal × taxRate`) would write the regular tax as
 * $0 (a legacy invoice stored at rate 0 with a real header tax) or move it by the rounding the Decimal(5,4)
 * rate column leaves behind (B296). Either the inferred flat rate (B294) is VERIFIED and is stamped first, or
 * the path refuses with 409 INVOICE_TAX_STATE_STALE and writes nothing.
 *
 * This file is the only place in `invoices/**` that runs `sumInvoiceTotals*` over STORED rows (the structural
 * pin is stored-tax-state.spec.ts); callers use the verdict's `totals`.
 */

/** The stored line facts the verdict reads (a Prisma row, or a test double). */
export type StoredTaxLine = {
  subtotal?: MoneyLike | null;
  taxRate?: MoneyLike | null;
  categoryTaxAmount?: MoneyLike | null;
  systemKind?: string | null;
  description?: string | null;
};

export const TAX_STATE_STALE_MESSAGES = {
  /** The header-only discount / shipping PATCH (message unchanged from B1043). */
  header:
    "This invoice's subtotal or tax no longer matches its lines, so the discount or shipping change can't be priced. Re-save the invoice lines, then try again.",
  /** A line edit that carries the stored rates through unchanged. */
  edit: "This invoice's tax no longer matches its lines' tax rates, so saving the lines would change the tax. Nothing was changed. Set the tax rate on the lines you are keeping, or issue a new invoice.",
  /** A price adjustment. */
  price:
    "This invoice's tax can't be reproduced from its lines' tax rates, so a price change would silently change the tax. Nothing was changed. Issue a credit note instead, or ask support to repair the line tax rates.",
} as const;

/** The 409 every recompute path throws for a stale tax state (one body shape). */
export function staleTaxStateError(message: string): ConflictException {
  return new ConflictException({ code: API_ERROR_CODES.INVOICE_TAX_STATE_STALE, message });
}

/** True when two money figures differ by more than half a cent (both rounded to cents first, L-170). */
const differsBeyondHalfCent = (a: unknown, b: unknown): boolean =>
  Math.abs(roundMoney(Number(a ?? 0)) - roundMoney(Number(b ?? 0))) > 0.005;

export interface TaxStateVerdict {
  /** The stored lines run through the ONE totals formula (never mutated). */
  totals: SummedInvoiceTotals;
  /** The stored lines do NOT reproduce the stored tax (beyond half a cent). */
  stale: boolean;
  /**
   * B294: when `stale` and the caller can stamp it, the VERIFIED flat rate (goods only, #2656) that
   * reproduces the stored tax to the cent. The caller writes it onto the rate-0 non-NSF lines BEFORE totalling.
   */
  restampRate: number | null;
}

export interface TaxStateArgs {
  /** The invoice row's stored header (subtotal and taxAmount are read). */
  invoice: { subtotal?: unknown; taxAmount?: unknown };
  /** Its stored lines, read under the caller's lock. */
  storedLines: ReadonlyArray<StoredTaxLine>;
  /** True when the caller can write the inferred rate onto the lines (price adjustment, the items edit). */
  canRestamp: boolean;
  /** The customer's exemption, ONLY where the caller's recompute honours it (items edit, header-only). */
  isTaxExempt?: boolean;
  /**
   * An EXEMPT customer's invoice that still carries a levy snapshot is stale even when the stored tax is 0
   * (header-only and price adjustment: they cannot clean it). The items edit zeroes it, so it passes false.
   */
  refuseExemptLevy?: boolean;
  discount?: number;
  shipping?: number;
}

/** The verdict, without throwing: callers that must weigh the user's own rate change use this. */
export function taxStateOf(args: TaxStateArgs): TaxStateVerdict {
  const { invoice, storedLines, canRestamp, isTaxExempt, refuseExemptLevy, discount, shipping } =
    args;
  const opts: SumInvoiceTotalsOptions = { discount, shipping, isTaxExempt };
  const totals = sumInvoiceTotalsStrict(storedLines, opts);
  const exemptWithLevy =
    !!refuseExemptLevy &&
    !!isTaxExempt &&
    storedLines.some((l) => differsBeyondHalfCent(l.categoryTaxAmount, 0));
  const stale = exemptWithLevy || differsBeyondHalfCent(totals.tax, invoice.taxAmount);
  if (!stale || !canRestamp || isTaxExempt) return { totals, stale, restampRate: null };
  const inferred = inferredGoodsFlatRate({
    subtotal: invoice.subtotal,
    taxAmount: invoice.taxAmount,
    lines: storedLines,
  }); // #2656: goods only
  return { totals, stale, restampRate: inferred?.verified ? inferred.rate : null };
}

/**
 * The guard: throws 409 INVOICE_TAX_STATE_STALE when the stored lines cannot reproduce the stored tax and no
 * verified re-stamp is possible; otherwise returns the verdict (a verified `restampRate` is the caller's
 * to stamp, then it proceeds).
 */
export function assertTaxStateRecomputable(
  args: TaxStateArgs & { message: string },
): TaxStateVerdict {
  const verdict = taxStateOf(args);
  if (verdict.stale && verdict.restampRate == null) throw staleTaxStateError(args.message);
  return verdict;
}

const sameRate = (a: unknown, b: unknown): boolean =>
  Math.abs(Number(a ?? 0) - Number(b ?? 0)) < 1e-9;

/**
 * The DRAFT items edit (`update()` with `items`): the edit re-taxes every line, so a stored state that cannot
 * reproduce its tax is a silent drop UNLESS the user deliberately changed a kept line's tax rate. The web
 * re-sends `Number(it.taxRate)` (0 for a legacy row), which is the stored rate, so "every kept line re-sends
 * its stored rate" is the silent case. Then:
 *   - a verified inferred rate is stamped on the kept rate-0 goods lines (in `editLines`, before they are
 *     totalled; `inPlacePatch` writes it);
 *   - otherwise 409 INVOICE_TAX_STATE_STALE, nothing written.
 * Not a silent drop (proceeds, nothing stamped): a consistent stored state, no stored line kept (a full
 * rewrite), or a kept line whose payload rate differs from the stored one (the user set it).
 */
export function guardItemsEditTaxState(args: {
  locked: { invoice: any; storedRows: any[]; isTaxExempt: boolean };
  items: ReadonlyArray<{ taxRate?: number | null }>;
  matches: ReadonlyArray<{ row: { taxRate?: unknown } | null }>;
  editLines: ReadonlyArray<{ rowId: string | null; data: Record<string, any> }>;
}): void {
  const { locked, items, matches, editLines } = args;
  const verdict = taxStateOf({
    invoice: locked.invoice,
    storedLines: locked.storedRows,
    canRestamp: true,
    isTaxExempt: locked.isTaxExempt,
  });
  if (!verdict.stale) return;
  if (!matches.some((m) => m.row)) return; // every stored line is gone: nothing is being re-taxed
  if (matches.some((m, i) => m.row && !sameRate(items[i]?.taxRate, m.row.taxRate))) return; // user set a rate
  if (verdict.restampRate == null) throw staleTaxStateError(TAX_STATE_STALE_MESSAGES.edit);
  for (const l of editLines) {
    const row = l.rowId ? locked.storedRows.find((r) => r.id === l.rowId) : undefined;
    const storedZero = row && Number(row.taxRate ?? 0) === 0;
    if (storedZero && Number(l.data.taxRate ?? 0) === 0 && !isNsfLine(row)) {
      l.data.taxRate = verdict.restampRate;
    }
  }
}
