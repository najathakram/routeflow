import { BadRequestException } from "@nestjs/common";
import {
  assertMoneyInvariants,
  MoneyInvariantError,
  type MoneyInvariantInput,
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
  if (after.discount > after.subtotal) {
    throw new BadRequestException(
      `Invoice discount (${after.discount}) cannot exceed subtotal (${after.subtotal}).`,
    );
  }
  throw new BadRequestException(`Invoice total cannot be negative (calculated: ${after.total}).`);
}

/** The STORED totals of an invoice row (Prisma Decimals arrive as objects), the `before` of the NOT-WORSE rule. */
export function storedInvoiceTotals(
  row: { discount?: unknown; subtotal?: unknown; total?: unknown } | null | undefined,
): { discount: number; subtotal: number; total: number } | undefined {
  return row
    ? {
        discount: Number(row.discount ?? 0),
        subtotal: Number(row.subtotal ?? 0),
        total: Number(row.total ?? 0),
      }
    : undefined;
}
