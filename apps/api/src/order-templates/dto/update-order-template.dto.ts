import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export class UpdateOrderTemplateDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  daysOfWeek?: number[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() notes?: string;
}
