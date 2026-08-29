import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { NumberingController } from "./numbering.controller";
import { NumberingService } from "./numbering.service";
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
    NumberingService,
    ExternalRefService,
    ProductAliasService,
    VariantResolutionService,
    MigrationService,
    BatchImportService,
    SourceConnectorRegistry,
  ],
  // NumberingService is exported so the deferred invoices/orders wiring (which
  // must call reserveNext at mint time) can consume it without duplicating it.
  // The idempotency substrate is exported for the migration (Phase 4) and batch
  // (Phase 5) flows built on top of it.
  exports: [NumberingService, ExternalRefService, ProductAliasService, DuplicateMatchModule],
})
export class ImportModule {}
