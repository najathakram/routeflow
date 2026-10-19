import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { AuditModule } from "../audit/audit.module";
import { CommonModule } from "../common/common.module";
import { TenantModule } from "../tenant/tenant.module";
import { FeatureConfigModule } from "./feature-config.module";
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";
import { PlatformAdminService } from "../platform-admin/platform-admin.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { TenantMirrorService } from "../platform-admin/tenant-mirror.service";
import { EmailModule } from "../email/email.module";
import { RfInvoicesAdminService } from "../platform-admin/rf-invoices.service";
import { BillingModule } from "./billing.module";
import { BillingService } from "./billing.service";
import { CatchupCheckoutService } from "./catchup-checkout.service";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { SubscriptionService } from "./subscription.service";
import { BillingCronService } from "./billing-cron.service";
import { CatchupClaimService } from "./catchup-claim.service";
import { DunningService } from "./dunning.service";
import { ScheduledPriceChangeService } from "./scheduled-price-change";
import { SubscriptionMutationService } from "./subscription-mutation.service";

/**
 * Nit (Opus review): BillingService, SubscriptionMutationService and others take collaborators as `@Optional()`
 * (so a unit spec can build them bare). In production an @Optional dependency that the module forgot to provide is
 * a SILENT null: the catch-up hooks in the webhook would simply never run. This compiles the real BillingModule and
 * asserts each @Optional collaborator is actually injected - not undefined.
 */
/** The global modules AppModule supplies, as inert stand-ins: the point here is the providers of BillingModule. */
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class StubPrismaModule {}

describe("BillingModule wiring: the @Optional collaborators are really provided", () => {
  it("BillingModule provides AND exports the catch-up services", () => {
    const providers: unknown[] = Reflect.getMetadata("providers", BillingModule);
    const exported: unknown[] = Reflect.getMetadata("exports", BillingModule);
    for (const cls of [CatchupClaimService, CatchupCheckoutService]) {
      expect(providers).toContain(cls);
      expect(exported).toContain(cls);
    }
  });

  it("compiles, and BillingService / SubscriptionMutationService hold real instances (not a silent undefined)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StubPrismaModule,
        AuditModule,
        CommonModule,
        TenantModule,
        FeatureConfigModule,
        BillingModule,
      ],
    }).compile();
    try {
      expect(moduleRef.get(CatchupClaimService, { strict: false })).toBeInstanceOf(
        CatchupClaimService,
      );
      const billing = moduleRef.get(BillingService, { strict: false }) as any;
      expect(billing.catchup).toBeInstanceOf(CatchupClaimService);
      expect(billing.scheduledPrice).toBeInstanceOf(ScheduledPriceChangeService);
      expect(billing.dunning).toBeInstanceOf(DunningService);
      const mutations = moduleRef.get(SubscriptionMutationService, { strict: false }) as any;
      expect(mutations.scheduledPrice).toBeInstanceOf(ScheduledPriceChangeService);
      expect(mutations.dunning).toBeInstanceOf(DunningService);
      // SA-775: every AUTOMATIC lock writer holds the REAL rollout switch - an @Optional that came back
      // undefined would silently leave that writer ungated in production.
      const sw = moduleRef.get(AutoLockSwitchService, { strict: false });
      expect(sw).toBeInstanceOf(AutoLockSwitchService);
      expect(billing.autoLocks).toBe(sw);
      expect(mutations.autoLocks).toBe(sw);
      expect(billing.dunning.autoLocks).toBe(sw);
      // the banners read `autoLockHeld` from this service: an undefined switch would silently report "never held"
      expect((moduleRef.get(SubscriptionService, { strict: false }) as any).autoLocks).toBe(sw);
      expect((moduleRef.get(BillingCronService, { strict: false }) as any).autoLocks).toBe(sw);
      // SA-786: the sweep bills an add-on the old plan included through the REAL mutation service, and the admin
      // plan edit does the same after an instant down-move - an @Optional that came back undefined would leave a
      // STRIPE tenant's add-on unbilled after the downgrade (and only a notice would say so).
      expect((moduleRef.get(BillingCronService, { strict: false }) as any).mutations).toBe(
        mutations,
      );
      expect(Reflect.getMetadata("exports", BillingModule)).toContain(SubscriptionMutationService);
    } finally {
      await moduleRef.close();
    }
  });

  it("RfInvoicesAdminService (the admin queue) gets a REAL CatchupClaimService: its @Optional catch-up guard is not silently off", async () => {
    // PlatformAdminModule must keep wiring it ...
    const imports: unknown[] = Reflect.getMetadata("imports", PlatformAdminModule);
    const providers: unknown[] = Reflect.getMetadata("providers", PlatformAdminModule);
    expect(imports).toContain(BillingModule);
    expect(providers).toContain(RfInvoicesAdminService);
    // ... and BillingModule must keep exporting what it needs: compile the same pair.
    @Module({ imports: [BillingModule], providers: [RfInvoicesAdminService] })
    class AdminQueueWiring {}
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StubPrismaModule,
        AuditModule,
        CommonModule,
        TenantModule,
        FeatureConfigModule,
        AdminQueueWiring,
      ],
    }).compile();
    try {
      const svc = moduleRef.get(RfInvoicesAdminService, { strict: false }) as any;
      expect(svc.catchup).toBeInstanceOf(CatchupClaimService);
    } finally {
      await moduleRef.close();
    }
  });

  it("SA-815 B2: PlatformAdminService.mutations (@Optional) is the REAL SubscriptionMutationService in the built module", async () => {
    // The same collaborators PlatformAdminModule gives the service, minus its controllers and the async JWT
    // factory that needs the app config. The injection is @Optional: a missed wiring would silently skip the
    // admin-path add-on billing (the updatePlan down-move, enable and un-comp pricing).
    const providers: unknown[] = Reflect.getMetadata("providers", PlatformAdminModule);
    expect(providers).toContain(PlatformAdminService);
    @Module({
      imports: [JwtModule.register({ secret: "wiring-spec" }), EmailModule, BillingModule],
      providers: [PlatformAdminService, PlatformConfigService, TenantMirrorService],
    })
    class AdminServiceWiring {}
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StubPrismaModule,
        AuditModule,
        CommonModule,
        TenantModule,
        FeatureConfigModule,
        AdminServiceWiring,
      ],
    }).compile();
    try {
      const admin = moduleRef.get(PlatformAdminService, { strict: false }) as any;
      const mutations = moduleRef.get(SubscriptionMutationService, { strict: false });
      expect(admin.mutations).toBeInstanceOf(SubscriptionMutationService);
      expect(admin.mutations).toBe(mutations);
    } finally {
      await moduleRef.close();
    }
  });
});
