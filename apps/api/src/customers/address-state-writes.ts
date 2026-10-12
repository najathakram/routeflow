import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  addressStateFields,
  restoredStateFields,
  type AddressStateSnapshot,
} from "./address-state";

/**
 * The ONE pair of writers for "a person chose this state" (Addendum D: fix a customer's state in
 * place). Used by PATCH /customers/:id/addresses/:addressId/state, POST /customers/:id/addresses/minimal
 * and the settings page's bulk set, so the three can never write a state differently.
 *
 * `chosenState` is already a USPS code (the caller ran `normalizeUsState` and 400s otherwise). Both
 * writers store it as the address's `state` text AND derive `stateCode` / `stateNeedsReview` from it
 * with `addressStateFields` (the write-boundary rule `address-writers-inventory.spec.ts` enforces), so
 * the address is confirmed: a code, not flagged for review. A bare code is never ambiguous, so the
 * derivation always yields that code.
 *
 * Guarded many-writes: a Prisma `where` drops an `undefined` key, so both refuse to run without a
 * tenant id and a full list of ids — a many-write must never widen.
 */

function assertIds(tenantId: string, ids: readonly (string | null | undefined)[]): void {
  if (!tenantId || ids.length === 0 || ids.some((id) => typeof id !== "string" || id === "")) {
    throw new BadRequestException("Name at least one address.");
  }
}

/**
 * Sets `chosenState` on exactly `addressIds` of this tenant (and of `customerId`, when given) — the
 * ZIP is NOT consulted: a person picked this state, and the ZIP cross-check guards the machine's
 * reading of free text, not a person's choice. Returns how many rows it wrote; the caller compares.
 */
export async function setChosenAddressState(
  tx: Prisma.TransactionClient,
  tenantId: string,
  addressIds: readonly string[],
  chosenState: string,
  customerId?: string,
): Promise<number> {
  assertIds(tenantId, addressIds);
  const { count } = await tx.customerAddress.updateMany({
    where: {
      tenantId,
      id: { in: [...addressIds] },
      ...(customerId !== undefined ? { customerId } : {}),
    },
    data: { state: chosenState, ...addressStateFields(chosenState, null) },
  });
  return count;
}

export interface MinimalAddressInput {
  /** Pre-generated so the caller (and its audit row / undo handle) knows it without a read-back. */
  id: string;
  customerId: string;
  zip: string | null;
}

/**
 * Creates one minimal address per row: the DEFAULT BILLING address with only a state (and the ZIP when
 * given). There is no `incomplete` column; the street and city stay empty strings (the columns are
 * NOT NULL). Only for customers with NO address (the caller checks), so `isDefault` demotes nobody.
 * A ZIP that contradicts `chosenState` derives `stateCode: null` — callers that accept a ZIP refuse
 * that case before writing.
 */
export async function createMinimalAddresses(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: readonly MinimalAddressInput[],
  chosenState: string,
): Promise<number> {
  assertIds(
    tenantId,
    rows.flatMap((r) => [r.id, r.customerId]),
  );
  const { count } = await tx.customerAddress.createMany({
    data: rows.map((r) => ({
      id: r.id,
      tenantId,
      customerId: r.customerId,
      label: "default",
      line1: "",
      city: "",
      state: chosenState,
      ...addressStateFields(chosenState, r.zip),
      zip: r.zip ?? "",
      isDefault: true,
      addressType: "BILLING",
    })),
  });
  return count;
}

/** `addressType` is free text on create: BILLING in any case / padding (the engine's own reading). */
export function isBillingType(addressType: string | null | undefined): boolean {
  return (addressType ?? "").trim().toUpperCase() === "BILLING";
}

/** The customer's DEFAULT addresses of ANY type, with what tells a blank-street placeholder apart. */
export async function defaultAddresses(
  tx: Prisma.TransactionClient,
  customerId: string,
): Promise<Array<{ id: string; line1: string; city: string; addressType: string | null }>> {
  return tx.customerAddress.findMany({
    where: { customerId, isDefault: true },
    select: { id: true, line1: true, city: true, addressType: true },
  });
}

/**
 * Bulk-state UNDO: restores one address's captured state columns, only if the row is untouched since
 * the bulk write (`updatedAt` still the value it wrote). Returns 1 when restored, 0 when the row was
 * edited since, removed, or already restored (the restore itself moves `updatedAt`, so a repeat is 0).
 */
export async function restoreAddressState(
  tx: Prisma.TransactionClient,
  tenantId: string,
  addressId: string,
  untouchedSince: Date,
  prior: AddressStateSnapshot,
): Promise<number> {
  assertIds(tenantId, [addressId]);
  const { count } = await tx.customerAddress.updateMany({
    where: { tenantId, id: addressId, updatedAt: untouchedSince },
    data: { ...restoredStateFields(prior) },
  });
  return count;
}

/**
 * Bulk-state UNDO: removes an address the same bulk action created, only if it is untouched since
 * (`updatedAt` unchanged) and no route stop points at it. Returns 1 when removed, else 0.
 */
export async function deleteUntouchedAddress(
  tx: Prisma.TransactionClient,
  tenantId: string,
  addressId: string,
  untouchedSince: Date,
): Promise<number> {
  assertIds(tenantId, [addressId]);
  const { count } = await tx.customerAddress.deleteMany({
    where: {
      tenantId,
      id: addressId,
      updatedAt: untouchedSince,
      routeStops: { none: {} },
      routeRunStops: { none: {} },
    },
  });
  return count;
}
