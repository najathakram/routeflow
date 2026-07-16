import { BadRequestException } from "@nestjs/common";

/**
 * Phase 4 (W7b): regulated-delivery POD enforcement.
 *
 * A delivery stop is "regulated" when it carries a product in a TrackedCategory
 * that demands an age check and/or an identity check. The rules (spec §8):
 *   - signature POD is mandatory (no safe-drop / leave-at-door);
 *   - the demanded age / identity checks must be affirmatively captured;
 *   - an identity check must record which kind of ID was inspected.
 *
 * Pure functions so the enforcement is unit-testable in isolation and can be
 * shared by the live stop-completion paths — `routes.service.completeStop`
 * (`POST /route-runs/:id/stops/:stopId/complete`) and
 * `routes.service.completeWithPayment` (`.../complete-with-payment`). The DB
 * derivation helpers take a tenant-scoped Prisma
 * client (`prisma.forTenant()` or a transaction client) so the same code works
 * inside and outside a transaction.
 */

/** Allowed values for RouteRunStop.identityType (stored as free text). */
export const IDENTITY_TYPES = [
  "DRIVERS_LICENSE",
  "PASSPORT",
  "STATE_ID",
  "MILITARY_ID",
  "OTHER",
] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

export interface StopRegulatedRequirements {
  requiresAge: boolean;
  requiresId: boolean;
}

export interface AgeIdCategorySets {
  ageCats: Set<string>;
  idCats: Set<string>;
  /** True when the tenant runs at least one age/ID-gated category. */
  any: boolean;
}

/** What the driver submitted on the stop-completion request. */
export interface PodCaptureInput {
  signatureUrl?: string | null;
  safeDropEnabled?: boolean;
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
}

/** The RouteRunStop columns written after a (regulated or plain) completion. */
export interface StopRegulatedPatch {
  ageCheckRequired: boolean;
  identityCheckRequired: boolean;
  ageVerified: boolean;
  identityVerified: boolean;
  identityType: string | null;
  identityVerifiedAt: Date | null;
}

/** Minimal Prisma surface these helpers need (forTenant proxy or tx client). */
export interface RegulatedDeliveryDb {
  trackedCategory: {
    findMany(
      args: unknown,
    ): Promise<Array<{ id: string; requiresAgeCheck: boolean; requiresIdCheck: boolean }>>;
  };
  orderItem: {
    findMany(args: unknown): Promise<
      Array<{
        trackedCategoryId: string | null;
        product: { trackedCategoryId: string | null } | null;
      }>
    >;
  };
}

/**
 * Load the tenant's age/ID-demanding categories once. Callers that resolve many
 * stops (e.g. run dispatch) pass the result into `deriveStopRegulatedRequirements`
 * so the category lookup isn't repeated per stop.
 */
export async function loadAgeIdCategorySets(db: RegulatedDeliveryDb): Promise<AgeIdCategorySets> {
  const cats = await db.trackedCategory.findMany({
    where: { OR: [{ requiresAgeCheck: true }, { requiresIdCheck: true }] },
    select: { id: true, requiresAgeCheck: true, requiresIdCheck: true },
  });
  const ageCats = new Set<string>();
  const idCats = new Set<string>();
  for (const c of cats) {
    if (c.requiresAgeCheck) ageCats.add(c.id);
    if (c.requiresIdCheck) idCats.add(c.id);
  }
  return { ageCats, idCats, any: ageCats.size > 0 || idCats.size > 0 };
}

/**
 * Derive whether a stop demands age / identity checks, from the UNION of:
 *   (a) orders currently linked to the stop (`order.routeRunStopId = stopId`), and
 *   (b) the order-items actually being handed over in this completion
 *       (`orderItemIds` from the request's `deliveries`).
 *
 * (a) is the stop-level requirement (spec §8: a stop containing an age/ID category
 * is regulated). (b) closes a bypass: the completion payload can record a delivery
 * for an item whose order isn't linked to this stop (cross-stop / unlinked), which
 * (a) alone would miss — so the actual goods leaving the truck are always checked.
 * Authoritative at completion time; the persisted RouteRunStop flags are only a
 * driver-UI hint and are never trusted here. A line's category is the order-item
 * snapshot, else the product's current category.
 */
export async function deriveStopRegulatedRequirements(
  db: RegulatedDeliveryDb,
  args: { stopId: string; orderItemIds?: string[] },
  sets: AgeIdCategorySets,
): Promise<StopRegulatedRequirements> {
  if (!sets.any) return { requiresAge: false, requiresId: false };
  const { stopId, orderItemIds } = args;
  const or: unknown[] = [{ order: { routeRunStopId: stopId } }];
  if (orderItemIds && orderItemIds.length > 0) or.push({ id: { in: orderItemIds } });
  const items = await db.orderItem.findMany({
    where: { OR: or },
    select: { trackedCategoryId: true, product: { select: { trackedCategoryId: true } } },
  });
  let requiresAge = false;
  let requiresId = false;
  for (const it of items) {
    const catId = it.trackedCategoryId ?? it.product?.trackedCategoryId ?? null;
    if (!catId) continue;
    if (sets.ageCats.has(catId)) requiresAge = true;
    if (sets.idCats.has(catId)) requiresId = true;
    if (requiresAge && requiresId) break;
  }
  return { requiresAge, requiresId };
}

/**
 * Enforce the regulated-delivery POD rules and return the RouteRunStop patch to
 * persist. Throws BadRequestException (structured `code: REGULATED_POD_REQUIRED`
 * + `reason`) when a regulated stop is missing a required check, a signature, or
 * is being safe-dropped. For non-regulated stops it never throws — it just
 * normalises whatever the driver captured.
 */
export function assertRegulatedDeliverySatisfied(args: {
  requirements: StopRegulatedRequirements;
  capture: PodCaptureInput;
  existingSignatureUrl?: string | null;
  now?: Date;
}): StopRegulatedPatch {
  const { requirements, capture } = args;
  const now = args.now ?? new Date();
  const { requiresAge, requiresId } = requirements;

  const ageVerified = capture.ageVerified === true;
  const identityVerified = capture.identityVerified === true;
  const identityType = capture.identityType?.trim() || null;

  if (requiresAge || requiresId) {
    if (capture.safeDropEnabled === true) {
      throw new BadRequestException({
        code: "REGULATED_POD_REQUIRED",
        reason: "SAFE_DROP_FORBIDDEN",
        message:
          "This is a regulated delivery — it must be handed to a verified recipient (no safe-drop).",
      });
    }
    const signature = (capture.signatureUrl ?? args.existingSignatureUrl ?? "").trim();
    if (!signature) {
      throw new BadRequestException({
        code: "REGULATED_POD_REQUIRED",
        reason: "SIGNATURE_REQUIRED",
        message: "A signature is required to complete a regulated delivery.",
      });
    }
    if (requiresAge && !ageVerified) {
      throw new BadRequestException({
        code: "REGULATED_POD_REQUIRED",
        reason: "AGE_CHECK_REQUIRED",
        message: "Confirm the recipient meets the minimum age before completing this delivery.",
      });
    }
    if (requiresId && !identityVerified) {
      throw new BadRequestException({
        code: "REGULATED_POD_REQUIRED",
        reason: "ID_CHECK_REQUIRED",
        message: "Verify the recipient's ID before completing this delivery.",
      });
    }
    if (requiresId && !identityType) {
      throw new BadRequestException({
        code: "REGULATED_POD_REQUIRED",
        reason: "ID_TYPE_REQUIRED",
        message: "Record which type of ID was checked.",
      });
    }
  }

  return {
    ageCheckRequired: requiresAge,
    identityCheckRequired: requiresId,
    ageVerified,
    identityVerified,
    identityType: identityVerified ? identityType : null,
    identityVerifiedAt: identityVerified ? now : null,
  };
}
