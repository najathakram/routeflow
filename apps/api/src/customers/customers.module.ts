import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
// Statement builders live in buyer/ (P5-15), but BuyerModule imports THIS
// module — importing it back would be a cycle. Both services are stateless
// (Prisma + Storage only), so they're registered here directly for the
// operator statement endpoints.
import { StatementService } from "../buyer/statement.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";

@Module({
  imports: [AuthModule, ConfigModule, StorageModule],
  controllers: [CustomersController],
  providers: [CustomersService, StatementService, StatementPdfService],
  exports: [CustomersService],
})
export class CustomersModule {}
