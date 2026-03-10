import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { RouteRunStatus } from '@prisma/client';

export class ListRunsDto {
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() assignedToMe?: boolean;
  @IsOptional() @IsEnum(RouteRunStatus) status?: RouteRunStatus;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
}
