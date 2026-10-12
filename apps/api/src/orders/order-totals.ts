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
    lines.map((l) => ({
      subtotal: l.subtotal,
      taxRate: opts.taxRate,
      categoryTaxAmount: l.categoryTaxAmount,
    })),
    {
      discount: opts.discount,
      shipping: opts.shipping,
      isTaxExempt: opts.isTaxExempt,
      strict: true,
    },
  );
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
