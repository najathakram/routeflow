import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type, Transform } from "class-transformer";

export class ListSuppliersDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
