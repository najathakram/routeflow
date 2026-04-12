import { IsEnum, IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";
import { TenantPlan } from "@prisma/client";

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
  @IsEnum(TenantPlan)
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
