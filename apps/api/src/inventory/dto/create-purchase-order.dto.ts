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
  ValidateIf,
  ArrayNotEmpty,
} from "class-validator";
import { Type } from "class-transformer";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

/**
 * One line of a new purchase order, in ONE of two forms (poLineFromInput computes the money either way):
 *  - PER CASE (`caseCost` present): `packSize`, `caseCost`, `cases` and optional `loosePieces`, as entered.
 *  - PER PIECE (no `caseCost`): a piece quantity and a per-piece `unitCost`. Web sends the quantity as
 *    `qty`, mobile as `qtyOrdered`; either one is enough.
 * D-12: bound to the endpoint, so an unknown field is a 400. Numeric semantics (a pack > 1, a positive
 * quantity) stay with poLineFromInput / buildPOLine, which already answer 400.
 */
export class PurchaseOrderItemDto {
  @IsUUID() productId: string;
  /** PER PIECE (web): pieces ordered. */
  @IsOptional() @IsNumber() @Min(0) qty?: number;
  /** PER PIECE (mobile): pieces ordered. Required with no `caseCost` and no `qty`. */
  @ValidateIf(
    (o: PurchaseOrderItemDto) =>
      o.caseCost === undefined && (o.qty === undefined || o.qtyOrdered !== undefined),
  )
  @IsNumber()
  @Min(0)
  qtyOrdered?: number;
  /** PER PIECE: cost per piece. */
  @ValidateIf((o: PurchaseOrderItemDto) => o.caseCost === undefined || o.unitCost !== undefined)
  @IsNumber()
  @Min(0)
  unitCost?: number;
  /** PER CASE: pieces per case (the stored denomination). */
  @IsOptional() @IsInt() @Min(1) packSize?: number;
  /** PER CASE: the cost of one case, as entered. */
  @IsOptionalNotNull() @IsNumber() @Min(0) caseCost?: number;
  /** PER CASE: whole cases ordered. */
  @ValidateIf((o: PurchaseOrderItemDto) => o.caseCost !== undefined || o.cases !== undefined)
  @IsInt()
  @Min(0)
  cases?: number;
  /** PER CASE: loose pieces beyond whole cases. */
  @IsOptional() @IsInt() @Min(0) loosePieces?: number;
}

export class CreatePurchaseOrderDto {
  @IsUUID() supplierId: string;
  @IsArray()
  @ArrayNotEmpty()
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
