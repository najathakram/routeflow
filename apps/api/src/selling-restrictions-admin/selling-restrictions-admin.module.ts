import { Module } from "@nestjs/common";
import { ProductLabelsModule } from "../product-labels/product-labels.module";
import { SellingRestrictionsModule } from "../selling-restrictions/selling-restrictions.module";
import { RuleEditController } from "./rule-edit.controller";
import { RuleEditService } from "./rule-edit.service";
import { RuleTargetsController } from "./rule-targets.controller";
import { RuleTargetsService } from "./rule-targets.service";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";

/**
 * Rule admin (list / create / bulk / lift / lift-batch / product chips) and, row 509, a rule's targets (detail /
 * add / remove / holding) and settings edits with history (edit-preview / PUT :id). The chips read effective labels. `RuleTargetsController` is registered FIRST so its
 * `GET :id` and `POST holding` can never be shadowed by a route of the admin controller.
 */
@Module({
  imports: [ProductLabelsModule, SellingRestrictionsModule],
  controllers: [RuleTargetsController, SellingRestrictionsAdminController, RuleEditController],
  providers: [SellingRestrictionsAdminService, RuleTargetsService, RuleEditService],
})
export class SellingRestrictionsAdminModule {}
