import { roundMoney } from "@routeflow/pricing";
import type { CreateInvoiceDto } from "./dto/create-invoice.dto";
import type { EntitlementsService } from "../billing/entitlements.service";
import type { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { prepareUnitLadders } from "../orders/unit-line-build";

/**
 * The read/fold/ledger steps `InvoicesService.create()` runs around `buildManualInvoiceLines`, lifted VERBATIM
 * so `EstimatesService.convertToInvoice()` builds an invoice through the SAME path instead of a copy (B659).
 * `create()` is unchanged in behaviour.
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
  const products: Array<{ id: string; trackedCategoryId?: string | null }> =
    productIds.length > 0
      ? await prisma.forTenant().product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            unit: true,
            unitsPerBox: true,
            trackedCategoryId: true,
            trackedSubcategoryId: true,
          },
        })
      : [];
  const productMap = new Map<string, any>(products.map((p) => [p.id, p]));
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
 * A regulated line makes an invoice a filable sale: write its W5 SALE ledger rows inside the creating
 * transaction (a ledger write that fails must not leave a committed invoice with no SALE row). No-op when
 * no line is regulated.
 */
export async function writeInvoiceSaleEntries(
  ledger: RegulatedLedgerService,
  created: { id: string; issueDate?: Date | null; items?: any[] },
  ctx: { tenantId: string | null; tx: any },
) {
  if (!(created.items ?? []).some((it: any) => it.trackedCategoryId != null)) return;
  await ledger.writeSaleEntries({
    tenantId: ctx.tenantId,
    orderId: null,
    invoiceId: created.id,
    soldAt: created.issueDate ?? new Date(),
    lines: (created.items ?? []).map((it: any) => ({
      invoiceItemId: it.id,
      orderItemId: it.orderItemId ?? null,
      trackedCategoryId: it.trackedCategoryId ?? null,
      trackedSubcategoryId: it.trackedSubcategoryId ?? null,
      qty: Number(it.qty),
      netSales: Number(it.subtotal),
      categoryTax: Number(it.categoryTaxAmount ?? 0),
    })),
    db: ctx.tx,
  });
}
