import { Module } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { NumberingController } from "./numbering.controller";
import { NumberingService } from "./numbering.service";
import { AliasController } from "./alias.controller";
import { ExternalRefService } from "./external-ref.service";
import { ProductAliasService } from "./product-alias.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { PrismaModule } from "../prisma/prisma.module";
import { VendorBillsModule } from "../vendor-bills/vendor-bills.module";

@Module({
  imports: [PrismaModule, VendorBillsModule],
  controllers: [ImportController, NumberingController, AliasController],
  providers: [
    ImportService,
    NumberingService,
    ExternalRefService,
    ProductAliasService,
    DuplicateMatchService,
  ],
  // NumberingService is exported so the deferred invoices/orders wiring (which
  // must call reserveNext at mint time) can consume it without duplicating it.
  // The idempotency substrate is exported for the migration (Phase 4) and batch
  // (Phase 5) flows built on top of it.
  exports: [NumberingService, ExternalRefService, ProductAliasService, DuplicateMatchService],
})
export class ImportModule {}
