import { IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { TenantPlan } from "@prisma/client";
import { EXTERNAL_PAYMENT_METHOD_VALUES, type ExternalPaymentMethod } from "@routeflow/types";
import { SELECTABLE_TENANT_PLANS } from "../../billing/plan-catalog.constants";

// One source with the web forms: packages/types/api/external-payment.ts. Re-exported under the names the api uses.
export const EXTERNAL_PAYMENT_METHODS = EXTERNAL_PAYMENT_METHOD_VALUES;
export type { ExternalPaymentMethod };

export class ActivateSubscriptionDto {
  // GROWTH/SCALE are selectable here as of Phase 0 Task 10 — see SELECTABLE_TENANT_PLANS in
  // plan-catalog.constants.ts.
  @IsIn(SELECTABLE_TENANT_PLANS)
  plan!: TenantPlan;

  @IsIn(EXTERNAL_PAYMENT_METHODS)
  paymentMethod!: ExternalPaymentMethod;

  /** Transaction / confirmation reference (e.g. Zelle confirmation ID) */
  @IsOptional()
  @IsString()
  paymentRef?: string;

  /** Billing period in days — 30 = monthly, 90 = quarterly, 365 = annual */
  @IsInt()
  @Min(1)
  billingPeriodDays!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
