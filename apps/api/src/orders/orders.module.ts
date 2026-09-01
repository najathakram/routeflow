import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { OrdersService } from "./orders.service";
import { ChangeRequestsService } from "./change-requests.service";
import { OrdersController } from "./orders.controller";
import { AuthModule } from "../auth/auth.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { InventoryModule } from "../inventory/inventory.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { PromotionsModule } from "../promotions/promotions.module";
import { MessagingModule } from "../messaging/messaging.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
import { CommissionsModule } from "../sales-agents/commissions.module";
// OrdersService flag-gates assertWithinCreditLimit's exposure check on
// flag.credit_limits (WP3). EntitlementsModule depends only on the global
// PrismaService, so importing it here pulls in no Stripe/cron/controllers.
import { EntitlementsModule } from "../billing/entitlements.module";
// B65 (REG-B65): deleteOrder's per-invoice teardown needs RegulatedLedgerService
// to reverse ledger entries, exactly like the two sibling teardown paths
// (InvoicesService.voidInvoiceInTx, InvoicesService.deleteInvoice) already do.
// RegulatedModule imports Storage/Audit/Billing only — no cycle with OrdersModule.
import { RegulatedModule } from "../regulated/regulated.module";

@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: "invoices" }),
    GatewaysModule,
    NotificationsModule,
    InvoicesModule,
    SystemConfigModule,
    InventoryModule,
    AuthorizationsModule,
    PromotionsModule,
    MessagingModule,
    CreditNotesModule,
    CommissionsModule,
    EntitlementsModule,
    RegulatedModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, ChangeRequestsService],
  exports: [OrdersService, ChangeRequestsService],
})
export class OrdersModule {}
