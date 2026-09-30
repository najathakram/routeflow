import { Module } from "@nestjs/common";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";
import { ProductUnitsController } from "./product-units.controller";
import { ProductUnitsService } from "./product-units.service";
import { RecipesController } from "./recipes.controller";
import { RecipesService } from "./recipes.service";
import { ProductsExportService } from "./products-export.service";
import { SalesFactsModule } from "../sales-facts/sales-facts.module";
import { AuthModule } from "../auth/auth.module";
import { StorageModule } from "../storage/storage.module";
import { BillingModule } from "../billing/billing.module";
import { SystemConfigModule } from "../system-config/system-config.module";
import { GatewaysModule } from "../gateways/gateways.module";

@Module({
  imports: [AuthModule, StorageModule, BillingModule, SystemConfigModule, GatewaysModule, SalesFactsModule],
  controllers: [ProductsController, ProductUnitsController, RecipesController],
  providers: [ProductsService, ProductUnitsService, RecipesService, ProductsExportService],
  exports: [ProductsService],
})
export class ProductsModule {}
