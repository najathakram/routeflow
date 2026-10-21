import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { unitNameKey } from "../units/piece-words";

/**
 * SA-797 (row 218, amended): the pack values a product form READ when it opened, sent back with a save that
 * carries `unit`. `Product.updatedAt` is NOT the precondition: every stock and cost write moves it (a purchase,
 * an adjustment, a count), so a form left open while goods are received would 409 for no reason.
 * Each field is checked only when sent; a client that sends none keeps today's behaviour.
 */
export interface ExpectedPack {
  /** The pack word (`Product.unit`) exactly as the form read it. */
  expectedUnit?: string;
  /** The pack size the form read (`null` = no pack size). */
  expectedUnitsPerBox?: number | null;
  /** The tenant unit the pack word named when the form read it (`packTenantUnitId`); `null` = unlinked. */
  expectedTenantUnitId?: string | null;
}

export const EXPECTED_PACK_FIELDS = [
  "expectedUnit",
  "expectedUnitsPerBox",
  "expectedTenantUnitId",
] as const satisfies readonly (keyof ExpectedPack)[];

export const PRODUCT_PACK_STALE_MESSAGE =
  "This product changed since you opened it. Reload to see the latest.";

export const PRODUCT_PACK_PRECONDITION_REQUIRED_MESSAGE =
  "Update the app to change this product's pack size.";

/**
 * Who is writing the pack (SA-797a). REQUIRED on `ProductsService.update`, so the compiler finds every
 * caller: only the PATCH controller is a "client"; import, family writers and scripts are "internal" (they
 * read the locked row themselves).
 */
export type PackPrecondition = "client" | "internal";

/**
 * SA-797a, client saves only: the pack fields sent WITHOUT their expected twin whose value differs from the
 * row read under the pack lock. An equal value is an echo (an older build re-sending what it read) and is
 * accepted. A non-empty result is a 409 PRODUCT_PACK_PRECONDITION_REQUIRED, nothing written: the build never
 * sends the expected pack, so a reload cannot fix it.
 */
export function unguardedPackChanges(
  locked: { unit: string; unitsPerBox: number | null },
  dto: { unit?: string; unitsPerBox?: number | null } & ExpectedPack,
): Array<"unit" | "unitsPerBox"> {
  const out: Array<"unit" | "unitsPerBox"> = [];
  // Keyed by unitNameKey (NFC, trim, case-fold): an old build re-sending an imported NFD or padded word is
  // an echo, not a change. The caller (ProductsService.update) keeps the STORED spelling for such an echo.
  if (
    dto.unit !== undefined &&
    dto.expectedUnit === undefined &&
    unitNameKey(dto.unit) !== unitNameKey(locked.unit)
  ) {
    out.push("unit");
  }
  if (
    dto.unitsPerBox !== undefined &&
    dto.expectedUnitsPerBox === undefined &&
    (dto.unitsPerBox ?? null) !== (locked.unitsPerBox ?? null)
  ) {
    out.push("unitsPerBox");
  }
  return out;
}

/** The longest User-Agent a PRODUCT_PACK_PRECONDITION_REQUIRED log line carries. */
export const LOGGED_AGENT_MAX = 256;

export const sendsExpectedPack = (dto: ExpectedPack): boolean =>
  EXPECTED_PACK_FIELDS.some((k) => dto[k] !== undefined);

type TenantUnitReader = {
  tenantUnit: {
    findFirst(args: {
      where: { tenantId: string; nameKey: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

/** The tenant unit a pack word names (by `unitNameKey`, the key a rename matches products by), or null. */
export async function packTenantUnitIdOf(
  db: TenantUnitReader,
  tenantId: string,
  unit: string | null | undefined,
): Promise<string | null> {
  const nameKey = unitNameKey(unit ?? "");
  if (!nameKey) return null;
  const row = await db.tenantUnit.findFirst({ where: { tenantId, nameKey }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * Compare the expected values with the row read UNDER `lockProductPack` (a rename holds the tenant units lock
 * exclusive, so nothing can move them between this read and the write). Any difference is a 409
 * PRODUCT_PACK_STALE and nothing is written.
 */
export async function assertPackUnchanged(
  db: TenantUnitReader,
  tenantId: string,
  locked: { unit: string; unitsPerBox: number | null },
  expected: ExpectedPack,
): Promise<void> {
  const stale =
    (expected.expectedUnit !== undefined && expected.expectedUnit !== locked.unit) ||
    (expected.expectedUnitsPerBox !== undefined &&
      (expected.expectedUnitsPerBox ?? null) !== (locked.unitsPerBox ?? null)) ||
    (expected.expectedTenantUnitId !== undefined &&
      (expected.expectedTenantUnitId ?? null) !==
        (await packTenantUnitIdOf(db, tenantId, locked.unit)));
  if (stale) {
    throw new ConflictException({
      code: API_ERROR_CODES.PRODUCT_PACK_STALE,
      message: PRODUCT_PACK_STALE_MESSAGE,
    });
  }
}
