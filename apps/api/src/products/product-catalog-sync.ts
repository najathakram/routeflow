import { ConflictException } from "@nestjs/common";
import { BarcodeOrigin, PackagingLevel, Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { parseFocalFromKey, planBarcodeRows } from "./product-barcode-rules";

/**
 * Any Prisma 7 interactive-transaction client — raw or the tenant-wrapped Proxy `tenantTransaction`
 * hands its callback (which forwards `$`-prefixed calls straight through, per PrismaService's
 * `isTxClient`/`_wrapTxWithTenant`). Kept loose (a unit spec passes a hand-built mock). Every helper
 * here still writes `tenantId` explicitly on every where/data clause rather than leaning on the
 * proxy's auto-injection — Prisma drops an `undefined` where-key rather than erroring, so a caller
 * that forgets to thread a real id would otherwise widen a many-write to the whole tenant.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CatalogTx = any;

const BARCODE_LOCK_FAMILY = "product-barcode";

function throwBarcodeTaken(code: string, holderProductId: string): never {
  throw new ConflictException({
    code: API_ERROR_CODES.BARCODE_TAKEN,
    message: `Barcode ${code} is already used by another product`,
    barcode: code,
    productId: holderProductId,
  });
}

/** Non-blank, deduped, SORTED codes — the exact order SA-572b/c requires the locks taken in. */
function normalizeCodes(codes: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const code of codes) {
    if (typeof code !== "string") continue;
    if (code.trim().length === 0) continue;
    set.add(code);
  }
  return Array.from(set).sort();
}

/**
 * SA-572b Q4 / SA-572c: lock every DISTINCT non-blank code this write touches, deduped and in
 * SORTED order, before any read or write against those codes (the source-order pin SA-572c
 * requires — this call must precede the first `productBarcode.find*`/`product.find*` read a caller
 * makes). Each lock is a Postgres xact advisory lock keyed on `${tenantId}:${code}`, scoped to the
 * enclosing transaction (auto-released at commit/rollback) — the same `pg_advisory_xact_lock`
 * pattern as `billing.service.ts:771`. NOT `withAdvisoryLock` (common/db-locks.ts) — that helper is
 * session-scoped on a pinned per-family pool, wrong for a lock that must live and die with this tx.
 * #2717 M1.
 */
export async function lockBarcodeCodes(
  tx: CatalogTx,
  tenantId: string,
  codes: Array<string | null | undefined>,
): Promise<void> {
  const sorted = normalizeCodes(codes);
  for (const code of sorted) {
    // Serial by design: each lock statement must complete (and be recorded, for the source-order
    // pin the mocked spec asserts) before the next is issued.
    // eslint-disable-next-line no-await-in-loop
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BARCODE_LOCK_FAMILY}), hashtext(${`${tenantId}:${code}`}))`;
  }
}

/**
 * SA-572b Q3/Q4: called AFTER the lock — does another product of this tenant already hold `code`?
 * A holder is either a `ProductBarcode` row at (tenantId, code) whose productId differs, OR (a
 * product not yet backfilled onto rows) a `Product` row with (tenantId, barcode = code) whose id
 * differs. `productId: null` means "a product being created" — nothing can be "itself" yet, so ANY
 * existing holder of the code counts. Throws the 409 BARCODE_TAKEN body `{code, message, barcode,
 * productId}` the NEW write paths answer with; the legacy 400 "Barcode already exists" pre-checks
 * in products.service.ts are untouched. #2717 M1.
 */
export async function assertBarcodeAvailable(
  tx: CatalogTx,
  input: { tenantId: string; productId: string | null; code: string },
): Promise<void> {
  const { tenantId, productId, code } = input;

  const rowHolder = await tx.productBarcode.findFirst({
    where: {
      tenantId,
      code,
      ...(productId ? { productId: { not: productId } } : {}),
    },
    select: { productId: true },
  });
  if (rowHolder) throwBarcodeTaken(code, rowHolder.productId);

  const legacyHolder = await tx.product.findFirst({
    where: {
      tenantId,
      barcode: code,
      ...(productId ? { id: { not: productId } } : {}),
    },
    select: { id: true },
  });
  if (legacyHolder) throwBarcodeTaken(code, legacyHolder.id);
}

/**
 * SA-572a belt: a P2002 on `Product.barcode` (`@@unique([tenantId, barcode])`) or `ProductBarcode`
 * (`@@unique([tenantId, code, level])`) slipping past the advisory-lock check above — e.g. a legacy
 * writer this M1 package didn't reach — is mapped to the same 409 BARCODE_TAKEN rather than a raw
 * 500. The holder's productId is unknown from the constraint violation alone, so it is omitted
 * (`null`); callers that need it should rely on `assertBarcodeAvailable` running first. #2717 M1.
 */
export function isBarcodeUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  const fields = Array.isArray(target)
    ? target.map(String)
    : typeof target === "string"
      ? [target]
      : [];
  return fields.some((f) => f.includes("barcode") || f.includes("code"));
}

export function mapBarcodeUniqueViolation(e: unknown, code: string): never {
  if (isBarcodeUniqueViolation(e)) {
    throw new ConflictException({
      code: API_ERROR_CODES.BARCODE_TAKEN,
      message: `Barcode ${code} is already used by another product`,
      barcode: code,
      productId: null,
    });
  }
  throw e;
}

type BarcodeRowTuple = {
  code: string;
  level: PackagingLevel;
  origin: BarcodeOrigin;
  copiedFromLevel: PackagingLevel | null;
  primaryFor: PackagingLevel | null;
};

function tupleKey(r: BarcodeRowTuple): string {
  return `${r.code}\u0000${r.level}\u0000${r.origin}\u0000${r.copiedFromLevel ?? ""}\u0000${r.primaryFor ?? ""}`;
}

/**
 * SA-572b Q4/Q6: make this product's `ProductBarcode` rows EXACTLY `planBarcodeRows({barcode,
 * unitsPerBox})` — locking [barcode, previousBarcode] FIRST (source-order pin), then checking the
 * NEW code is free, then diffing rows by full tuple (code/level/origin/copiedFromLevel/primaryFor):
 * delete what's no longer desired, create what's missing, touch nothing that already matches.
 *
 * M1 NOTE: every row this product owns today is a legacy mirror, so "delete what's not desired" is
 * a full mirror replace. M4+, once a non-mirror row can exist (a second scanned code, a print
 * override), this diff must narrow to mirror-origin rows only, or a real scanned code would be
 * deleted out from under the sync.
 *
 * `tenantId`/`productId` are asserted non-empty up front — Prisma silently drops an `undefined`
 * where-key rather than erroring, so a caller that forgot to thread a real id would otherwise widen
 * the `deleteMany` below to every row in the table. #2717 M1.
 */
export async function syncProductBarcodesFromLegacy(
  tx: CatalogTx,
  input: {
    tenantId: string;
    productId: string;
    barcode: string | null | undefined;
    unitsPerBox: number | null | undefined;
    previousBarcode?: string | null | undefined;
  },
): Promise<void> {
  const { tenantId, productId, barcode, unitsPerBox, previousBarcode } = input;
  if (!tenantId || !productId) {
    throw new Error(
      "syncProductBarcodesFromLegacy: tenantId and productId are required (an empty id would widen the row diff to the whole tenant)",
    );
  }

  // Source-order pin (SA-572c): both codes this write could touch, locked before any read below.
  await lockBarcodeCodes(tx, tenantId, [barcode, previousBarcode]);

  const trimmed = typeof barcode === "string" && barcode.trim().length > 0 ? barcode : null;
  if (trimmed) await assertBarcodeAvailable(tx, { tenantId, productId, code: trimmed });

  const desired = planBarcodeRows({ barcode: trimmed, unitsPerBox });

  const existingRows: Array<{ id: string } & BarcodeRowTuple> = await tx.productBarcode.findMany({
    where: { tenantId, productId },
    select: {
      id: true,
      code: true,
      level: true,
      origin: true,
      copiedFromLevel: true,
      primaryFor: true,
    },
  });

  const desiredKeys = new Set(desired.map(tupleKey));
  const existingKeys = new Set(existingRows.map(tupleKey));

  const toDeleteIds = existingRows.filter((r) => !desiredKeys.has(tupleKey(r))).map((r) => r.id);
  const toCreate = desired.filter((r) => !existingKeys.has(tupleKey(r)));

  if (toDeleteIds.length > 0) {
    await tx.productBarcode.deleteMany({
      where: { tenantId, productId, id: { in: toDeleteIds } },
    });
  }
  if (toCreate.length > 0) {
    await tx.productBarcode.createMany({
      data: toCreate.map((r) => ({
        tenantId,
        productId,
        code: r.code,
        level: r.level,
        symbology: r.symbology,
        origin: r.origin,
        copiedFromLevel: r.copiedFromLevel,
        primaryFor: r.primaryFor,
      })),
    });
  }
}

/**
 * SA-572b Q4/Q6: make this product's `ProductImage` rows match `imageKeys` in order (sortOrder =
 * index, isPrimary = index 0, focal parsed via `parseFocalFromKey`) — delete rows whose storageKey
 * fell out of the array, update rows whose sortOrder/isPrimary/focal drifted, create the rest.
 * Call this AFTER the legacy `product.update` in the SAME tx: the UPDATE statement takes the row
 * lock on `Product`, so whichever concurrent writer commits last also has its `imageKeys` value be
 * the one this sync mirrors (the row lock — not this helper — is what serializes two concurrent
 * image edits on one product). #2717 M1.
 */
export async function syncProductImagesFromLegacy(
  tx: CatalogTx,
  input: { tenantId: string; productId: string; imageKeys: string[] },
): Promise<void> {
  const { tenantId, productId, imageKeys } = input;
  if (!tenantId || !productId) {
    throw new Error(
      "syncProductImagesFromLegacy: tenantId and productId are required (an empty id would widen the row diff to the whole tenant)",
    );
  }

  const desired = imageKeys.map((storageKey, index) => {
    const focal = parseFocalFromKey(storageKey);
    return {
      storageKey,
      sortOrder: index,
      isPrimary: index === 0,
      focalX: focal ? focal.x : null,
      focalY: focal ? focal.y : null,
    };
  });
  const desiredByKey = new Map(desired.map((d) => [d.storageKey, d]));

  const existingRows: Array<{
    id: string;
    storageKey: string;
    sortOrder: number;
    isPrimary: boolean;
    focalX: number | null;
    focalY: number | null;
  }> = await tx.productImage.findMany({
    where: { tenantId, productId },
    select: {
      id: true,
      storageKey: true,
      sortOrder: true,
      isPrimary: true,
      focalX: true,
      focalY: true,
    },
  });
  const existingByKey = new Map(existingRows.map((r) => [r.storageKey, r]));

  const toDeleteIds = existingRows.filter((r) => !desiredByKey.has(r.storageKey)).map((r) => r.id);
  if (toDeleteIds.length > 0) {
    await tx.productImage.deleteMany({ where: { tenantId, productId, id: { in: toDeleteIds } } });
  }

  for (const d of desired) {
    const existing = existingByKey.get(d.storageKey);
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await tx.productImage.create({
        data: {
          tenantId,
          productId,
          storageKey: d.storageKey,
          sortOrder: d.sortOrder,
          isPrimary: d.isPrimary,
          focalX: d.focalX,
          focalY: d.focalY,
        },
      });
    } else if (
      existing.sortOrder !== d.sortOrder ||
      existing.isPrimary !== d.isPrimary ||
      existing.focalX !== d.focalX ||
      existing.focalY !== d.focalY
    ) {
      // eslint-disable-next-line no-await-in-loop
      await tx.productImage.update({
        where: { id: existing.id },
        data: {
          sortOrder: d.sortOrder,
          isPrimary: d.isPrimary,
          focalX: d.focalX,
          focalY: d.focalY,
        },
      });
    }
  }
}
