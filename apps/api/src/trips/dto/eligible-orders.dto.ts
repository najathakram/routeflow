import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class EligibleOrdersQueryDto {
  @IsOptional() @IsString() search?: string;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;

  @IsOptional() @IsInt() @Min(1) @Max(50) @Type(() => Number) limit?: number = 20;

  // Comma list of order ids already in the builder — same split-transform as
  // TripEligibilityQueryDto.orderIds, but optional (an empty builder has none yet).
  @Transform(({ value }) => (typeof value === "string" ? value.split(",").filter(Boolean) : value))
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  exclude?: string[];
}
