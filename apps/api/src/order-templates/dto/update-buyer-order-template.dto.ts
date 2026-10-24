import { IsBoolean } from "class-validator";

/** Buyer pause/resume of a standing template: `isActive` is the only field a buyer may change. */
export class UpdateBuyerOrderTemplateDto {
  @IsBoolean() isActive: boolean;
}
