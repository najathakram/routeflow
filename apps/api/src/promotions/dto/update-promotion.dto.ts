import { PartialType } from "@nestjs/mapped-types";
import { IsNumber, Min } from "class-validator";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";
import { CreatePromotionDto } from "./create-promotion.dto";

/**
 * All create fields optional; `productIds` replaces the set when scope = PRODUCTS.
 * `value` is redeclared: PartialType() re-adds @IsOptional(), which let `value: null` through to a
 * non-null Decimal column (500). A present null is now a 400 (row 602).
 */
export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {
  @IsOptionalNotNull() @IsNumber() @Min(0) value?: number;
}
