import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { PaymentMethod } from "@prisma/client";

export class CreateInvoiceItemDto {
  @IsString() description: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsNumber() @Min(0.001) qty: number;
  @IsNumber() @Min(0) unitPrice: number;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
}

export class CreateInvoiceDto {
  @IsUUID() customerId: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceItemDto)
  items: CreateInvoiceItemDto[];
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  @IsOptional() @IsNumber() @Min(0) shippingFee?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms?: string;
  /** If true, immediately send the invoice after creation (DRAFT → SENT). */
  @IsOptional() @IsBoolean() send?: boolean;
}

export class RecordInvoicePaymentDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsEnum(['DRAFT', 'PAID']) status?: string;
}

export class UpdatePaymentDto {
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsEnum(['DRAFT', 'PAID', 'VOID']) status?: string;
}

export class AllocationDto {
  @IsString() @IsNotEmpty() invoiceId: string;
  @IsNumber() @Min(0.01) amount: number;
}

export class StandalonePaymentDto {
  @IsString() @IsNotEmpty() customerId: string;
  @IsNumber() @Min(0.01) totalAmount: number;
  @IsEnum(PaymentMethod) method: string;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsNumber() @Min(0) bankCharges?: number;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsEnum(['DRAFT', 'PAID']) status?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => AllocationDto) allocations: AllocationDto[];
}

export class WriteOffDto {
  @IsString() @IsNotEmpty() reason: string;
}
