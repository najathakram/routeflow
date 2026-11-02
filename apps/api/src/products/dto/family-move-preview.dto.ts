import { IsDecimal, IsInt, IsOptional, Min } from "class-validator";
import { Transform } from "class-transformer";
import { toOptionalDecimalString } from "../../common/dto-transforms";

/** SA-1082 A-1: the family's prices as the save would leave them. An absent price is unchanged. */
export class FamilyMovePreviewDto {
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() pricePerUnit?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier2?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier3?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier4?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier5?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
}
