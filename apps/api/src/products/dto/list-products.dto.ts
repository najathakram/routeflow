import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class ListProductsDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() lowStock?: boolean;
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}
