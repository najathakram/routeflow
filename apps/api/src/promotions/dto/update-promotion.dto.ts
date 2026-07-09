import { PartialType } from "@nestjs/mapped-types";
import { CreatePromotionDto } from "./create-promotion.dto";

/** All create fields optional; `productIds` replaces the set when scope = PRODUCTS. */
export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {}
