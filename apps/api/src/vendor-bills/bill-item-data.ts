import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

/** The columns an edit carries from the STORED row, never from the client (SA-1207 S2b spec 6). */
export interface StoredBillItemIdentity {
  unitLabel: string | null;
  familyProductId: string | null;
  familyGroupId: string | null;
}

export const NO_IDENTITY: StoredBillItemIdentity = {
  unitLabel: null,
  familyProductId: null,
  familyGroupId: null,
};

/** Round every monetary write; absent (or not a number) stays null rather than becoming 0. */
function roundedOrNull(value: unknown): Prisma.Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? new Prisma.Decimal(roundMoney(n)) : null;
}

/** A whole-number pack, or null (no pack stated). The one read of a DTO line's `packSize`. */
export function billItemPack(item: { packSize?: unknown }): number | null {
  return Number.isFinite(Number(item.packSize)) ? Math.trunc(Number(item.packSize)) : null;
}

/**
 * SA-1207 S2b spec 5: the ONE shape a vendor-bill line is written in (create, update, and the draft-PO
 * twin take their label and family from the same `identity`). Money is rounded here: `lineTotal` is
 * evidence from the document, stored to cents.
 */
export function billItemData(
  item: any,
  tenantId: string | null,
  identity: StoredBillItemIdentity = NO_IDENTITY,
) {
  return {
    // Stamped explicitly: a nested write does not get the tenant extension's stamp.
    tenantId,
    productId: item.productId || null,
    description: item.description || item.name || "",
    qty: new Prisma.Decimal(item.qty || 1),
    unitCost: new Prisma.Decimal(item.unitCost ?? item.unitPrice ?? 0),
    // `sku` is what matches this line to a product on the next scan from the same supplier.
    sku: item.sku || null,
    packSize: billItemPack(item),
    lineTotal: roundedOrNull(item.lineTotal),
    unitLabel: identity.unitLabel,
    familyProductId: identity.familyProductId,
    familyGroupId: identity.familyGroupId,
  };
}
