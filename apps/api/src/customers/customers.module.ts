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
// Statement builders live in buyer/ (P5-15), but BuyerModule imports THIS
// module — importing it back would be a cycle. Both services are stateless
// (Prisma + Storage only), so they're registered here directly for the
// operator statement endpoints.
import { StatementService } from "../buyer/statement.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";

@Module({
  imports: [AuthModule, ConfigModule, StorageModule, EntitlementsModule],
  controllers: [CustomersController],
  providers: [CustomersService, StatementService, StatementPdfService],
  exports: [CustomersService],
})
export class CustomersModule {}
