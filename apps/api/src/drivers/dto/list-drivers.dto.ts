import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DriverStatus } from '@prisma/client';

export class ListDriversDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(DriverStatus) status?: DriverStatus;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
}
