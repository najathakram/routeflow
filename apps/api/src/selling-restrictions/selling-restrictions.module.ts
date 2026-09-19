import { Module } from "@nestjs/common";
import { ProductLabelsModule } from "../product-labels/product-labels.module";
import { SellingRestrictionsService } from "./selling-restrictions.service";

/**
 * Selling restrictions (lane R). Step 1 ships the evaluator; step 2's `assertLinesSellable`
 * choke point lands here and the line-writing modules import this module to reach it.
 */
@Module({
  imports: [ProductLabelsModule],
  providers: [SellingRestrictionsService],
  exports: [SellingRestrictionsService],
})
export class SellingRestrictionsModule {}
