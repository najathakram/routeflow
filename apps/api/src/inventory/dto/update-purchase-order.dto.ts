import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * One line of an edited purchase order. `qtyOrdered` is base units (pieces) and
 * `unitCost` is per PIECE — the same denomination `createPurchaseOrder` stores
 * (the web forms convert a boxed entry before posting). `id` names an existing
 * line to keep; a line without `id` is new, and an existing line missing from
 * the payload is removed.
 */
export class UpdatePurchaseOrderItemDto {
  @IsOptional() @IsUUID() id?: string;
  @IsUUID() productId: string;
  /**
   * Decimal-unit lines are real (kg, litre) — 3dp, matching Decimal(10,3); the
   * ceiling keeps an out-of-range value a 400 rather than a database overflow.
   */
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(9_999_999) qtyOrdered: number;
  /** Cost per PIECE, 4dp — matching Decimal(10,4). */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(999_999) unitCost: number;
  /** Supplier's own SKU for the line (null clears it). */
  @IsOptional() @IsString() @MaxLength(100) sku?: string | null;
  /** Pieces per supplier unit (null clears it). */
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) packSize?: number | null;
}

export class UpdatePurchaseOrderDto {
  /** Supplier change — DRAFT/SENT, or a received PO only together with `reapplyInventory: true`. */
  @IsOptional() @IsUUID() supplierId?: string;
  /** null clears the expected date. */
  @IsOptional() @IsDateString() expectedDate?: string | null;
  /** null clears the notes. */
  @IsOptional() @IsString() notes?: string | null;
  /**
   * The COMPLETE replacement line set (see {@link UpdatePurchaseOrderItemDto}) —
   * an existing line left out of the array is deleted, so a client must send
   * every line it means to keep.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => UpdatePurchaseOrderItemDto)
  items?: UpdatePurchaseOrderItemDto[];
  /**
   * Required when `items` changes a PARTIAL/RECEIVED order — the operator must
   * say what happens to stock. `true` = reverse this PO's stock movements, lots
   * and average cost, apply the edit and re-post the receipts in ONE
   * transaction; `false` = document-only (`qtyOrdered ≥ qtyReceived` enforced,
   * stock and cost untouched). Ignored on DRAFT/SENT (nothing was received).
   *
   * Re-applying is the operator's statement of what actually arrived: on a
   * RECEIVED order every edited line is treated as received in full at its new
   * quantity and cost.
   */
  @IsOptional() @IsBoolean() reapplyInventory?: boolean;
}
