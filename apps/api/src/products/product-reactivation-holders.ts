import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockBarcodeCodes, lockProductRow, type CatalogTx } from "./product-catalog-sync";
import { findCodeHolders, releaseProductCodes, type CodeField } from "./product-code-release";
import { lockProductName } from "./product-name-rules";

/**
 * The one-tx reactivation door (lead/SA ruling): `PATCH /products/:id { isActive: true, deactivateHolderIds: [...] }`.
 * Under the code locks and the name lock it re-derives the ACTIVE products that block this reactivation (the holder of
 * each retired code, and the active same-name product) and refuses (409 HOLDERS_CHANGED) unless the requested ids are
 * EXACTLY that set, so no arbitrary product can be deactivated through this door. Each holder is then deactivated with
 * its codes released and one audit row. The caller restores this product's codes afterwards in the same tx.
 */
export const DEACTIVATED_FOR_REACTIVATION_ACTION = "product.deactivated_for_reactivation";

export async function deactivateReactivationHolders(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string;
    name: string;
    parentProductId: string | null;
    /** Fields the same PATCH sets explicitly: their retired value is dropped, never restored, so never a conflict. */
    skip: readonly CodeField[];
    holderIds: readonly string[];
    actorId: string | null;
  },
): Promise<void> {
  const { tenantId, productId, actorId } = input;
  const skip = new Set(input.skip);
  const me: {
    retiredSku: string | null;
    retiredBarcode: string | null;
    retiredUnitSku: string | null;
  } | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: { retiredSku: true, retiredBarcode: true, retiredUnitSku: true },
  });
  const rows: Array<{ retiredCode: string | null }> = await tx.productBarcode.findMany({
    where: { tenantId, productId, retiredCode: { not: null } },
    select: { retiredCode: true },
  });
  const wanted: Array<{ field: CodeField; value: string }> = [];
  if (me?.retiredSku && !skip.has("sku")) wanted.push({ field: "sku", value: me.retiredSku });
  if (me?.retiredUnitSku && !skip.has("unitSku")) {
    wanted.push({ field: "unitSku", value: me.retiredUnitSku });
  }
  if (!skip.has("barcode")) {
    if (me?.retiredBarcode) wanted.push({ field: "barcode", value: me.retiredBarcode });
    for (const r of rows)
      if (r.retiredCode) wanted.push({ field: "barcode", value: r.retiredCode });
  }

  // House order: code locks, then the name lock, then the holder rows.
  await lockBarcodeCodes(
    tx,
    tenantId,
    wanted.map((w) => w.value),
  );
  await lockProductName(tx, tenantId, input.parentProductId, input.name);

  const holders = new Map<string, string>();
  for (const w of wanted) {
    // eslint-disable-next-line no-await-in-loop -- a handful of codes, each under its lock
    for (const h of await findCodeHolders(tx, tenantId, productId, w.field, w.value)) {
      if (h.isActive) holders.set(h.id, h.name);
    }
  }
  const nameHolder: { id: string; name: string } | null = await tx.product.findFirst({
    where: {
      tenantId,
      isActive: true,
      name: { equals: input.name, mode: "insensitive" },
      parentProductId: input.parentProductId,
      id: { not: productId },
    },
    select: { id: true, name: true },
  });
  if (nameHolder) holders.set(nameHolder.id, nameHolder.name);

  const expected = [...holders.keys()].sort();
  const given = [...new Set(input.holderIds)].sort();
  if (expected.length !== given.length || expected.some((id, i) => id !== given[i])) {
    throw new ConflictException({
      code: API_ERROR_CODES.HOLDERS_CHANGED,
      message: "The products blocking this reactivation changed. Review them and try again.",
      holders: expected.map((id) => ({ productId: id, productName: holders.get(id) })),
    });
  }

  for (const id of expected) {
    // eslint-disable-next-line no-await-in-loop -- id order, each row locked before its write
    await lockProductRow(tx, tenantId, id);
    // eslint-disable-next-line no-await-in-loop
    await tx.product.update({ where: { id }, data: { isActive: false } });
    // eslint-disable-next-line no-await-in-loop
    await releaseProductCodes(tx, { tenantId, productId: id });
    // eslint-disable-next-line no-await-in-loop
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: actorId,
        action: DEACTIVATED_FOR_REACTIVATION_ACTION,
        entityType: "Product",
        entityId: id,
        meta: {
          reactivatedProductId: productId,
          reason: "deactivated to reactivate another product",
        },
      },
    });
  }
}
