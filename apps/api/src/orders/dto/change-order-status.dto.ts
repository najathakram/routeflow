import { IsEnum, IsOptional, IsString } from "class-validator";
import { OrderStatus } from "@prisma/client";

export class ChangeOrderStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
  @IsOptional() @IsString() reason?: string;
}
