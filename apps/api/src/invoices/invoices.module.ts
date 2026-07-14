import { Module } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaModule } from "../prisma/prisma.module";
import { GatewaysModule } from "../gateways/gateways.module";
import { StorageModule } from "../storage/storage.module";
import { EmailModule } from "../email/email.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { RegulatedModule } from "../regulated/regulated.module";
import { AuthorizationsModule } from "../authorizations/authorizations.module";
import { CreditNotesModule } from "../credit-notes/credit-notes.module";

@Module({
  imports: [
    PrismaModule,
    GatewaysModule,
    StorageModule,
    EmailModule,
    SystemConfigModule,
    RegulatedModule,
    AuthorizationsModule,
    CreditNotesModule,
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoicePdfService],
  exports: [InvoicesService, InvoicePdfService],
})
export class InvoicesModule {}
