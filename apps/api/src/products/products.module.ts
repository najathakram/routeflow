import { Module } from "@nestjs/common";
import { ProductFamiliesController } from "./product-families.controller";
import { ProductFamiliesService } from "./product-families.service";
import { ProductsController } from "./products.controller";
import { ProductPortalVisibilityController } from "./product-portal-visibility.controller";
import { ProductPortalVisibilityService } from "./product-portal-visibility.service";
import { ProductsService } from "./products.service";
import { ProductPriceGridService } from "./product-price-grid.service";
import { ProductPricingController } from "./product-pricing.controller";
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
  imports: [
    AuthModule,
    StorageModule,
    BillingModule,
    SystemConfigModule,
    GatewaysModule,
    SalesFactsModule,
  ],
  controllers: [
    ProductPortalVisibilityController,
    ProductFamiliesController,
    ProductsController,
    ProductUnitsController,
    ProductPricingController,
    RecipesController,
  ],
  providers: [
    ProductsService,
    ProductPortalVisibilityService,
    ProductFamiliesService,
    ProductUnitsService,
    ProductPriceGridService,
    RecipesService,
    ProductsExportService,
  ],
  exports: [ProductsService],
})
export class ProductsModule {}
