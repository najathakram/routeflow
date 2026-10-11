import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { AuditModule } from "../audit/audit.module";
import { CommonModule } from "../common/common.module";
import { TenantModule } from "../tenant/tenant.module";
import { FeatureConfigModule } from "./feature-config.module";
import { BillingModule } from "./billing.module";
import { BillingService } from "./billing.service";
import { CatchupCheckoutService } from "./catchup-checkout.service";
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
    } finally {
      await moduleRef.close();
    }
  });
});
