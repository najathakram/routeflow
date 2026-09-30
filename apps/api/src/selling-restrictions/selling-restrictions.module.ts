import { Module } from "@nestjs/common";
import { ProductLabelsModule } from "../product-labels/product-labels.module";
import { SellingRestrictionsService } from "./selling-restrictions.service";

/**
 * Selling restrictions (lane R). Step 1 shipped the evaluator; step 2's `assertLinesSellable`
 * choke point lives beside it, and every line-writing module will import this module to reach it
 * as its call site lands (none does yet).
 */
@Module({
  imports: [ProductLabelsModule],
  providers: [SellingRestrictionsService],
  exports: [SellingRestrictionsService],
})
export class SellingRestrictionsModule {}
