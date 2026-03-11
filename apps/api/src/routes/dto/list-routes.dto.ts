import { IsBoolean, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Type, Transform } from "class-transformer";

export class ListRoutesDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
}
