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
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  Validate,
  ArrayNotEmpty,
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

/**
 * B780: each item needs an identifier the service can match against a PO line
 * (`id ?? itemId`, falling back to `productId` — InventoryService.
 * receivePurchaseOrder) AND a quantity (`receivedQty`/`qtyReceived`, or a
 * `boxes`/`pieces` split) — every field below is individually optional (web
 * sends `id`+`receivedQty`; mobile sends `itemId` and either `qtyReceived` or
 * `boxes`+`pieces`), so nothing here catches an item with NEITHER.
 */
@ValidatorConstraint({ name: "hasReceiveIdentifierAndQuantity", async: false })
class HasReceiveIdentifierAndQuantityConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const item = args.object as ReceivePurchaseOrderItemDto;
    const hasIdentifier = !!(item.id || item.itemId || item.productId);
    const hasQuantity =
      item.receivedQty != null ||
      item.qtyReceived != null ||
      item.boxes != null ||
      item.pieces != null;
    return hasIdentifier && hasQuantity;
  }
  defaultMessage() {
    return "each receive item needs an identifier (id/itemId/productId) and a quantity (receivedQty/qtyReceived/boxes/pieces)";
  }
}

export class ReceivePurchaseOrderItemDto {
  // Web sends `id`; mobile sends `itemId`; the service also falls back to
  // matching by `productId` alone. All optional — see the class validator below.
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsUUID() itemId?: string;
  @IsOptional() @IsUUID() productId?: string;
  /**
   * Base units (pieces). Omit and send `boxes`/`pieces` instead to receive in
   * boxes; InventoryService.receivePurchaseOrder resolves the piece QUANTITY
   * from the split, exactly like recordPurchase. A bare `receivedQty`/
   * `qtyReceived` KEEPS meaning pieces — existing callers are unaffected. No
   * `@Type(() => Number)` here: a string quantity is REJECTED, not silently
   * coerced (the string-concatenation bug this DTO exists to close).
   */
  @IsOptional() @IsNumber() @Min(0) receivedQty?: number;
  @IsOptional() @IsNumber() @Min(0) qtyReceived?: number;
  @IsOptional() @IsInt() @Min(0) boxes?: number;
  @IsOptional() @IsInt() @Min(0) pieces?: number;

  @Validate(HasReceiveIdentifierAndQuantityConstraint)
  private readonly _hasIdentifierAndQuantity?: never;
}

export class ReceivePurchaseOrderDto {
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReceivePurchaseOrderItemDto)
  items: ReceivePurchaseOrderItemDto[];
  @IsOptional() @IsString() notes?: string;
}
