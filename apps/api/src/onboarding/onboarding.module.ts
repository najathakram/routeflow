import { Module } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { OnboardingTenantController } from "./onboarding-tenant.controller";
import { OnboardingTenantService } from "./onboarding-tenant.service";

/**
 * Wholesaler onboarding (#2159). Prisma, Audit and Tenant (TenantContextService) are
 * global modules; S1 needs nothing else. S3a/S3b add BillingModule/EmailModule here
 * explicitly when they need them (L-113).
 */
@Module({
  controllers: [OnboardingController, OnboardingTenantController],
  providers: [OnboardingService, OnboardingTenantService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
