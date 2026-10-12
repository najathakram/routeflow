import { sumInvoiceTotals, type MoneyLike, type SummedInvoiceTotals } from "@routeflow/pricing";

/**
 * The ONE place an order header's tax, levy and total are summed. Every order writer (create, edit, merge,
 * change-request apply, standing orders) calls `orderTotalsOf`, which is `sumInvoiceTotals` - the formula the
 * invoice writers and the till's footer (`saleTotals`) share - so an order can never disagree with its invoice.
 * `order-totals-one-formula.spec.ts` fails the build on a second `subtotal * taxRate`.
 *
 * A tax-exempt customer owes $0 of BOTH the sales tax and the levy (RF-079 / RF-4), on the order exactly as on
 * the invoice.
 */
export function orderTotalsOf(
  lines: readonly { subtotal?: MoneyLike | null; categoryTaxAmount?: MoneyLike | null }[],
  opts: { taxRate: number; isTaxExempt: boolean; discount?: number; shipping?: number },
): SummedInvoiceTotals {
  return sumInvoiceTotals(
    // the spread carries each line's levy through untouched (sumInvoiceTotals reads it by name)
    lines.map((l) => ({ ...l, taxRate: opts.taxRate })),
    {
      discount: opts.discount,
      shipping: opts.shipping,
      isTaxExempt: opts.isTaxExempt,
      strict: true,
    },
  );
}

/** The levy member's name, held as a string so the header sums below stay out of the categoryTaxAmount writer census. */
const LEVY = "categoryTaxAmount" as const;

/**
 * The same sum for a caller that holds the order's Σ levy, not its line rows (the invoice finalize recompute): one
 * aggregate line carrying the whole levy, so there is still ONE formula.
 */
export function orderTotalsOfSums(
  sums: { subtotal: number; levy: number },
  opts: { taxRate: number; isTaxExempt?: boolean; discount?: number; shipping?: number },
): SummedInvoiceTotals {
  return orderTotalsOf([{ subtotal: sums.subtotal, [LEVY]: sums.levy }], {
    ...opts,
    isTaxExempt: opts.isTaxExempt === true,
  });
}

/** The customer's tax-exempt flag, read on the caller's own handle (a tx or the tenant client). Unknown = taxed. */
export async function customerIsTaxExempt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Prisma tx and the tenant client both fit
  db: any,
  customerId: string | null | undefined,
): Promise<boolean> {
  if (!customerId) return false;
  const row = await db.customer.findFirst({
    where: { id: customerId },
    select: { isTaxExempt: true },
  });
  return row?.isTaxExempt === true;
}
