import { roundMoney } from "@routeflow/pricing";
import { sumInvoiceTotalsStrict } from "../common/money-invariants.util";
import { assertSellableLines } from "../products/sellable-lines";
import {
  REGULATED_PARENT_SELECT_FIELDS,
  withEffectiveAll,
} from "../products/effective-product-attributes";
import type { CreateInvoiceDto } from "./dto/create-invoice.dto";
import type { EntitlementsService } from "../billing/entitlements.service";
import { prepareUnitLadders } from "../orders/unit-line-build";

/**
 * The read/fold steps `InvoicesService.create()` runs around `buildManualInvoiceLines`, lifted VERBATIM
 * so `EstimatesService.convertToInvoice()` builds an invoice through the SAME path instead of a copy (B659).
 * `create()` is unchanged in behaviour. The regulated SALE-ledger write itself is NOT here — both callers
 * use `pack-at-sale.ts`'s `packAtSaleByProduct`/`toSaleLedgerLines` directly (the boxes/pieces/unitsPerBox/
 * packAtSale-carrying shape B661/B700/SA-078 rely on), not a third, thinner copy of that mapping.
 */

/**
 * Pre-fetches every product-linked line's box size + regulated-category snapshot, the units ladder gate
 * (flag.units_v1), and the regulated section (TrackedCategory) tax config.
 */
export async function loadManualLineContext(
  items: CreateInvoiceDto["items"],
  deps: {
    /** `PrismaService`, or a transaction shim (`forTenant: () => tx`) to read on the caller's connection. */
    prisma: { getTenantId(): string | null | undefined; forTenant(): any };
    entitlements: EntitlementsService;
  },
) {
  const { prisma, entitlements } = deps;
  const productIds = [...new Set(items.filter((i) => i.productId).map((i) => i.productId!))];
  const products: Array<{
    id: string;
    name?: string;
    kind?: string;
    trackedCategoryId?: string | null;
  }> =
    productIds.length > 0
      ? // B2: the regulated columns are the EFFECTIVE ones (the product's, widened by its family's)
        withEffectiveAll(
          await prisma.forTenant().product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              name: true,
              kind: true,
              unit: true,
              unitsPerBox: true,
              pricePerUnit: true,
              priceTier2: true,
              priceTier3: true,
              priceTier4: true,
              priceTier5: true,
              trackedCategoryId: true,
              trackedSubcategoryId: true,
              ...REGULATED_PARENT_SELECT_FIELDS,
            },
          }),
          prisma.getTenantId(),
        )
      : [];
  const productMap = new Map<string, any>(products.map((p) => [p.id, p]));
  assertSellableLines(products); // WS8: a FAMILY is never a line
  // units_v1 (4c-1): the server ladder of the products a line names a unit for. The CALLER runs
  // resolveLineUnits per item (the unit-line-writers scanner requires every writer to call it itself).
  const unitsByProduct = await prepareUnitLadders(items, { isStaff: true, prisma, entitlements });
  // RF-4: a regulated line carries + owes category tax, so load the tax config of its category.
  const catIds = [...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean))] as string[];
  const categoryMap = new Map<string, any>(
    (catIds.length > 0
      ? await prisma.forTenant().trackedCategory.findMany({ where: { id: { in: catIds } } })
      : []
    ).map((c: any) => [c.id, c]),
  );
  return { productMap, categoryMap, unitsByProduct };
}

/**
 * RF-4: an exempt customer owes $0 of the category (regulated) tax exactly like the regular sales tax:
 * zero each line's snapshot IN PLACE, so the stored InvoiceItem + the regulated-sales ledger record the $0
 * that was billed. A no-op for a non-exempt customer.
 */
export function zeroExemptCategoryTax(
  itemsData: Array<{ categoryTaxAmount?: number }>,
  isTaxExempt: boolean,
): void {
  if (isTaxExempt) for (const it of itemsData) it.categoryTaxAmount = 0;
}

/**
 * RF-4: category (regulated) tax folds into an invoice's tax EXACTLY like the regular sales tax w.r.t. tax
 * exemption — an exempt customer owes $0 of BOTH. Returns the Σ per-line category tax (the builder's
 * `categoryTax`: the ONE levy sum, B1043); when exempt it returns 0 AND zeroes each line's snapshot in
 * place (`zeroExemptCategoryTax`). Signature and callers unchanged (SA-742r2 F2).
 */
export function foldCategoryTax(
  itemsData: Array<{ categoryTaxAmount?: number }>,
  isTaxExempt: boolean,
): number {
  zeroExemptCategoryTax(itemsData, isTaxExempt);
  return sumInvoiceTotalsStrict(itemsData, { isTaxExempt }).categoryTax;
}

/**
 * The ONE order-derived regular-tax share: `order.tax` x (this invoice's subtotal / the order's subtotal),
 * cents-rounded, 0 for a tax-exempt customer. Used by the two single-invoice builders that cut an invoice from
 * the order (reconcile, the partial create). The DRAFT-partial price follow reaches the same figure another way:
 * it sums its lines through sumInvoiceTotalsStrict at the order-derived rate (spec-pinned equal). (The multi-invoice splits allocate
 * the same tax across siblings with a rounding remainder; that is a different, group-wide rule.)
 */
export function regularTaxShare(
  order: { tax?: unknown; subtotal?: unknown },
  subtotal: number,
  isTaxExempt: boolean,
): number {
  if (isTaxExempt) return 0;
  return roundMoney(Number(order.tax) * (subtotal / (Number(order.subtotal) || 1)));
}
