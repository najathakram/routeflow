import { roundMoney, type LadderUnit } from "@routeflow/pricing";
import { assertSellableLines } from "../products/sellable-lines";
import type { CreateInvoiceDto } from "./dto/create-invoice.dto";
import type { EntitlementsService } from "../billing/entitlements.service";
import { prepareUnitLadders } from "../orders/unit-line-build";
import { asLadderProduct, normalizeDerivedBaseLine } from "../products/line-units";

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
    /**
     * Units P0b: when set, a derived Piece line from an old client (typed at the derived per-piece price) is
     * rewritten IN PLACE in `items` into the pack line's pieces at the PACK price (see `derivedBaseAsPackItems`).
     */
    derivedBaseTier?: number;
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
      ? await prisma.forTenant().product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            name: true,
            kind: true,
            unit: true,
            baseUnitLabel: true,
            packLabel: true,
            unitsPerBox: true,
            pricePerUnit: true,
            priceTier2: true,
            priceTier3: true,
            priceTier4: true,
            priceTier5: true,
            trackedCategoryId: true,
            trackedSubcategoryId: true,
          },
        })
      : [];
  const productMap = new Map<string, any>(products.map((p) => [p.id, p]));
  assertSellableLines(products); // WS8: a FAMILY is never a line
  // units_v1 (4c-1): the server ladder of the products a line names a unit for. The CALLER runs
  // resolveLineUnits per item (the unit-line-writers scanner requires every writer to call it itself).
  const unitsByProduct = await prepareUnitLadders(items, { isStaff: true, prisma, entitlements });
  if (deps.derivedBaseTier != null) {
    items.splice(
      0,
      items.length,
      ...derivedBaseAsPackItems(items, productMap, unitsByProduct, deps.derivedBaseTier),
    );
  }
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
 * RF-4: category (regulated) tax folds into an invoice's tax EXACTLY like the regular sales tax w.r.t. tax
 * exemption — an exempt customer owes $0 of BOTH. Returns the Σ per-line category tax; when exempt it
 * returns 0 AND zeroes each line's snapshot in place, so the stored InvoiceItem + the regulated-sales ledger
 * record the $0 that was billed.
 */
export function foldCategoryTax(
  itemsData: Array<{ categoryTaxAmount?: number }>,
  isTaxExempt: boolean,
): number {
  if (isTaxExempt) {
    for (const it of itemsData) it.categoryTaxAmount = 0;
    return 0;
  }
  return roundMoney(itemsData.reduce((s, it) => s + Number(it.categoryTaxAmount ?? 0), 0));
}

/**
 * SA-728 / units P0b: a derived Piece from an old client (typed at the derived per-piece price) becomes the
 * pack line's pieces at the PACK price, so computeLineSubtotal prorates it. Every other item is the same object.
 */
export function derivedBaseAsPackItems<T extends { productId?: string | null }>(
  items: T[],
  products: ReadonlyMap<string, any>,
  ladders: ReadonlyMap<string, LadderUnit[]>,
  customerTier?: number | null,
): T[] {
  return items.map((it) => {
    const p = it.productId ? products.get(it.productId) : undefined;
    if (!p) return it;
    return normalizeDerivedBaseLine(
      it as T & Parameters<typeof normalizeDerivedBaseLine>[0],
      asLadderProduct(p),
      ladders.get(p.id) ?? [],
      customerTier ?? 1,
      { price: "pack" },
    );
  });
}
