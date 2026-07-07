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
import { DuplicateMatchService } from "./duplicate-match.service";
import { VariantResolutionService } from "./variant-resolution.service";
import { MigrationService } from "./migration.service";
import { BatchImportService } from "./batch-import.service";
import { SourceConnectorRegistry } from "./connectors/source-connectors";
import { PrismaModule } from "../prisma/prisma.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";
import { ProductsModule } from "../products/products.module";

@Module({
  imports: [PrismaModule, VendorBillsModule, ProductsModule],
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
    DuplicateMatchService,
    VariantResolutionService,
    MigrationService,
    BatchImportService,
    SourceConnectorRegistry,
  ],
  // NumberingService is exported so the deferred invoices/orders wiring (which
  // must call reserveNext at mint time) can consume it without duplicating it.
  // The idempotency substrate is exported for the migration (Phase 4) and batch
  // (Phase 5) flows built on top of it.
  exports: [NumberingService, ExternalRefService, ProductAliasService, DuplicateMatchService],
})
export class ImportModule {}
