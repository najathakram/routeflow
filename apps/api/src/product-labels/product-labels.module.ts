import { Module } from "@nestjs/common";
import { ProductLabelsService } from "./product-labels.service";

/** READ side of product labels. Import this module to reach `ProductLabelsService.effectiveLabels`. */
@Module({
  providers: [ProductLabelsService],
  exports: [ProductLabelsService],
})
export class ProductLabelsModule {}
