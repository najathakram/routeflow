import { IsDecimal, IsInt, IsOptional, Min } from "class-validator";
import { Transform } from "class-transformer";
import { toOptionalDecimalString } from "../../common/dto-transforms";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

/** SA-1082 A-1: the family's prices as the save would leave them. An absent price is unchanged; so is a blank, on the save too. */
export class FamilyMovePreviewDto {
  @IsOptionalNotNull() @Transform(toOptionalDecimalString) @IsDecimal() pricePerUnit?: string;
  @IsOptionalNotNull() @Transform(toOptionalDecimalString) @IsDecimal() priceTier2?: string;
  @IsOptionalNotNull() @Transform(toOptionalDecimalString) @IsDecimal() priceTier3?: string;
  @IsOptionalNotNull() @Transform(toOptionalDecimalString) @IsDecimal() priceTier4?: string;
  @IsOptionalNotNull() @Transform(toOptionalDecimalString) @IsDecimal() priceTier5?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
}
