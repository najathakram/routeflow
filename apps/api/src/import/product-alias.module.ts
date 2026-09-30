import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ProductAliasService } from "./product-alias.service";

/**
 * Standalone so `VendorBillsModule` can consume the alias matcher without
 * importing `ImportModule` — which imports `VendorBillsModule` back and
 * would deadlock the injector (same reasoning as `DuplicateMatchModule`).
 */
@Module({
  imports: [PrismaModule],
  providers: [ProductAliasService],
  exports: [ProductAliasService],
})
export class ProductAliasModule {}
