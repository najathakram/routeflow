// Compliance-only fields the CSV importer (B858/B859, FIX3) can write through
// `CustomersService.update`'s `options.compliance` param. Deliberately NOT part of
// `UpdateCustomerDto`/`CreateCustomerDto` (L-181) — the controller never passes `options`, so no
// HTTP surface can reach these fields regardless of DTO whitelist config.
export interface CustomerComplianceInput {
  tobaccoLicenseNo?: string | null;
  tobaccoLicenseExpiry?: Date | null;
  smsConsent?: boolean;
  waConsent?: boolean;
  consentUpdatedAt?: Date;
}
