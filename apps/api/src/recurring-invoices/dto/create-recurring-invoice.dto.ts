import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
  ArrayMinSize,
} from "class-validator";
import { Type } from "class-transformer";
import { RecurringFrequency } from "@prisma/client";

export class RecurringInvoiceItemDto {
  @IsString() description: string;
  @IsOptional() @IsUUID() productId?: string;
  /**
   * B646 / SA-135: for a BOXED product (unitsPerBox > 1) `qty` counts BOXES and `unitPrice` is the
   * per-box price (2.5 on a 12-pack = 2 boxes + 6 pieces). Generation stores the invoice line in
   * pieces (qty 30). For any other product it counts units. The update DTO inherits this field.
   */
  @IsNumber() @Min(0.001) qty: number;
  @IsNumber() @Min(0) unitPrice: number;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
}

export class CreateRecurringInvoiceDto {
  @IsUUID() customerId: string;
  @IsEnum(RecurringFrequency) frequency: RecurringFrequency;
  @IsOptional() @IsNumber() @Min(0) @Max(6) dayOfWeek?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(28) dayOfMonth?: number;
  @IsOptional() @IsBoolean() autoSend?: boolean;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms?: string;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) shippingFee?: number;
  @IsDateString() nextRunAt: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecurringInvoiceItemDto)
  items: RecurringInvoiceItemDto[];
}
