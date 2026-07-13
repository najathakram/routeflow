import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/** A classification child under a tracked category (section). Name + active only. */
export class CreateSubcategoryDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
