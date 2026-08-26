import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";
import { PurchaseOrderStatus } from "@prisma/client";

export class ListPurchaseOrdersDto {
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsEnum(PurchaseOrderStatus) status?: PurchaseOrderStatus;
  /**
   * Sent by the web Inventory→POs tab but not filtered on server-side yet;
   * whitelisted so the global forbidNonWhitelisted pipe doesn't 400 requests
   * that carry them.
   */
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
}
