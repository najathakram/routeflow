import { IsBoolean, IsOptional, IsString } from "class-validator";
import { Transform } from "class-transformer";

export class ListTrackedCategoriesDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() active?: boolean;
}
