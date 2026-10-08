// Manual activation — platform-admin API client (SuperAdmin only). The same `POST .../activate-subscription` the
// tenant's Billing tab posts to (apps/api/src/platform-admin/dto/activate-subscription.dto.ts): the tenant has been
// paid outside Stripe, the period runs `billingPeriodDays` from now and no Stripe charge is ever made.
import { superAdminClient } from "@/lib/admin-api";

export const EXTERNAL_PAYMENT_METHODS = [
  { value: "ZELLE", label: "Zelle" },
  { value: "BANK_TRANSFER", label: "Bank Transfer (ACH/Wire)" },
  { value: "WIRE", label: "Wire Transfer" },
  { value: "CHECK", label: "Check" },
  { value: "CASH", label: "Cash" },
  { value: "OTHER", label: "Other" },
] as const;

export const BILLING_PERIODS = [
  { value: 30, label: "Monthly (30 days)" },
  { value: 90, label: "Quarterly (90 days)" },
  { value: 180, label: "Semi-Annual (180 days)" },
  { value: 365, label: "Annual (365 days)" },
] as const;

export interface ActivateSubscriptionRequest {
  plan: string;
  paymentMethod: string;
  billingPeriodDays: number;
  paymentRef?: string;
}

export async function activateSubscription(
  tenantId: string,
  body: ActivateSubscriptionRequest,
): Promise<unknown> {
  const res = await superAdminClient.post(
    `/platform-admin/tenants/${tenantId}/activate-subscription`,
    body,
  );
  return res.data;
}
