/**
 * Buyer license self-serve gating — status pill + CTA. A VERIFIED license needs
 * no action; every other status can be (re)submitted with a status-specific label.
 */
import { canSubmitLicense, licenseCtaLabel, licenseStatusPill } from "../lib/buyer-licenses-logic";

describe("canSubmitLicense", () => {
  it("blocks only a VERIFIED license", () => {
    expect(canSubmitLicense("VERIFIED")).toBe(false);
    for (const s of ["NONE", "PENDING_REVIEW", "EXPIRED", "REJECTED"] as const) {
      expect(canSubmitLicense(s)).toBe(true);
    }
  });
});

describe("licenseCtaLabel", () => {
  it("varies the label by status (mirrors web)", () => {
    expect(licenseCtaLabel("NONE")).toBe("Submit license");
    expect(licenseCtaLabel("PENDING_REVIEW")).toBe("Update submission");
    expect(licenseCtaLabel("EXPIRED")).toBe("Renew license");
    expect(licenseCtaLabel("REJECTED")).toBe("Resubmit license");
  });
});

describe("licenseStatusPill", () => {
  it("maps every status to a labeled pill", () => {
    expect(licenseStatusPill("VERIFIED")).toEqual({ variant: "green", label: "Verified" });
    expect(licenseStatusPill("PENDING_REVIEW").variant).toBe("orange");
    expect(licenseStatusPill("EXPIRED").variant).toBe("red");
    expect(licenseStatusPill("REJECTED").variant).toBe("red");
    expect(licenseStatusPill("NONE")).toEqual({ variant: "gray", label: "Not submitted" });
  });
});
