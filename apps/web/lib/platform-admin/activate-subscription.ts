// Manual activation — platform-admin API client (SuperAdmin only). The same `POST .../activate-subscription` the
// tenant's Billing tab posts to (apps/api/src/platform-admin/dto/activate-subscription.dto.ts): the tenant has been
// paid outside Stripe, the period runs `billingPeriodDays` from now and no Stripe charge is ever made.
import type { ManualActivationResult } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";

export interface ActivateSubscriptionRequest {
  plan: string;
  paymentMethod: string;
  billingPeriodDays: number;
  paymentRef?: string;
}

export async function activateSubscription(
  tenantId: string,
  body: ActivateSubscriptionRequest,
): Promise<ManualActivationResult> {
  const res = await superAdminClient.post(
    `/platform-admin/tenants/${tenantId}/activate-subscription`,
    body,
  );
  return res.data;
}
