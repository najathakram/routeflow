import { Module } from "@nestjs/common";
import { BillingModule } from "../billing/billing.module";
import { EmailModule } from "../email/email.module";
import { StorageModule } from "../storage/storage.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingIntakeService } from "./onboarding-intake.service";
import { OnboardingService } from "./onboarding.service";
import { PublicOnboardingController } from "./public-onboarding.controller";

/**
 * Wholesaler onboarding (#2159). Prisma, Audit and Tenant (TenantContextService) are global
 * modules; Billing (ProrationService/PlanCatalogService for the order snapshot), Email and
 * Storage are NOT, so they are imported explicitly (L-113).
 */
@Module({
  imports: [BillingModule, EmailModule, StorageModule],
  controllers: [OnboardingController, PublicOnboardingController],
  providers: [OnboardingService, OnboardingIntakeService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
