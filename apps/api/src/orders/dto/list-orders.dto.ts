import { IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { OrderStatus } from "@prisma/client";

export class ListOrdersDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() urgent?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
  @IsOptional() @IsDateString() deliveryDateFrom?: string;
  @IsOptional() @IsDateString() deliveryDateTo?: string;
}
