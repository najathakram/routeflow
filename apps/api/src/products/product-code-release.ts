import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  barcodeEquivalents,
  lockBarcodeCodes,
  lockProductRow,
  type CatalogTx,
} from "./product-catalog-sync";

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
function collidingColumns(field: CodeField, value: string): Array<Record<string, unknown>> {
  if (field === "sku") return [{ sku: value }, { unitSku: value }];
  // B1214: a barcode collides with every equivalent spelling of the same label (UPC-A <-> EAN-13 ...).
  const same = barcodeEquivalents(value);
  if (field === "barcode") return [{ barcode: { in: same } }, { unitSku: { in: same } }];
  return [{ unitSku: { in: same } }, { sku: value }, { barcode: { in: same } }];
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
/** One code a release gave up: the audit and the caller name exactly what was freed. */
export interface FreedCode {
  field: CodeField;
  value: string;
}

async function releaseLive(
  tx: CatalogTx,
  tenantId: string,
  p: ProductCodes,
  only?: ReadonlyArray<{ field: CodeField; value: string }>,
): Promise<{ fields: CodeField[]; freed: FreedCode[] }> {
  const data: Record<string, string | null> = {};
  const released: CodeField[] = [];
  const freed: FreedCode[] = [];
  for (const field of FIELDS) {
    const live = p[field];
    if (live == null) continue;
    if (only && !only.some((o) => o.field === field && o.value === live)) continue;
    data[RETIRED_COLUMN[field]] = live;
    data[field] = null;
    released.push(field);
    freed.push({ field, value: live });
  }
  if (released.length > 0) await tx.product.update({ where: { id: p.id }, data });

  const liveRows: Array<{ id: string; code: string | null }> = await tx.productBarcode.findMany({
    where: { tenantId, productId: p.id, code: { not: null } },
    select: { id: true, code: true },
  });
  for (const r of liveRows) {
    if (r.code == null) continue; // the query asks for live rows only; a row without a code frees nothing
    if (only && !only.some((o) => o.field === "barcode" && o.value === r.code)) continue;
    // eslint-disable-next-line no-await-in-loop -- one or two rows per product
    await tx.productBarcode.update({
      where: { id: r.id },
      data: { retiredCode: r.code, code: null },
    });
    if (!released.includes("barcode")) released.push("barcode");
    if (!freed.some((f) => f.field === "barcode" && f.value === r.code)) {
      freed.push({ field: "barcode", value: r.code as string });
    }
  }
  return { fields: released, freed };
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
      where: {
        tenantId,
        code: { in: barcodeEquivalents(value) },
        ...(productId ? { productId: { not: productId } } : {}),
      },
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
 * Every code a product holds or retired (legacy columns, level rows, both live and retired): the set a writer of that
 * product locks, in ONE sorted `lockBarcodeCodes` call, BEFORE any row write (Opus #2860 B2, SA-572c).
 */
export async function peekProductCodes(
  tx: CatalogTx,
  tenantId: string,
  productId: string,
): Promise<string[]> {
  const p: ProductCodes | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: CODE_SELECT,
  });
  const rows: Array<{ code: string | null; retiredCode: string | null }> =
    await tx.productBarcode.findMany({
      where: { tenantId, productId },
      select: { code: true, retiredCode: true },
    });
  const out: string[] = [];
  if (p) {
    out.push(
      ...[p.sku, p.barcode, p.unitSku, p.retiredSku, p.retiredBarcode, p.retiredUnitSku].filter(
        (v): v is string => typeof v === "string",
      ),
    );
  }
  for (const r of rows) {
    if (r.code) out.push(r.code);
    if (r.retiredCode) out.push(r.retiredCode);
  }
  return out;
}

/**
 * Cap on distinct codes locked by ONE soft-delete transaction (DELETE /products/clear-all AND DELETE /products/bulk, the
 * 409 CATALOG_TOO_LARGE_FOR_CLEAR_ALL): one advisory lock per code is held to COMMIT, so an unbounded set can exhaust
 * Postgres' instance-wide lock table.
 */
export const CLEAR_ALL_MAX_LOCKED_CODES = 1000;

/**
 * Peek EVERY code of `productIds` and lock them in ONE sorted `lockBarcodeCodes` call (Opus #2860 r2), refusing a set larger
 * than `max` with a readable 409 (clearAll and bulkDelete are not chunked yet; a chunked version is a follow-up). Returns the locked set,
 * which the caller hands to each `releaseProductCodes(..., { lockedCodes })`.
 */
export async function lockCodesOfProducts(
  tx: CatalogTx,
  tenantId: string,
  productIds: readonly string[],
  max = CLEAR_ALL_MAX_LOCKED_CODES,
): Promise<Set<string>> {
  const all: string[] = [];
  for (const productId of productIds) {
    // eslint-disable-next-line no-await-in-loop -- pre-lock peek over a bounded set
    all.push(...(await peekProductCodes(tx, tenantId, productId)));
  }
  const codes = new Set(all.filter((c) => c.trim().length > 0));
  if (codes.size > max) {
    throw new ConflictException({
      code: API_ERROR_CODES.CATALOG_TOO_LARGE_FOR_CLEAR_ALL,
      message: `This catalog has too many product codes to clear in one go (${codes.size}, the limit is ${max}). Delete products in smaller batches.`,
      codeCount: codes.size,
      max,
    });
  }
  await lockBarcodeCodes(tx, tenantId, [...codes]);
  return codes;
}

/**
 * Deactivate: release ALL of this product's live codes. Idempotent — with nothing live it writes nothing. Returns the
 * fields released. Call BEFORE the `isActive` write, never after it: it takes this product's code locks FIRST and then its row
 * lock (house order), so a row already locked by the `isActive` UPDATE would invert the order and deadlock (Opus #2860 B1).
 */
const codesChanged = () =>
  new ConflictException({
    code: API_ERROR_CODES.CODES_CHANGED,
    message: "This product's codes changed while it was being saved. Try again.",
  });

export async function releaseProductCodes(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string;
    /**
     * The codes the caller ALREADY locked in its ONE sorted call. After the row lock the product's live codes must be a
     * subset of it, else 409 CODES_CHANGED (the release would free a code nobody locked: an inverted-order deadlock).
     */
    lockedCodes?: ReadonlySet<string>;
  },
): Promise<{ released: CodeField[]; freed: FreedCode[] }> {
  const { tenantId, productId } = input;
  const peek: ProductCodes | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: CODE_SELECT,
  });
  if (!peek) return { released: [], freed: [] };
  const rowCodes: Array<{ code: string | null }> = await tx.productBarcode.findMany({
    where: { tenantId, productId, code: { not: null } },
    select: { code: true },
  });
  const preLock = [peek.sku, peek.barcode, peek.unitSku, ...rowCodes.map((r) => r.code)];
  if (input.lockedCodes) {
    // Opus #2860 r3 B1: check the PRE-LOCK peek against the caller's set BEFORE taking any lock. A stale set that then
    // locked the new code here (after the caller's row locks) would be a late, inverted-order acquisition: a deadlock
    // that CODES_CHANGED after the fact cannot prevent.
    if (preLock.some((c) => typeof c === "string" && c.trim() && !input.lockedCodes!.has(c))) {
      throw codesChanged();
    }
  }
  await lockBarcodeCodes(tx, tenantId, preLock);
  await lockProductRow(tx, tenantId, productId);
  const p: ProductCodes | null = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: CODE_SELECT,
  });
  if (!p) return { released: [], freed: [] };
  if (input.lockedCodes) {
    const live = await peekProductCodes(tx, tenantId, productId);
    if (live.some((c) => !input.lockedCodes!.has(c))) throw codesChanged();
  }
  const done = await releaseLive(tx, tenantId, p);
  return { released: done.fields, freed: done.freed };
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
      // B1214: the holder may hold an EQUIVALENT spelling; release matches on the exact live value, so name them all.
      for (const value of c.field === "barcode" ? barcodeEquivalents(c.value) : [c.value]) {
        entry.codes.push({ field: c.field, value });
      }
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
          fields: released.fields,
          // What the release actually freed (the holder's own spellings), not every spelling that was searched.
          codes:
            released.freed.length > 0
              ? [...new Set(released.freed.map((f) => f.value))].filter(
                  (v): v is string => typeof v === "string",
                )
              : [...new Set(held.map((h) => h.value))],
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
