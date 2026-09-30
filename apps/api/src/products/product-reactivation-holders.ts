import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockBarcodeCodes, lockProductRow, type CatalogTx } from "./product-catalog-sync";
import {
  CODE_FIELD_LABEL,
  findCodeHolders,
  releaseProductCodes,
  type CodeField,
} from "./product-code-release";
import { lockProductName } from "./product-name-rules";

/**
 * The reactivation resolver (lead/SA-603i): `PATCH /products/:id { isActive: true [, deactivateHolderIds: [...]] }`.
 * Lock order (SA-603a c): every retired code (sorted) -> the name lock -> the target + holder rows `FOR UPDATE` in
 * sorted id order; THEN the ACTIVE holders (of each retired code, and the same-name product) are re-derived and the
 * set compared. Without `deactivateHolderIds` any holder is a 409 listing ALL of them; with it, the ids must be EXACTLY
 * that set (a stale client can neither deactivate a product that no longer conflicts nor miss one that newly does,
 * and a foreign-tenant id is simply never in the set). A holder that is a FAMILY container or has ACTIVE variants is
 * never one-call deactivatable (`blocked: "HAS_ACTIVE_VARIANTS"`). Each deactivated holder has its colliding codes
 * released and one audit row. The caller restores this product's codes afterwards in the same tx.
 */
export const DEACTIVATED_FOR_REACTIVATION_ACTION = "product.deactivated_for_reactivation";

export interface ReactivationHolder {
  code:
    | typeof API_ERROR_CODES.CODE_TAKEN
    | typeof API_ERROR_CODES.BARCODE_TAKEN
    | typeof API_ERROR_CODES.NAME_TAKEN;
  field: CodeField | "name";
  value: string;
  productId: string;
  productName: string;
  blocked?: "HAS_ACTIVE_VARIANTS";
}

const FIELD_ORDER: Array<CodeField | "name"> = ["sku", "unitSku", "barcode", "name"];

function conflict(holders: ReactivationHolder[]): ConflictException {
  const first = holders[0];
  if (!first) {
    return new ConflictException({
      code: API_ERROR_CODES.HOLDERS_CHANGED,
      message: "Nothing blocks this reactivation any more. Try again without naming holders.",
      holders: [],
    });
  }
  const label = first.field === "name" ? "Name" : CODE_FIELD_LABEL[first.field];
  return new ConflictException({
    code: first.code,
    message: `${label[0].toUpperCase()}${label.slice(1)} "${first.value}" is already used by ${first.productName}.`,
    ...(first.field === "barcode" ? { barcode: first.value } : {}),
    field: first.field,
    value: first.value,
    productId: first.productId,
    productName: first.productName,
    holders,
  });
}

async function deriveHolders(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string;
    name: string;
    parentProductId: string | null;
    wanted: Array<{ field: CodeField; value: string }>;
  },
): Promise<ReactivationHolder[]> {
  const { tenantId, productId } = input;
  const out: ReactivationHolder[] = [];
  for (const w of input.wanted) {
    // eslint-disable-next-line no-await-in-loop -- a handful of codes, each under its lock
    for (const h of await findCodeHolders(tx, tenantId, productId, w.field, w.value)) {
      if (!h.isActive) continue;
      out.push({
        code: w.field === "barcode" ? API_ERROR_CODES.BARCODE_TAKEN : API_ERROR_CODES.CODE_TAKEN,
        field: w.field,
        value: w.value,
        productId: h.id,
        productName: h.name,
      });
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
  if (nameHolder) {
    out.push({
      code: API_ERROR_CODES.NAME_TAKEN,
      field: "name",
      value: input.name,
      productId: nameHolder.id,
      productName: nameHolder.name,
    });
  }
  // Dedupe (productId, field, value); codes first in field order, then the name; stable.
  const seen = new Set<string>();
  const uniq = out.filter((h) => {
    const k = `${h.productId}|${h.field}|${h.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniq.sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
  // A container (FAMILY) or a holder with ACTIVE variants is never one-call deactivatable.
  const ids = [...new Set(uniq.map((h) => h.productId))];
  if (ids.length > 0) {
    const kinds: Array<{ id: string; kind?: string | null }> = await tx.product.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, kind: true },
    });
    const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
    const kids: Array<{ parentProductId: string | null }> = await tx.product.findMany({
      where: { tenantId, parentProductId: { in: ids }, isActive: true },
      select: { parentProductId: true },
    });
    const parents = new Set(kids.map((k) => k.parentProductId));
    for (const h of uniq) {
      if (kindOf.get(h.productId) === "FAMILY" || parents.has(h.productId)) {
        h.blocked = "HAS_ACTIVE_VARIANTS";
      }
    }
  }
  return uniq;
}

export async function resolveReactivationConflicts(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string;
    name: string;
    parentProductId: string | null;
    /** Fields the same PATCH sets explicitly: their retired value is dropped, never restored, so never a conflict. */
    skip: readonly CodeField[];
    /** undefined / empty = "just tell me": any holder is a 409 listing all of them. */
    holderIds?: readonly string[];
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
  const derive = {
    tenantId,
    productId,
    name: input.name,
    parentProductId: input.parentProductId,
    wanted,
  };

  // 1. codes (sorted, FIRST), 2. the name lock.
  await lockBarcodeCodes(
    tx,
    tenantId,
    wanted.map((w) => w.value),
  );
  await lockProductName(tx, tenantId, input.parentProductId, input.name);

  let holders = await deriveHolders(tx, derive);
  const given = [...new Set(input.holderIds ?? [])].sort();
  if (given.length === 0) {
    if (holders.length > 0) throw conflict(holders);
    return;
  }
  const sameSet = (hs: ReactivationHolder[]) => {
    const exp = [...new Set(hs.map((h) => h.productId))].sort();
    return exp.length === given.length && exp.every((id, i) => id === given[i]);
  };
  if (!sameSet(holders) || holders.some((h) => h.blocked)) throw conflict(holders);

  // 3. the target + holder rows FOR UPDATE, sorted by id.
  const lockIds = [...new Set([productId, ...holders.map((h) => h.productId)])].sort();
  for (const id of lockIds) {
    // eslint-disable-next-line no-await-in-loop -- sorted id order is the contract
    await lockProductRow(tx, tenantId, id);
  }
  // 4. re-derive under the row locks; the set must still be exactly what was named.
  holders = await deriveHolders(tx, derive);
  if (!sameSet(holders) || holders.some((h) => h.blocked)) throw conflict(holders);

  for (const id of [...new Set(holders.map((h) => h.productId))].sort()) {
    const freed = holders
      .filter((h) => h.productId === id)
      .map((h) => ({ field: h.field, value: h.value }));
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
          freed,
          reason: `deactivated to reactivate ${productId}`,
        },
      },
    });
  }
}
