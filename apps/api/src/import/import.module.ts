import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { NumberingController } from "./numbering.controller";
import { NumberingModule } from "./numbering.module";
import { AliasController } from "./alias.controller";
import { ResolutionController } from "./resolution.controller";
import { MigrationController } from "./migration.controller";
import { BatchController } from "./batch.controller";
import { ExternalRefService } from "./external-ref.service";
import { ProductAliasService } from "./product-alias.service";
import { DuplicateMatchModule } from "./duplicate-match.module";
import { VariantResolutionService } from "./variant-resolution.service";
import { MigrationService } from "./migration.service";
import { BatchImportService } from "./batch-import.service";
import { SourceConnectorRegistry } from "./connectors/source-connectors";
import { PrismaModule } from "../prisma/prisma.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";
import { ProductsModule } from "../products/products.module";
// ImportService.importContacts() reuses CustomersService's CUSTOMERS soft-cap
// gate so bulk import obeys the same plan cap as the single-create path.
import { CustomersModule } from "../customers/customers.module";
// EntitlementsModule depends only on the global PrismaService — it supplies
// PlanFlagGuard for MigrationController's @RequirePlanFlag("flag.import_integrations") gate.
import { EntitlementsModule } from "../billing/entitlements.module";
// Supplies AddonGuard + AddonService for BatchController's @RequireAddon("ocr") scan gate
// (EntitlementsModule does not export them).
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [
    PrismaModule,
    VendorBillsModule,
    ProductsModule,
    DuplicateMatchModule,
    CustomersModule,
    EntitlementsModule,
    BillingModule,
    // B100/F16b: NumberingService now lives in its own module (numbering.module.ts)
    // so InvoicesModule/EstimatesModule can consume it without importing ImportModule.
    NumberingModule,
  ],
  controllers: [
    ImportController,
    NumberingController,
    AliasController,
    ResolutionController,
    MigrationController,
    BatchController,
  ],
  providers: [
    ImportService,
    ExternalRefService,
    ProductAliasService,
    VariantResolutionService,
    MigrationService,
    BatchImportService,
    SourceConnectorRegistry,
  ],
  // NumberingModule is re-exported so any existing consumer of ImportModule's
  // NumberingService export keeps working without duplicating the provider.
  // The idempotency substrate is exported for the migration (Phase 4) and batch
  // (Phase 5) flows built on top of it.
  exports: [NumberingModule, ExternalRefService, ProductAliasService, DuplicateMatchModule],
})
export class ImportModule {}
