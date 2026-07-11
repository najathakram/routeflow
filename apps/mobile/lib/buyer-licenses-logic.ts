/**
 * Pure helpers for the buyer license self-serve screen — status pill + the
 * submit CTA label/enablement. Mirrors web's licenses page so the UX matches.
 */
export type BuyerAuthStatus = "NONE" | "PENDING_REVIEW" | "VERIFIED" | "EXPIRED" | "REJECTED";

export type LicensePillVariant = "green" | "orange" | "red" | "gray";

export function licenseStatusPill(status: string): { variant: LicensePillVariant; label: string } {
  switch (status) {
    case "VERIFIED":
      return { variant: "green", label: "Verified" };
    case "PENDING_REVIEW":
      return { variant: "orange", label: "Pending review" };
    case "EXPIRED":
      return { variant: "red", label: "Expired" };
    case "REJECTED":
      return { variant: "red", label: "Rejected" };
    default:
      return { variant: "gray", label: "Not submitted" };
  }
}

/** A verified license needs no action; everything else can be (re)submitted. */
export function canSubmitLicense(status: string): boolean {
  return status !== "VERIFIED";
}

/** CTA label by current status (mirrors web). */
export function licenseCtaLabel(status: string): string {
  switch (status) {
    case "PENDING_REVIEW":
      return "Update submission";
    case "EXPIRED":
      return "Renew license";
    case "REJECTED":
      return "Resubmit license";
    default:
      return "Submit license";
  }
}
