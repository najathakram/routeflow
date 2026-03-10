import { IsBoolean, IsNumberString, IsOptional, IsString, Transform } from 'class-validator';

export class ListProductsDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() lowStock?: boolean;
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() isActive?: boolean;
  @IsOptional() @IsNumberString() page?: string;
  @IsOptional() @IsNumberString() limit?: string;
}
