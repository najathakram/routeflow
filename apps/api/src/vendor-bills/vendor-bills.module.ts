import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VendorBillsController } from "./vendor-bills.controller";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaModule } from "../prisma/prisma.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { DuplicateMatchModule } from "../import/duplicate-match.module";
import { ProductAliasModule } from "../import/product-alias.module";
import { StorageModule } from "../storage/storage.module";
import { InventoryModule } from "../inventory/inventory.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for the controller's @RequirePlanFlag("flag.ap_bills") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
// Supplies PlatformConfigService: unified Anthropic key resolution + AI usage metering.
import { PlatformAdminModule } from "../platform-admin/platform-admin.module";
// Supplies AddonGuard + AddonService for the scan endpoint's @RequireAddon("ocr") gate.
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    SystemConfigModule,
    DuplicateMatchModule,
    ProductAliasModule,
    StorageModule,
    InventoryModule,
    EntitlementsModule,
    PlatformAdminModule,
    BillingModule,
  ],
  controllers: [VendorBillsController],
  providers: [VendorBillsService],
  exports: [VendorBillsService],
})
export class VendorBillsModule {}
