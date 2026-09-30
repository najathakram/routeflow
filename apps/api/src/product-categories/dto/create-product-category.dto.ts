import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class CreateProductCategoryDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;
}
