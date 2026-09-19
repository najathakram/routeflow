import {
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
  ValidateIf,
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
  /** Decimal-unit lines are real (kg, litre) — 3dp, matching the Decimal(10,3) column. */
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) qtyOrdered: number;
  /** Cost per PIECE, 4dp — matching the Decimal(10,4) column. */
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitCost: number;
  /** Supplier's own SKU for the line (null clears it). */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(100) sku?: string | null;
  /** Pieces per supplier unit (null clears it). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  packSize?: number | null;
}

export class UpdatePurchaseOrderDto {
  /** Supplier change — DRAFT/SENT, or a received PO only together with `reapplyInventory: true`. */
  @IsOptional() @IsUUID() supplierId?: string;
  /** null clears the expected date. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() expectedDate?: string | null;
  /** null clears the notes. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() notes?: string | null;
  /** Full replacement line set (see {@link UpdatePurchaseOrderItemDto}). */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdatePurchaseOrderItemDto)
  items?: UpdatePurchaseOrderItemDto[];
  /**
   * Required when `items` changes a PARTIAL/RECEIVED order — the operator must
   * say what happens to stock. `true` = reverse this PO's stock movements, lots
   * and average cost, apply the edit and re-post the receipts in ONE
   * transaction; `false` = document-only (`qtyOrdered ≥ qtyReceived` enforced,
   * stock and cost untouched). Ignored on DRAFT/SENT (nothing was received).
   */
  @IsOptional() @IsBoolean() reapplyInventory?: boolean;
}
