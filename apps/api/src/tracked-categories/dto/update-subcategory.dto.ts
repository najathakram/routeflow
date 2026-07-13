import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateSubcategoryDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
