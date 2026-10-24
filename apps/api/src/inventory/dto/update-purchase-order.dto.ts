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
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

/**
 * One line of an edited purchase order, in ONE of two forms (the server computes the money either way):
 *  - PER CASE (`caseCost` present): `packSize` (pieces per case, > 1), `caseCost` (per case, as entered),
 *    `cases` and optional `loosePieces`. The server derives the quantity, the per-piece cost (4 dp, for costing
 *    only) and the exact total roundMoney(caseCost x (cases + loosePieces / packSize)), stores `packSize` as the
 *    denomination, and IGNORES any `qtyOrdered` / `unitCost` sent alongside.
 *  - PER PIECE (no `caseCost`): `qtyOrdered` is base units (pieces) and `unitCost` is per PIECE, as before.
 * `id` names an existing line to keep; a line without `id` is new, and an existing line missing from the payload
 * is removed.
 */
export class UpdatePurchaseOrderItemDto {
  @IsOptional() @IsUUID() id?: string;
  @IsUUID() productId: string;
  /**
   * Decimal-unit lines are real (kg, litre) — 3dp, matching Decimal(10,3); the
   * ceiling keeps an out-of-range value a 400 rather than a database overflow.
   */
  @ValidateIf((o: UpdatePurchaseOrderItemDto) => o.caseCost === undefined)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(9_999_999)
  qtyOrdered?: number;
  /** Cost per PIECE, 4dp — matching Decimal(10,4). */
  @ValidateIf((o: UpdatePurchaseOrderItemDto) => o.caseCost === undefined)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999_999)
  unitCost?: number;
  /** PER CASE: the cost of one case as entered (4dp: a stored row's honest derivation is 11.0004). */
  @IsOptionalNotNull() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(999_999) caseCost?: number;
  /** PER CASE: whole cases ordered. */
  @ValidateIf((o: UpdatePurchaseOrderItemDto) => o.caseCost !== undefined)
  @IsInt()
  @Min(0)
  @Max(9_999_999)
  cases?: number;
  /** PER CASE: loose pieces beyond whole cases. */
  @IsOptional() @IsInt() @Min(0) @Max(9_999_999) loosePieces?: number;
  /** Supplier's own SKU for the line (null clears it). */
  @IsOptional() @IsString() @MaxLength(100) sku?: string | null;
  /**
   * The denomination: non-null means the cost was entered PER CASE of this many pieces, null means per piece
   * (null clears it). Required (and > 1) with `caseCost`.
   */
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
   * transaction; `false` = document-only (stock and cost untouched). Ignored on
   * DRAFT/SENT (nothing was received).
   *
   * Either way a re-apply restates the COST (and supplier) of what was already
   * received — never its quantity. A received line can't drop below what was
   * received, change product or be removed (record a return instead), and a
   * raised `qtyOrdered` or an added line is outstanding: it is received later
   * through the normal receive, so a RECEIVED order can become PARTIAL.
   */
  @IsOptional() @IsBoolean() reapplyInventory?: boolean;
}
