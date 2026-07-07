import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** Body for `PUT /import/numbering/:docType` — all fields optional (partial edit). */
export class UpdateNumberingDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  nextNumber?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  padding?: number;
}
