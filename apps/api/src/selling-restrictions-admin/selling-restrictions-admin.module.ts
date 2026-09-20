import { Module } from "@nestjs/common";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";

/** Rule admin (list / create / lift). The list is live (OPERATOR read); nothing ENFORCES rules until step 6 switches the feature on. */
@Module({
  controllers: [SellingRestrictionsAdminController],
  providers: [SellingRestrictionsAdminService],
})
export class SellingRestrictionsAdminModule {}
