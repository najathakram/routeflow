import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";

/**
 * PR-D: move stock atomically from a generic parent product to its variants.
 * See `InventoryService.assignToVariants` for the transaction this DTO feeds.
 */

export class NewVariantDto {
  /** Everything besides the name is inherited from the parent, server-side. */
  @IsString()
  @MaxLength(120)
  @StripHtml()
  name!: string;
}

export class VariantAssignmentDto {
  /** Existing variant to receive stock. Mutually exclusive with newVariant. */
  @IsOptional()
  @IsString()
  productId?: string;

  /**
   * Create a new variant of the parent instead. Name only — everything else
   * is inherited server-side (see InventoryService.createVariantRowInTx).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => NewVariantDto)
  newVariant?: NewVariantDto;

  /** Base units to move. Omit when sending boxes/pieces. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(9_999_999.999) // matches the qty column's Decimal(10,3)
  qty?: number;

  @IsOptional() @IsInt() @Min(0) @Max(100_000) @Type(() => Number) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) @Type(() => Number) pieces?: number;

  /** Rare: this variant cost more/less than the generic. 4dp. */
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(1_000_000)
  unitCostOverride?: number;
}

export class VariantAssignDto {
  @IsString()
  parentProductId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VariantAssignmentDto)
  assignments!: VariantAssignmentDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @StripHtml()
  notes?: string;
}
