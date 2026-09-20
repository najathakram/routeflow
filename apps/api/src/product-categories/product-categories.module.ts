import { Module } from "@nestjs/common";
import { ProductLabelsModule } from "../product-labels/product-labels.module";
import { ProductCategoriesController } from "./product-categories.controller";
import { ProductCategoriesService } from "./product-categories.service";
import { ProductLabelsAdminService } from "./product-labels-admin.service";

@Module({
  imports: [ProductLabelsModule],
  controllers: [ProductCategoriesController],
  providers: [ProductCategoriesService, ProductLabelsAdminService],
  exports: [ProductCategoriesService, ProductLabelsAdminService],
})
export class ProductCategoriesModule {}
