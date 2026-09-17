import { Module } from "@nestjs/common";
import { ReturnsController } from "./returns.controller";
import { ReturnsService } from "./returns.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the controller's @RequirePlanFlag("flag.returns") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
// BillingModule supplies AddonGuard/AddonService for the PR-1b quote endpoint's
// @RequireAddon("orders_inline_returns") gate.
import { BillingModule } from "../billing/billing.module";
import { NumberingModule } from "../import/numbering.module";

@Module({
  imports: [
    PrismaModule,
    GatewaysModule,
    RegulatedModule,
    CreditNotesModule,
    EntitlementsModule,
    BillingModule,
    NumberingModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService, InlineReturnsQuoteService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
