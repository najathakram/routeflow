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
  /** Base units (pieces) ordered — boxed lines are converted by the caller. */
  @IsInt() @Min(1) qtyOrdered: number;
  /**
   * Cost per PIECE. This is the stored cost basis for the whole life of the
   * line: receivePurchaseOrder uses it as-is, so a Cost-per-Box entry must be
   * divided by unitsPerBox before it is sent (the Create-PO form does this).
   */
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
  /**
   * Per-item receipt. `qtyReceived` is base units (pieces) — omit it and send
   * `boxes`/`pieces` instead to receive in boxes; InventoryService.
   * receivePurchaseOrder resolves the piece QUANTITY from the split, exactly
   * like recordPurchase. A bare `qtyReceived` KEEPS meaning pieces — existing
   * callers are unaffected. The split never changes the cost basis: the line's
   * `unitCost` was stored per piece at creation and is used as-is.
   * The resolved quantity may not exceed what is outstanding on the line
   * (`qtyOrdered - qtyReceived`) — an over-receipt is rejected, not clamped.
   */
  @IsArray()
  items: Array<{ itemId: string; qtyReceived: number; boxes?: number; pieces?: number }>;
  @IsOptional() @IsString() notes?: string;
}
