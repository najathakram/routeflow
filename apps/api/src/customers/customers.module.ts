import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
// CustomersService reads the CUSTOMERS meter + published catalog for the
// customer soft-cap gate in create(). EntitlementsModule depends only on the
// global PrismaService, so importing it here pulls in no Stripe/cron/controllers.
import { EntitlementsModule } from "../billing/entitlements.module";
import { CommissionsModule } from "../sales-agents/commissions.module";
// Statement builders live in buyer/ (P5-15), but BuyerModule imports THIS
// module — importing it back would be a cycle. Both services are stateless
// (Prisma + Storage only), so they're registered here directly for the
// operator statement endpoints.
import { StatementService } from "../buyer/statement.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";
// The bulk purge paths hard-delete invoices, and the regulated-sales ledger is
// append-only with no FK to Invoice — so they must reverse a destroyed invoice's
// entries first, exactly as invoices.service's voidInvoiceInTx/deleteInvoice and
// orders.service's deleteOrder (B65) already do.
import { RegulatedModule } from "../regulated/regulated.module";
// Portal invites need to actually send an email (see sendPortalInvite in
// customers.service.ts) — EmailModule has no imports of its own (see
// email.module.ts), so it cannot be the tail of a cycle back here; a prior
// comment claiming a circular-module issue was mistaken.
import { EmailModule } from "../email/email.module";

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    StorageModule,
    EntitlementsModule,
    CommissionsModule,
    RegulatedModule,
    EmailModule,
  ],
  controllers: [CustomersController],
  providers: [CustomersService, StatementService, StatementPdfService],
  exports: [CustomersService],
})
export class CustomersModule {}
