/**
 * Manual Activation (a tenant paid outside Stripe): the payment methods and billing periods the platform-admin
 * `POST /platform-admin/tenants/:id/activate-subscription` accepts. ONE source: the api DTO validates against
 * these values, and the tenant Billing tab and the Create Tenant "Start active" form offer them.
 */
export const EXTERNAL_PAYMENT_METHODS = [
  { value: "ZELLE", label: "Zelle" },
  { value: "BANK_TRANSFER", label: "Bank Transfer (ACH/Wire)" },
  { value: "WIRE", label: "Wire Transfer" },
  { value: "CHECK", label: "Check" },
  { value: "CASH", label: "Cash" },
  { value: "OTHER", label: "Other" },
] as const;

export type ExternalPaymentMethod = (typeof EXTERNAL_PAYMENT_METHODS)[number]["value"];

/** The bare values, in the same order (what `@IsIn` takes). */
export const EXTERNAL_PAYMENT_METHOD_VALUES = EXTERNAL_PAYMENT_METHODS.map((m) => m.value) as [
  ExternalPaymentMethod,
  ...ExternalPaymentMethod[],
];

export const BILLING_PERIODS = [
  { value: 30, label: "Monthly (30 days)" },
  { value: 90, label: "Quarterly (90 days)" },
  { value: 180, label: "Semi-Annual (180 days)" },
  { value: 365, label: "Annual (365 days)" },
] as const;
