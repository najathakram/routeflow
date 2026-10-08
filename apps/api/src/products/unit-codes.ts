import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { lockBarcodeCodes, type CatalogTx } from "./product-catalog-sync";

/**
 * Units rebuild U-2: per-level codes. ONE shared validator + ONE uniqueness check for every code field a ladder
 * save can write (ProductUnit.sku, ProductBarcode.code, and Product.sku / unitSku / barcode for the base and pack).
 * A code belongs to ONE product of the tenant across all five columns; the same product may reuse it on several
 * of its own levels.
 */
export const CODE_MAX_LENGTH = 64;
export const CODE_TOO_LONG = "Keep it to 64 characters or fewer.";
export const CODE_BAD_CHARS =
  "Use letters, numbers and symbols only. A code can't contain line breaks.";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class CodeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeValidationError";
  }
}

/**
 * Trim; blank = "no code" (null). A value over 64 chars or with control characters is refused, EXCEPT a stored legacy
 * value that is re-saved unchanged (`existing`): an ordinary product save must never start failing over old data.
 */
export function normalizeCode(
  raw: string | null | undefined,
  opts: { existing?: string | null } = {},
): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (value.length === 0) return null;
  if (opts.existing != null && value === opts.existing.trim()) return value;
  if (CONTROL_CHARS.test(value)) throw new CodeValidationError(CODE_BAD_CHARS);
  if (value.length > CODE_MAX_LENGTH) throw new CodeValidationError(CODE_TOO_LONG);
  return value;
}

export type CodeKind = "sku" | "barcode";

export interface CodeClaim {
  kind: CodeKind;
  value: string;
  /** The ladder row the code was entered on, so the editor can show the clash under it. */
  level?: string;
}

/** Take the per-code xact locks (the same ones every other catalog writer takes) in sorted order, FIRST. */
export function lockClaims(tx: CatalogTx, tenantId: string, claims: readonly CodeClaim[]) {
  return lockBarcodeCodes(
    tx,
    tenantId,
    claims.map((c) => c.value),
  );
}

/**
 * Throw 409 when another product of the tenant already holds `claim.value` in ANY of Product.sku / unitSku / barcode,
 * ProductUnit.sku or a live ProductBarcode.code. A released code (column NULL, retired* holds it) is not held.
 * The body names the holder, and `inactive: true` when it is a deactivated product that has not released the code.
 */
export async function assertCodeFree(
  tx: CatalogTx,
  input: { tenantId: string; productId: string; claim: CodeClaim },
): Promise<void> {
  const { tenantId, productId, claim } = input;
  const { value } = claim;
  const productHolders: Array<{ id: string; name: string; isActive: boolean }> =
    await tx.product.findMany({
      where: {
        tenantId,
        id: { not: productId },
        OR: [{ sku: value }, { unitSku: value }, { barcode: value }],
      },
      select: { id: true, name: true, isActive: true },
    });
  let holder = productHolders[0];
  if (!holder) {
    const unitRows: Array<{ productId: string }> = await tx.productUnit.findMany({
      where: { tenantId, sku: value, productId: { not: productId } },
      select: { productId: true },
    });
    const codeRows: Array<{ productId: string }> = await tx.productBarcode.findMany({
      where: { tenantId, code: value, productId: { not: productId } },
      select: { productId: true },
    });
    const id = unitRows[0]?.productId ?? codeRows[0]?.productId;
    if (id) {
      holder = await tx.product.findFirst({
        where: { tenantId, id },
        select: { id: true, name: true, isActive: true },
      });
    }
  }
  if (!holder) return;
  const label = claim.kind === "barcode" ? "barcode" : "SKU";
  throw new ConflictException({
    code: claim.kind === "barcode" ? API_ERROR_CODES.BARCODE_TAKEN : API_ERROR_CODES.CODE_TAKEN,
    message: holder.isActive
      ? `That ${label} is already on ${holder.name}. One ${label} can only belong to one product. Use a different one, or change ${holder.name} first.`
      : `That ${label} is on ${holder.name}, which is turned off. Turn it back on to change it, or use a different ${label}.`,
    field: claim.kind,
    level: claim.level,
    value,
    productId: holder.id,
    productName: holder.name,
    ...(holder.isActive ? {} : { inactive: true }),
  });
}
