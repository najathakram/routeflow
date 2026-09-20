import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class UpdateProductCategoryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  /** true = archive (hide from pickers), false = restore. */
  @IsOptional() @IsBoolean() archived?: boolean;
}
