import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

class PartialInvoiceItemDto {
  @IsString() @MaxLength(64) orderItemId: string;
  /** How much of this order item to bill on this invoice. Must be > 0 and <= remaining qty. */
  @IsNumber() @Min(0.001) qty: number;
}

export class CreatePartialInvoiceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PartialInvoiceItemDto)
  items: PartialInvoiceItemDto[];

  /** ISO date — when omitted, defaults to today + tenant default term. */
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(64) terms?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  /** When true, transition the new invoice DRAFT → SENT immediately after create. */
  @IsOptional() @IsBoolean() send?: boolean;
}
