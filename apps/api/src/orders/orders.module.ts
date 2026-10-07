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
// Lane R: OrdersService is the first consumer of the selling-restrictions choke point. The module
// imports only ProductLabelsModule (+ the global PrismaService) — no cycle with OrdersModule.
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
// #2094: OrdersService takes a return inside an order create/edit via InlineReturnsService. The
// returns module imports nothing from orders, so there is no cycle.
import { ReturnsModule } from "../returns/returns.module";
// WS9: PolicyModule imports nothing (PrismaModule is global) — no cycle with OrdersModule.
import { PolicyModule } from "../policy/policy.module";
import { PolicyOversellReader } from "./policy-oversell-reader";
// SA-655: staff counter sales (POST /orders/counter-sale). Dark until a tenant's fulfilment capability offers a counter.
import { CounterSaleController } from "./counter-sale/counter-sale.controller";
import { CounterSaleService } from "./counter-sale/counter-sale.service";
import { CustomersModule } from "../customers/customers.module";
import { BillingModule } from "../billing/billing.module";
import { WalkInCustomerService } from "./counter-sale/walk-in-customer";
// Pickup mode: POST /orders/:id/pickup-complete hands an order-ahead PICKUP order over at the till.
import { PickupCompleteController } from "./counter-sale/pickup-complete.controller";
import { PickupCompleteService } from "./counter-sale/pickup-complete.service";
import {
  DefaultFulfilmentCapabilityReader,
  FULFILMENT_CAPABILITY_READER,
} from "./counter-sale/fulfilment-capability-reader";

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
    SellingRestrictionsModule,
    ReturnsModule,
    PolicyModule,
    // WalkInCustomerService restores a removed walk-in through CustomersService.restoreCustomer.
    CustomersModule,
    // DefaultFulfilmentCapabilityReader needs AddonService (FeatureConfigService is global, and
    // FeatureOverrideService comes from EntitlementsModule). BillingModule never reaches OrdersModule: no cycle.
    BillingModule,
  ],
  controllers: [OrdersController, CounterSaleController, PickupCompleteController],
  providers: [
    OrdersService,
    ChangeRequestsService,
    PolicyOversellReader,
    CounterSaleService,
    PickupCompleteService,
    WalkInCustomerService,
    { provide: FULFILMENT_CAPABILITY_READER, useClass: DefaultFulfilmentCapabilityReader },
  ],
  exports: [OrdersService, ChangeRequestsService, PolicyOversellReader],
})
export class OrdersModule {}
