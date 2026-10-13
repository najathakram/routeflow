import { Module } from "@nestjs/common";
import { ProductLabelsModule } from "../product-labels/product-labels.module";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";

/** Rule admin (list / create / bulk / lift / lift-batch / product chips). The chips read effective labels. */
@Module({
  imports: [ProductLabelsModule],
  controllers: [SellingRestrictionsAdminController],
  providers: [SellingRestrictionsAdminService],
})
export class SellingRestrictionsAdminModule {}
