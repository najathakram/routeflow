import { Module } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the controller's @RequirePlanFlag("flag.returns") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
// BillingModule supplies AddonGuard/AddonService for the PR-1b quote endpoint's
// @RequireAddon("orders_inline_returns") gate, and (PR-1c) AddonService for
// InlineReturnsService's own fail-closed service-level grant check.
import { BillingModule } from "../billing/billing.module";
import { NumberingModule } from "../import/numbering.module";
// PR-1c: InlineReturnsQuoteService.priceInlineReturn's unreferenced-chunk tax fallback
// reads the tenant's current rate (deferred PR-1b item) via SystemConfigService.
import { SystemConfigModule } from "../system-config/system-config.module";

@Module({
  imports: [
    PrismaModule,
    GatewaysModule,
    RegulatedModule,
    CreditNotesModule,
    EntitlementsModule,
    BillingModule,
    NumberingModule,
    SystemConfigModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService, InlineReturnsQuoteService, InlineReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
