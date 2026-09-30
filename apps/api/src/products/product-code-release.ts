import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockBarcodeCodes, lockProductRow, type CatalogTx } from "./product-catalog-sync";

/**
 * SA-603 / SA-603a (c): one-ACTIVE-holder-per-code. A deactivated product RELEASES its sku / barcode / unitSku
 * (legacy column -> `retired*`, `ProductBarcode` row -> `retiredCode`), so the full uniques are never weakened. A
 * colliding INACTIVE holder is released lazily, in the claiming tx, with one AuditLog row; an ACTIVE holder is a 409
 * naming it. Reactivate restores only the codes still free. Every function runs INSIDE the caller's transaction and
 * takes the code advisory locks FIRST (house order: code locks, then the holder row), then writes.
 */
export type CodeField = "sku" | "barcode" | "unitSku";

export const CODE_FIELD_LABEL: Record<CodeField, string> = {
  sku: "SKU",
  barcode: "barcode",
  unitSku: "unit code",
};

export const CODE_RELEASED_ON_REUSE_ACTION = "product.code_released_on_reuse";

const RETIRED_COLUMN = {
  sku: "retiredSku",
  barcode: "retiredBarcode",
  unitSku: "retiredUnitSku",
} as const;

const FIELDS: readonly CodeField[] = ["sku", "barcode", "unitSku"];

/** The codes a create/update DTO sets that differ from what the product already holds. */
export function codeClaims(
  dto: Partial<Record<CodeField, string | null | undefined>>,
  existing: Partial<Record<CodeField, string | null>> | null,
): Array<{ field: CodeField; value: string }> {
  const out: Array<{ field: CodeField; value: string }> = [];
  for (const field of FIELDS) {
    const value = dto[field];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (existing && existing[field] === value) continue;
    out.push({ field, value });
  }
  return out;
}

interface ProductCodes {
  id: string;
  name: string;
  isActive: boolean;
  sku: string | null;
  barcode: string | null;
  unitSku: string | null;
  retiredSku: string | null;
  retiredBarcode: string | null;
  retiredUnitSku: string | null;
}

const CODE_SELECT = {
  id: true,
  name: true,
  isActive: true,
  sku: true,
  barcode: true,
  unitSku: true,
  retiredSku: true,
  retiredBarcode: true,
  retiredUnitSku: true,
} as const;

/** The legacy namespaces (create/update pre-checks): sku vs sku|unitSku, barcode vs barcode|unitSku, unitSku vs all. */
function collidingColumns(field: CodeField, value: string): Array<Record<string, string>> {
  if (field === "sku") return [{ sku: value }, { unitSku: value }];
  if (field === "barcode") return [{ barcode: value }, { unitSku: value }];
  return [{ unitSku: value }, { sku: value }, { barcode: value }];
}

function taken(field: CodeField, value: string, holder: { id: string; name: string }): never {
  const label = CODE_FIELD_LABEL[field];
  // A barcode keeps today's BARCODE_TAKEN body (clients already map it); sku / unitSku use CODE_TAKEN.
  throw new ConflictException({
    code: field === "barcode" ? API_ERROR_CODES.BARCODE_TAKEN : API_ERROR_CODES.CODE_TAKEN,
    ...(field === "barcode" ? { barcode: value } : {}),
    message: `${label[0].toUpperCase()}${label.slice(1)} "${value}" is already used by ${holder.name}.`,
    field,
    value,
    productId: holder.id,
    productName: holder.name,
  });
}

/** Move a product's live codes into retired* and mirror them onto its level rows. Only writes what is live. */
async function releaseLive(
  tx: CatalogTx,
  tenantId: string,
  p: ProductCodes,
  only?: ReadonlyArray<{ field: CodeField; value: string }>,
): Promise<CodeField[]> {
  const data: Record<string, string | null> = {};
  const released: CodeField[] = [];
  for (const field of FIELDS) {
    const live = p[field];
    if (live == null) continue;
    if (only && !only.some((o) => o.field === field && o.value === live)) continue;
    data[RETIRED_COLUMN[field]] = live;
    data[field] = null;
    released.push(field);
  }
  if (released.length > 0) await tx.product.update({ where: { id: p.id }, data });

  const liveRows: Array<{ id: string; code: string | null }> = await tx.productBarcode.findMany({
    where: { tenantId, productId: p.id, code: { not: null } },
    select: { id: true, code: true },
  });
  for (const r of liveRows) {
    if (only && !only.some((o) => o.field === "barcode" && o.value === r.code)) continue;
    // eslint-disable-next-line no-await-in-loop -- one or two rows per product
    await tx.productBarcode.update({
      where: { id: r.id },
      data: { retiredCode: r.code, code: null },
    });
    if (!released.includes("barcode")) released.push("barcode");
  }
  return released;
}

/**
 * Every OTHER product of the tenant holding `value` in `field`'s namespace (legacy columns per the legacy rules, plus
 * the level rows for a barcode), active or not. The caller has taken the code lock. `productId` null = a product being
 * created (nothing is "itself").
 */
export async function findCodeHolders(
  tx: CatalogTx,
  tenantId: string,
  productId: string | null,
  field: CodeField,
  value: string,
): Promise<ProductCodes[]> {
  const legacy: ProductCodes[] = await tx.product.findMany({
    where: {
      tenantId,
      ...(productId ? { id: { not: productId } } : {}),
      OR: collidingColumns(field, value),
    },
    select: CODE_SELECT,
  });
  const holders = [...legacy];
  if (field === "barcode") {
    const rows: Array<{ productId: string }> = await tx.productBarcode.findMany({
      where: { tenantId, code: value, ...(productId ? { productId: { not: productId } } : {}) },
      select: { productId: true },
    });
    const ids = [...new Set(rows.map((r) => r.productId))].filter(
      (id) => !holders.some((h) => h.id === id),
    );
    if (ids.length > 0) {
      holders.push(
        ...(await tx.product.findMany({
          where: { tenantId, id: { in: ids } },
          select: CODE_SELECT,
        })),
      );
    }
  }
  return holders;
}

/**
 * Deactivate: release ALL of this product's live codes. Idempotent — with nothing live it writes nothing. Returns the
 * fields released. Call inside the same tx that flips `isActive`.
 */
export async function releaseProductCodes(
  tx: CatalogTx,
  input: { tenantId: string; productId: string },
): Promise<{ released: CodeField[] }> {
  const { tenantId, productId } = input;
  const peek: ProductCodes | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: CODE_SELECT,
  });
  if (!peek) return { released: [] };
  const rowCodes: Array<{ code: string | null }> = await tx.productBarcode.findMany({
    where: { tenantId, productId, code: { not: null } },
    select: { code: true },
  });
  await lockBarcodeCodes(tx, tenantId, [
    peek.sku,
    peek.barcode,
    peek.unitSku,
    ...rowCodes.map((r) => r.code),
  ]);
  await lockProductRow(tx, tenantId, productId);
  const p: ProductCodes | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: CODE_SELECT,
  });
  if (!p) return { released: [] };
  return { released: await releaseLive(tx, tenantId, p) };
}

/**
 * The claiming side: `codes` are about to be written onto `productId` (null = a product being created). For each,
 * an ACTIVE holder -> 409 CODE_TAKEN naming it; an INACTIVE holder -> released in this tx + one AuditLog row
 * (the actor, the holder's id, which code). Nothing else of the holder is touched.
 */
export async function claimCodes(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string | null;
    actorId: string | null;
    codes: ReadonlyArray<{ field: CodeField; value: string }>;
  },
): Promise<void> {
  const { tenantId, productId, actorId } = input;
  const codes = input.codes.filter((c) => typeof c.value === "string" && c.value.trim().length > 0);
  if (codes.length === 0) return;
  await lockBarcodeCodes(
    tx,
    tenantId,
    codes.map((c) => c.value),
  );

  const toRelease = new Map<
    string,
    { holder: ProductCodes; codes: Array<{ field: CodeField; value: string }> }
  >();
  for (const c of codes) {
    // eslint-disable-next-line no-await-in-loop -- a handful of codes, each resolved under its own lock
    const holders = await findCodeHolders(tx, tenantId, productId, c.field, c.value);
    const active = holders.find((h) => h.isActive);
    if (active) taken(c.field, c.value, active);
    for (const h of holders) {
      const entry = toRelease.get(h.id) ?? { holder: h, codes: [] };
      entry.codes.push({ field: c.field, value: c.value });
      toRelease.set(h.id, entry);
    }
  }

  for (const { holder, codes: held } of toRelease.values()) {
    // eslint-disable-next-line no-await-in-loop -- house order: code locks (above), then the holder row
    await lockProductRow(tx, tenantId, holder.id);
    // eslint-disable-next-line no-await-in-loop
    const fresh: ProductCodes | null = await tx.product.findFirst({
      where: { id: holder.id, tenantId },
      select: CODE_SELECT,
    });
    // Re-checked under the row lock: a holder reactivated in the meantime is now ACTIVE -> 409.
    if (fresh?.isActive) taken(held[0].field, held[0].value, fresh);
    // eslint-disable-next-line no-await-in-loop
    const released = await releaseLive(tx, tenantId, fresh ?? holder, held);
    // eslint-disable-next-line no-await-in-loop
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: actorId,
        action: CODE_RELEASED_ON_REUSE_ACTION,
        entityType: "Product",
        entityId: holder.id,
        meta: {
          fields: released,
          codes: held.map((h) => h.value),
          claimedBy: productId,
          reason: "released on reuse",
        },
      },
    });
  }
}

/**
 * Reactivate: restore each retired code that is still free (an INACTIVE holder is released lazily, an ACTIVE one is a
 * 409 naming it). A field the operator re-set while inactive keeps its live value and only drops the stale retired
 * one. Call inside the tx that flips `isActive` back on.
 */
export async function restoreProductCodes(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string;
    actorId: string | null;
    /** Fields the same write sets explicitly: their retired value is dropped, never restored over them. */
    skip?: readonly CodeField[];
  },
): Promise<void> {
  const { tenantId, productId, actorId } = input;
  const skip = new Set(input.skip ?? []);
  const p: ProductCodes | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: CODE_SELECT,
  });
  if (!p) return;
  const retiredRows: Array<{ id: string; retiredCode: string | null }> =
    await tx.productBarcode.findMany({
      where: { tenantId, productId, retiredCode: { not: null } },
      select: { id: true, retiredCode: true },
    });
  const wanted: Array<{ field: CodeField; value: string }> = [];
  for (const field of FIELDS) {
    const retired = p[RETIRED_COLUMN[field]];
    if (retired != null && p[field] == null && !skip.has(field))
      wanted.push({ field, value: retired });
  }
  if (retiredRows.length === 0 && FIELDS.every((f) => p[RETIRED_COLUMN[f]] == null)) return;
  const claimed = [...wanted];
  for (const r of skip.has("barcode") ? [] : retiredRows) {
    const code = r.retiredCode!;
    if (!claimed.some((c) => c.field === "barcode" && c.value === code)) {
      claimed.push({ field: "barcode", value: code });
    }
  }
  await claimCodes(tx, { tenantId, productId, actorId, codes: claimed });
  await lockProductRow(tx, tenantId, productId);

  const data: Record<string, string | null> = {};
  for (const field of FIELDS) {
    const retired = p[RETIRED_COLUMN[field]];
    if (retired == null) continue;
    data[RETIRED_COLUMN[field]] = null;
    if (p[field] == null && !skip.has(field)) data[field] = retired;
  }
  if (Object.keys(data).length > 0) await tx.product.update({ where: { id: productId }, data });
  if (skip.has("barcode")) {
    // The operator re-set the barcode while inactive: the stale released rows are dropped (the sync writes the new
    // ones) — left in place they would hold the (productId, primaryFor) unique.
    if (retiredRows.length > 0) {
      await tx.productBarcode.deleteMany({
        where: { tenantId, productId, id: { in: retiredRows.map((r) => r.id) } },
      });
    }
    return;
  }
  for (const r of retiredRows) {
    // eslint-disable-next-line no-await-in-loop
    await tx.productBarcode.update({
      where: { id: r.id },
      data: { code: r.retiredCode, retiredCode: null },
    });
  }
}
