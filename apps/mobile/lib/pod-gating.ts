export interface RegulatedPodGateInput {
  ageCheckRequired: boolean;
  identityCheckRequired: boolean;
  hasSignature: boolean;
  ageVerified?: boolean;
  identityVerified?: boolean;
  identityType?: string | null;
}

/**
 * Client-side pre-check for the W7b regulated-delivery POD requirements —
 * extracted verbatim (same checks, same order, same message strings) from the
 * inline validation that used to live in
 * app/(driver)/route/stop/[stopId]/payment.tsx's closeStop(). Returns a friendly
 * inline error string when a regulated stop's capture is incomplete, else null.
 *
 * This is a UX shortcut only, to avoid a wasted network round-trip — the server
 * is the sole source of truth and re-validates independently, from a fresh DB
 * read, in apps/api/src/common/regulated-delivery.ts#assertRegulatedDeliverySatisfied
 * (never trusting this client-side result). Mobile has no safe-drop UI
 * (`safeDropEnabled` is never set from payment.tsx), so — unlike the server
 * ladder — this intentionally has no safe-drop check.
 */
export function regulatedPodGateError(input: RegulatedPodGateInput): string | null {
  const {
    ageCheckRequired,
    identityCheckRequired,
    hasSignature,
    ageVerified,
    identityVerified,
    identityType,
  } = input;

  if (!ageCheckRequired && !identityCheckRequired) return null;

  if (!hasSignature) {
    return "A signature is required for this regulated delivery.";
  }
  if (ageCheckRequired && !ageVerified) {
    return "Confirm the recipient's age before completing this regulated delivery.";
  }
  if (identityCheckRequired && !identityVerified) {
    return "Verify the recipient's ID before completing this regulated delivery.";
  }
  if (identityCheckRequired && !identityType) {
    return "Record which type of ID was checked.";
  }
  return null;
}
