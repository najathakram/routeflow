// Compliance-only fields the CSV importer (B858/B859, FIX3) can write through
// `CustomersService.update`'s `options.compliance` param. Deliberately NOT part of
// `UpdateCustomerDto`/`CreateCustomerDto` (L-181) — the controller never passes `options`, so no
// HTTP surface can reach these fields regardless of DTO whitelist config.
//
// SMS/WhatsApp consent is deliberately NOT here (SA-305 (2)): consent is written only by
// `CustomersService.setCustomerConsent`, which records its evidence row in the same transaction.
export interface CustomerComplianceInput {
  tobaccoLicenseNo?: string | null;
  tobaccoLicenseExpiry?: Date | null;
}
