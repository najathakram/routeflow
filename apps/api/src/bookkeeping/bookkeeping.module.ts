import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BookkeepingService } from "./bookkeeping.service";
import { BookkeepingController } from "./bookkeeping.controller";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { CommissionsModule } from "../sales-agents/commissions.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the reports/* handlers' @RequirePlanFlag("flag.reports") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
// Supplies PlatformConfigService: unified Anthropic key resolution + AI usage metering.
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";
// Supplies AddonGuard + AddonService for the extract-items @RequireAddon("ocr") gate
// (EntitlementsModule does not export them).
import { BillingModule } from "../billing/billing.module";
// B444/B1023: InvoicePdfService, the tenant-correct PDF renderer.
import { InvoicesModule } from "../invoices/invoices.module";

@Module({
  imports: [
    AuthModule,
    ConfigModule,
    StorageModule,
    VendorBillsModule,
    SystemConfigModule,
    CommissionsModule,
    EntitlementsModule,
    PlatformAdminModule,
    BillingModule,
    InvoicesModule,
  ],
  controllers: [BookkeepingController],
  providers: [BookkeepingService],
})
export class BookkeepingModule {}
