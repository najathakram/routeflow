import { ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
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

/**
 * Which recompute refused, echoed as `path` in the 409 body so a client picks its copy (SA-814e):
 * a DRAFT edit (the lines save or the discount / shipping PATCH) or an ISSUED invoice's price adjustment.
 * The values and the copy mirror `INVOICE_TAX_STATE_STALE_*` in @routeflow/types (web and mobile read those).
 */
export type TaxStateStalePath = "DRAFT_EDIT" | "PRICE_ADJUSTMENT";

/** The copy for each path: the 409's `message` (mobile shows it as sent); web's table carries the same sentences. */
export const TAX_STATE_STALE_COPY: Record<TaxStateStalePath, string> = {
  DRAFT_EDIT:
    "This draft's tax was saved by an older version and can't be recalculated safely. Create it again from the order, or contact support.",
  PRICE_ADJUSTMENT:
    "This invoice's stored tax can't be recalculated safely. Issue a credit note or contact support.",
};

/** The 409 every recompute path throws for a stale tax state (one body shape: code, message, path). */
export function staleTaxStateError(path: TaxStateStalePath): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.INVOICE_TAX_STATE_STALE,
    message: TAX_STATE_STALE_COPY[path],
    path,
  });
}

/**
 * SA-814e: an ORDER-LINKED invoice's tax is the order's tax ALLOCATED across the invoices cut from it
 * (cents-rounded per invoice, the rounding remainder on the largest one), while its lines are re-taxed at the
 * rate stored on them. A correct order-derived invoice can therefore differ from `Σ subtotal x rate` by up to
 * this many cents PER invoice sharing the order. The ONE tolerance; a manual invoice keeps half a cent.
 */
export const ORDER_ALLOCATION_TOLERANCE_CENTS = 1;

const toCents = (v: unknown): number => Math.round(roundMoney(Number(v ?? 0)) * 100);

/** True when two money figures differ by more than `toleranceCents` plus half a cent (both cents-rounded first, L-170). */
const differsBeyond = (a: unknown, b: unknown, toleranceCents: number): boolean =>
  Math.abs(toCents(a) - toCents(b)) > toleranceCents + 0.5;

/**
 * How many non-VOID invoices share this invoice's order allocation (>= 1, itself included), or null for an
 * invoice with no order (manual-only: its tax is its own lines', no allocation). `orderInvoiceCount` is read by
 * the caller under the same lock / read that loaded the invoice.
 */
export function orderSiblingCountOf(inv: {
  orderId?: unknown;
  orderInvoiceCount?: unknown;
}): number | null {
  return inv.orderId ? Math.max(1, Number(inv.orderInvoiceCount) || 1) : null;
}

/** Non-VOID invoice count of one order, tenant-scoped by the caller's client or transaction. */
export async function countOrderInvoices(
  db: { invoice: { count(args: any): PromiseLike<number> } },
  orderId: string,
): Promise<number> {
  return db.invoice.count({ where: { orderId, status: { not: InvoiceStatus.VOID } } });
}

/** The same count for several orders at once (the bulk pre-flight), keyed by order id; no query without an order. */
export async function countOrdersInvoices(
  db: { invoice: { groupBy(args: any): PromiseLike<any[]> } },
  orderIds: ReadonlyArray<string | null | undefined>,
): Promise<ReadonlyMap<string, number>> {
  const ids = [...new Set(orderIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db.invoice.groupBy({
    by: ["orderId"],
    where: { orderId: { in: ids }, status: { not: InvoiceStatus.VOID } },
    _count: { _all: true },
  });
  return new Map((rows ?? []).map((r) => [String(r.orderId), Number(r?._count?._all ?? 0)]));
}

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
  /** SA-814e: the invoices sharing this invoice's order (`orderSiblingCountOf`); null / absent = no order. */
  orderSiblingCount?: number | null;
  discount?: number;
  shipping?: number;
}

/** The verdict, without throwing: callers that must weigh the user's own rate change use this. */
export function taxStateOf(args: TaxStateArgs): TaxStateVerdict {
  const {
    invoice,
    storedLines,
    canRestamp,
    isTaxExempt,
    refuseExemptLevy,
    orderSiblingCount,
    discount,
    shipping,
  } = args;
  const opts: SumInvoiceTotalsOptions = { discount, shipping, isTaxExempt };
  const totals = sumInvoiceTotalsStrict(storedLines, opts);
  const exemptWithLevy =
    !!refuseExemptLevy &&
    !!isTaxExempt &&
    storedLines.some((l) => toCents(l.categoryTaxAmount) !== 0);
  const toleranceCents =
    orderSiblingCount == null
      ? 0
      : ORDER_ALLOCATION_TOLERANCE_CENTS * Math.max(1, orderSiblingCount);
  const stale = exemptWithLevy || differsBeyond(totals.tax, invoice.taxAmount, toleranceCents);
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
  args: TaxStateArgs & { path: TaxStateStalePath },
): TaxStateVerdict {
  const verdict = taxStateOf(args);
  if (verdict.stale && verdict.restampRate == null) throw staleTaxStateError(args.path);
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
 * Not a silent drop (proceeds, nothing stamped): an exempt customer, a consistent stored state, no stored line kept (a full
 * rewrite), or a kept line whose payload rate differs from the stored one (the user set it).
 */
export function guardItemsEditTaxState(args: {
  locked: {
    invoice: any;
    storedRows: any[];
    isTaxExempt: boolean;
    orderInvoiceCount?: number | null;
  };
  items: ReadonlyArray<{ taxRate?: number | null }>;
  matches: ReadonlyArray<{ row: Record<string, any> | null }>;
  editLines: ReadonlyArray<{ rowId: string | null; data: Record<string, any> }>;
}): void {
  const { locked, items, matches, editLines } = args;
  // An exempt customer: the edit's recompute is deterministic ($0 regular tax, levy snapshots zeroed by the
  // caller), the same as master, so a draft whose customer became exempt re-saves and sheds its tax.
  if (locked.isTaxExempt) return;
  const verdict = taxStateOf({
    invoice: locked.invoice,
    storedLines: locked.storedRows,
    canRestamp: true,
    isTaxExempt: locked.isTaxExempt,
    orderSiblingCount: orderSiblingCountOf({
      orderId: locked.invoice?.orderId,
      orderInvoiceCount: locked.orderInvoiceCount,
    }),
  });
  if (!verdict.stale) return;
  if (!matches.some((m) => m.row)) return; // every stored line is gone: nothing is being re-taxed
  if (matches.some((m, i) => m.row && !sameRate(items[i]?.taxRate, m.row.taxRate))) return; // user set a rate
  if (verdict.restampRate == null) throw staleTaxStateError("DRAFT_EDIT");
  for (const l of editLines) {
    const row = l.rowId ? locked.storedRows.find((r) => r.id === l.rowId) : undefined;
    const storedZero = row && Number(row.taxRate ?? 0) === 0;
    if (storedZero && Number(l.data.taxRate ?? 0) === 0 && !isNsfLine(row)) {
      l.data.taxRate = verdict.restampRate;
    }
  }
}
