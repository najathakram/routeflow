import { Module } from "@nestjs/common";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { OverdueSweepService } from "./overdue-sweep.service";
import { PaymentKeyStatusController } from "./payment-key-status.controller";
import { PaymentKeyStatusService } from "./payment-key-status.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { StorageModule } from "../storage/storage.module";
import { EmailModule } from "../email/email.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";
import { MessagingModule } from "../messaging/messaging.module";
import { EntitlementsModule } from "../billing/entitlements.module";
import { CommissionsModule } from "../sales-agents/commissions.module";
import { NumberingModule } from "../import/numbering.module";

@Module({
  imports: [
    // F-05 (#2093): the choke point every line-writing service calls before it writes.
    SellingRestrictionsModule,
    PrismaModule,
    GatewaysModule,
    StorageModule,
    EmailModule,
    SystemConfigModule,
    RegulatedModule,
    AuthorizationsModule,
    CreditNotesModule,
    MessagingModule,
    EntitlementsModule,
    CommissionsModule,
    // B100/F16b: reserveNext("INVOICE", …) mints invoice numbers through the
    // shared NumberingService.
    NumberingModule,
  ],
  controllers: [InvoicesController, PaymentKeyStatusController],
  providers: [InvoicesService, InvoicePdfService, OverdueSweepService, PaymentKeyStatusService],
  exports: [InvoicesService, InvoicePdfService],
})
export class InvoicesModule {}
