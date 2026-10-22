import { BadRequestException } from "@nestjs/common";
import {
  assertMoneyInvariants,
  MoneyInvariantError,
  roundMoney,
  sumInvoiceTotals,
  type MoneyInvariantInput,
  type SummedInvoiceLine,
  type SumInvoiceTotalsOptions,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "./api-error-codes";

/**
 * HTTP-layer wrapper around `@routeflow/pricing`'s `assertMoneyInvariants`
 * (B451 gap 4): every call site gets the SAME structured 400 — never an
 * unhandled `MoneyInvariantError` falling through to the Sentry catch-all
 * filter as a 500.
 */
export function assertMoneyInvariantsOrThrow(input: MoneyInvariantInput): void {
  try {
    assertMoneyInvariants(input);
  } catch (err) {
    if (err instanceof MoneyInvariantError) {
      throw new BadRequestException({
        code: API_ERROR_CODES.MONEY_INVARIANT,
        message: err.message,
      });
    }
    throw err;
  }
}

export interface LineSubtotalLike {
  description: string;
  // `unknown`, not `number`: a Prisma `Decimal` (the estimate-item column type) coerces fine through
  // `Number(...)` but is not itself assignable to `number | string`.
  subtotal: unknown;
}

/**
 * B659 (review finding 5): the per-line "discount exceeded the line total" guard
 * `InvoicesService.create()` ran inline over its freshly-built `itemsData`, extracted here so
 * `EstimatesService.convertToInvoice()`'s pre-flight can run the SAME check — same message, same
 * shape — over the ESTIMATE's own stored lines, before a number is reserved. `create()` now calls
 * this instead of carrying its own copy.
 */
export function assertNoNegativeLineSubtotal(items: ReadonlyArray<LineSubtotalLike>): void {
  for (const item of items) {
    const subtotal = Number(item.subtotal);
    if (subtotal < 0) {
      throw new BadRequestException(
        `Line item "${item.description}" has a negative subtotal (${subtotal}). Discount cannot exceed line total.`,
      );
    }
  }
}

/** Money text for the refusal messages: `$10.50`, `-$0.50`. */
function formatMoney(n: number): string {
  const r = roundMoney(n);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toFixed(2)}`;
}

/**
 * B1030 (SA-651): the invoice-level totals guard `InvoicesService.create()` ran inline (a discount larger
 * than the subtotal, and a negative total), extracted so `update()` runs the SAME two checks, with the same
 * messages, on both of its paths (the items rewrite and the discount/shipping-only recompute). Without them
 * PATCH {discount: 100} on a $10 invoice stored a total of -90.
 *
 * `create()` calls it strict (no `before`). `update()` passes the invoice's STORED totals as `before`, which
 * applies the NOT-WORSE rule on legacy data: an invoice that is ALREADY insane may still be saved while the
 * edit does not make it worse (its total does not go down and discount minus subtotal does not go up), so an
 * improvement or a no-change save is never blocked; only sane -> insane, or insane -> worse, is refused.
 */
export function assertInvoiceTotalsSane(
  after: { discount: number; subtotal: number; total: number },
  before?: { discount: number; subtotal: number; total: number },
): void {
  const insane = (t: { discount: number; subtotal: number; total: number }) =>
    t.discount > t.subtotal || t.total < 0;
  if (!insane(after)) return;
  if (before && insane(before)) {
    const EPS = 1e-9;
    const worse =
      after.total < before.total - EPS ||
      after.discount - after.subtotal > before.discount - before.subtotal + EPS;
    if (!worse) return;
  }
  // B1047: lines that net NEGATIVE make "discount ($0.00) cannot exceed subtotal (-$35.00)" read like nonsense;
  // the thing to fix is the lines.
  if (after.subtotal < 0) {
    throw new BadRequestException(
      `Invoice subtotal cannot be negative (${formatMoney(after.subtotal)}). Check the line discounts.`,
    );
  }
  if (after.discount > after.subtotal) {
    throw new BadRequestException(
      `Invoice discount (${formatMoney(after.discount)}) cannot exceed subtotal (${formatMoney(after.subtotal)}).`,
    );
  }
  throw new BadRequestException(
    `Invoice total cannot be negative (calculated: ${formatMoney(after.total)}).`,
  );
}

/**
 * The STORED totals of an invoice row (Prisma Decimals arrive as objects), the `before` of the NOT-WORSE rule.
 * STRICT (SA-651): when the row or its stored `subtotal`/`total` is missing, null or non-numeric the old totals
 * are NOT provable, so this returns `undefined` and the guard judges the edit strictly instead of exempting it
 * as "legacy" against a fabricated 0. (An absent `discount` is a genuine 0.)
 */
export function storedInvoiceTotals(
  row: { discount?: unknown; subtotal?: unknown; total?: unknown } | null | undefined,
): { discount: number; subtotal: number; total: number } | undefined {
  if (!row || row.subtotal == null || row.total == null) return undefined;
  const t = {
    discount: Number(row.discount ?? 0),
    subtotal: Number(row.subtotal),
    total: Number(row.total),
  };
  return Number.isFinite(t.discount) && Number.isFinite(t.subtotal) && Number.isFinite(t.total)
    ? t
    : undefined;
}

/**
 * N4: the server's `sumInvoiceTotals`. A non-finite line subtotal, rate, levy, discount or shipping is a 400
 * MONEY_INVARIANT, never a silent $0 written to an invoice. (Display callers keep the lenient default.)
 */
export function sumInvoiceTotalsStrict(
  lines: readonly SummedInvoiceLine[],
  opts: SumInvoiceTotalsOptions = {},
): ReturnType<typeof sumInvoiceTotals> {
  try {
    return sumInvoiceTotals(lines, { ...opts, strict: true });
  } catch (err) {
    if (err instanceof MoneyInvariantError) {
      throw new BadRequestException({
        code: API_ERROR_CODES.MONEY_INVARIANT,
        message: err.message,
      });
    }
    throw err;
  }
}

/**
 * SA-816 (d)2: a STORED money column (a levy on an invoice or order line) read for a sum, a copy or a ledger
 * booking. NUMERIC accepts 'NaN' and node-pg binds a JS NaN as 'NaN', so a stored row can hold one; the app
 * then either laundered it (`roundMoney(NaN)` is 0, a silent $0) or copied it on verbatim. The callers are the
 * fix (`roundMoney` keeps returning 0): read the column through this and a non-finite value is a 400
 * MONEY_INVARIANT with nothing written, the same code and shape as `sumInvoiceTotalsStrict` and
 * `assertFiniteInvoiceInput`. An absent amount (null / undefined) is a genuine 0. Returns the amount as a number.
 */
export function finiteStoredMoney(value: unknown, label: string): number {
  if (value == null) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.MONEY_INVARIANT,
      message: `${label} holds a stored amount that is not a valid number; it has to be repaired before this can proceed.`,
    });
  }
  return n;
}

/** The levy member's name, held as a string so reading it stays out of the categoryTaxAmount writer census. */
const LEVY = "categoryTaxAmount" as const;

/** `finiteStoredMoney` over a row's stored levy (an invoice or order line); see there. */
export function finiteStoredLevy(row: object | null | undefined, label: string): number {
  return finiteStoredMoney((row as Record<string, unknown> | null | undefined)?.[LEVY], label);
}

/**
 * N4: `roundMoney` and `computeLineSubtotal` read NaN as 0, so a non-finite amount in a request would be
 * laundered into a $0 line or discount BEFORE the totals builder ever saw it. Refuse it at the door instead
 * (400 MONEY_INVARIANT): the header discount / shipping fee and every line's qty, price, discount, rate and
 * pack counts. An absent amount (null / undefined) is fine.
 */
export function assertFiniteInvoiceInput(input: {
  discount?: unknown;
  shippingFee?: unknown;
  items?: ReadonlyArray<object> | null;
}): void {
  const bad = (label: string): never => {
    throw new BadRequestException({
      code: API_ERROR_CODES.MONEY_INVARIANT,
      message: `${label} is not a valid number.`,
    });
  };
  const check = (label: string, v: unknown) => {
    if (v != null && !Number.isFinite(Number(v))) bad(label);
  };
  check("The invoice discount", input.discount);
  check("The shipping fee", input.shippingFee);
  (input.items ?? []).forEach((it, i) => {
    for (const k of ["qty", "unitPrice", "discount", "taxRate", "boxes", "pieces", "unitsPerBox"]) {
      check(`Line ${i + 1} ${k}`, (it as Record<string, unknown>)[k]);
    }
  });
}
