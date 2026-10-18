import { Module, forwardRef } from "@nestjs/common";
import { StripeService } from "./stripe.service";
import { BillingService } from "./billing.service";
import { PlatformPricingService } from "./platform-pricing.service";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { AddonAccessService } from "./addon-access";
import { BillingController } from "./billing.controller";
import { BillingWebhookController } from "./billing-webhook.controller";
import { PlanCatalogController } from "./plan-catalog.controller";
import { PlanAdminController } from "./plan-admin.controller";
import { SettingsBillingController } from "./settings-billing.controller";
import { PaymentDueController } from "./payment-due.controller";
import { PaymentDueService } from "./payment-due.service";
import { ProrationService } from "./proration.service";
import { TenantConfigSnapshotService } from "./tenant-config-snapshot.service";
import { ConfigSnapshotFlagService } from "./config-snapshot-flag.service";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
import { TenantConfigSnapshotAdminService } from "./tenant-config-snapshot-admin.service";
import { SubscriptionService } from "./subscription.service";
import { SubscriptionBillingExtras } from "./subscription-billing-extras";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BillingEventService } from "./billing-event.service";
import { BillingCronService } from "./billing-cron.service";
import { RfInvoiceBuilder } from "./rf-invoice/rf-invoice-builder";
import { RfInvoiceIssuerService } from "./rf-invoice/rf-invoice-issuer.service";
import { RfInvoiceMailerService } from "./rf-invoice/rf-invoice-mailer.service";
import { MrrService } from "./mrr.service";
import { FeatureOverrideReviewJob } from "./feature-override-review.job";
import { FeatureOverrideExpiryJob } from "./feature-override-expiry.job";
import { BillingNotificationService } from "./billing-notification.service";
import { EmailModule } from "../email/email.module";
import { EntitlementsModule } from "./entitlements.module";
import { ScheduledPriceChangeService } from "./scheduled-price-change";
import { CatchupClaimService } from "./catchup-claim.service";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { DunningService } from "./dunning.service";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { AutoLockAdminService } from "./auto-lock-admin.service";

@Module({
  // forwardRef: MailboxModule (imported by EmailModule for MailboxSendService) imports this
  // module back for AddonGuard — see MailboxModule's doc comment for the full cycle.
  imports: [forwardRef(() => EmailModule), EntitlementsModule],
  controllers: [
    BillingController,
    BillingWebhookController,
    PlanCatalogController,
    PlanAdminController,
    SettingsBillingController,
    PaymentDueController,
  ],
  providers: [
    StripeService,
    BillingService,
    PlatformPricingService,
    AddonService,
    AddonGuard,
    AddonAccessService,
    ProrationService,
    SubscriptionService,
    // SA-733r6 (B4): billing contact, open-invoice amount, autopay card (Stripe-backed, cached) for the view.
    SubscriptionBillingExtras,
    SubscriptionMutationService,
    BillingEventService,
    BillingCronService,
    // R1 option B: a scheduled downgrade's price reaches Stripe before the renewal (invoice.upcoming + a backup sweep).
    ScheduledPriceChangeService,
    // SA-733r3 N2: the October catch-up claim lifecycle (webhook entry points + the hourly sweep).
    CatchupClaimService,
    // SA-733 D7: plan + open the October catch-up checkout (platform-admin CatchupAdminController).
    CatchupCheckoutService,
    // The tenant's own "payment due" read + self-serve pay over the catch-up planner (PaymentDueController).
    PaymentDueService,
    // SA-733r7 PR-B3: dunning (clock stamp, hourly pause sweep, invoice.paid resume, pause_collection reconciler).
    DunningService,
    // SA-775 (row 381): the rollout pause on AUTOMATIC locks - the switch, and the super-admin preview over it.
    AutoLockSwitchService,
    AutoLockAdminService,
    // Manual invoices due PR1 (DARK: RF_INVOICING_MODE defaults to off, the cron then does nothing).
    RfInvoiceBuilder,
    RfInvoiceIssuerService,
    // PR3: issue email, manual resend and the d0/d7/d14 reminders (RF_INVOICING_MODE gated).
    RfInvoiceMailerService,
    MrrService,
    BillingNotificationService,
    // Feature grants v2 PR-3 (brief B): nightly review sweep for expired-unrevoked overrides.
    // PrismaService/AuditService are both @Global() modules -- no new import needed here.
    FeatureOverrideReviewJob,
    // B569: nightly sweep that revokes expired overrides (runs after the review job above).
    FeatureOverrideExpiryJob,
    // Lane B A2 (DARK — nothing calls it yet): downgrade snapshot / re-upgrade restore of a
    // tenant's feature config. Stateless, no dependencies.
    TenantConfigSnapshotService,
    // Lane B A2 step b: the ONE hook every plan-change site calls inside its transaction.
    // Live flag `entitlements.configSnapshot` (default off, fail-closed) — wired but inert until flipped.
    ConfigSnapshotFlagService,
    PlanTransitionConfigService,
    // Lane B A2 step c: admin list / preview / "Restore now" for the tenant snapshots tab.
    TenantConfigSnapshotAdminService,
  ],
  exports: [
    StripeService,
    ScheduledPriceChangeService,
    // The platform-admin RfInvoice queue refuses payments while a claim is held.
    CatchupClaimService,
    CatchupCheckoutService,
    // Platform-admin activation / extendTrial clear a pause's Stripe pause_collection after their commit.
    DunningService,
    // SA-775: the platform-admin controller reads / flips the switch and previews the unpause.
    AutoLockSwitchService,
    AutoLockAdminService,
    BillingService,
    PlatformPricingService,
    AddonService,
    AddonGuard,
    AddonAccessService,
    // Platform-admin plan changes move the snapshot MRR run-rate, so they must emit the
    // matching signed BillingEvent delta (see PlatformAdminService.updatePlan).
    BillingEventService,
    // ADMIN-UPDATEPLAN-1: PlatformAdminService.updatePlan() shares the same prorated-diff
    // math an admin upgrade uses as the tenant-facing upgrade() — exported so
    // PlatformAdminModule (which already imports BillingModule) can inject it.
    ProrationService,
    EntitlementsModule,
    // Phase 0 T9: PlatformAdminService.getStats() reads MrrService.computeOverview() as the
    // one MRR engine instead of re-deriving its own estimate — was a provider only, so DI
    // resolution failed until exported here.
    MrrService,
    TenantConfigSnapshotService,
    ConfigSnapshotFlagService,
    PlanTransitionConfigService,
    TenantConfigSnapshotAdminService,
    // Manual invoices due PR2: the platform-admin queue issues an invoice on demand and prices tenants.
    RfInvoiceBuilder,
    RfInvoiceIssuerService,
    // PR3: the platform-admin controller's send routes.
    RfInvoiceMailerService,
  ],
})
export class BillingModule {}
