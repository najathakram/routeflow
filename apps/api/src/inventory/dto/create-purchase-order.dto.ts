import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class PurchaseOrderItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) qtyOrdered: number;
  @IsNumber() @Min(0) unitCost: number;
}

export class CreatePurchaseOrderDto {
  @IsUUID() supplierId: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  items: PurchaseOrderItemDto[];
  @IsOptional() @IsDateString() expectedDate?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ReceivePurchaseOrderDto {
  @IsArray() items: Array<{ itemId: string; qtyReceived: number }>;
  @IsOptional() @IsString() notes?: string;
}
