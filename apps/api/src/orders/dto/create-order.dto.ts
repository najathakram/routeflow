import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
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

// BUG-B1-6: bound numeric inputs server-side. The audit submitted a
// $25,664,510.89 order — all line items totalled cleanly through the API
// because there were no upper bounds on qty/unitPrice. Sane caps below
// (qty <= 100,000 units, unitPrice <= $1,000,000) keep the math under
// the Decimal(10,2) precision the schema reserves for totals.
export class OrderItemDto {
  @IsString() @MaxLength(64) productId: string;
  @IsInt() @Min(1) @Max(100_000) qty: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) pieces?: number;
  /** One-time discount price override — operator-supplied, not stored in CustomerPrice */
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) unitPrice?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @MaxLength(2000) itemNote?: string;
  @IsOptional() @IsString() @MaxLength(200) substitution?: string;
}

export class CreateOrderDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsEnum(["DRAFT", "PENDING"]) status?: "DRAFT" | "PENDING";
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[];
  // RF-110: strip HTML to prevent stored XSS via order notes
  @IsOptional() @StripHtml() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
  @IsOptional() @IsString() @MaxLength(64) routeRunId?: string;
  @IsOptional() @IsString() @MaxLength(64) routeRunStopId?: string;
  @IsOptional() @IsBoolean() immediateDelivery?: boolean;
  /** Order-level discount applied to the total */
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) discountAmount?: number;
  /** When true, always create a new order even if a PENDING one already exists for this customer */
  @IsOptional() @IsBoolean() forceNew?: boolean;
  /**
   * Operator's explicit choice when an active DRAFT/PENDING order exists for this customer.
   *  - "merge"    → fold these items into the existing active order
   *  - "separate" → create a new isolated order; sets Order.skipAutoMerge=true so the cron sweep
   *                 won't fold it back in
   * If omitted AND an active order exists AND the caller is staff, the API responds 409 with
   * `{ code: 'MERGE_CHOICE_REQUIRED', activeOrder: {...} }` so the UI can prompt.
   */
  @IsOptional() @IsEnum(["merge", "separate"]) mergeChoice?: "merge" | "separate";
}
