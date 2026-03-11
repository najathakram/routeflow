import { IsArray, IsEnum, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MutationType } from '@prisma/client';

class DeliveryItemDto {
  @IsString() orderItemId: string;
  @IsEnum(MutationType) type: MutationType;
  @IsInt() @Min(0) quantityDelivered: number;
  @IsOptional() @IsString() note?: string;
}

export class CompleteStopDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => DeliveryItemDto) deliveries: DeliveryItemDto[];
  @IsOptional() @IsString() driverNote?: string;
}
