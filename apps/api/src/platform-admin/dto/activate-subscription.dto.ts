import { IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { TenantPlan } from "@prisma/client";
import { SELECTABLE_TENANT_PLANS } from "../../billing/plan-catalog.constants";

export const EXTERNAL_PAYMENT_METHODS = [
  "ZELLE",
  "BANK_TRANSFER",
  "CHECK",
  "CASH",
  "WIRE",
  "OTHER",
] as const;

export type ExternalPaymentMethod = (typeof EXTERNAL_PAYMENT_METHODS)[number];

export class ActivateSubscriptionDto {
  // GROWTH/SCALE are valid TenantPlan enum members but not yet selectable here — see
  // SELECTABLE_TENANT_PLANS in plan-catalog.constants.ts (Phase 0 Task 10 gap).
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
