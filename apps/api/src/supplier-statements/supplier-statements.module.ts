import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SupplierStatementsController } from "./supplier-statements.controller";
import { SupplierStatementsService } from "./supplier-statements.service";
import { StatementApplyService } from "./statement-apply.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { DuplicateMatchModule } from "../import/duplicate-match.module";
import { StorageModule } from "../storage/storage.module";
// Supplies PlatformConfigService: unified Anthropic key resolution + AI usage metering.
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";

/**
 * Imports `DuplicateMatchModule` directly rather than `ImportModule` (which
 * would deadlock the injector against `VendorBillsModule`) or
 * `VendorBillsModule` itself — see `duplicate-match.module.ts`.
 */
@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    SystemConfigModule,
    DuplicateMatchModule,
    StorageModule,
    PlatformAdminModule,
  ],
  controllers: [SupplierStatementsController],
  providers: [SupplierStatementsService, StatementApplyService],
  exports: [SupplierStatementsService, StatementApplyService],
})
export class SupplierStatementsModule {}
