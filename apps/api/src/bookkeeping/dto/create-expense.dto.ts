import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class ExpenseLineItemDto {
  @IsString() account: string;
  @IsOptional() @IsString() notes?: string;
  @IsNumber() @Min(0) amount: number;
}

export class CreateExpenseDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsNumber() @Min(0) amount: number;
  @IsDateString() date: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() paymentMethod?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() referenceNumber?: string;
  @IsOptional() @IsBoolean() isItemized?: boolean;
  @IsOptional() @IsBoolean() isMileage?: boolean;
  @IsOptional() @IsBoolean() isBillable?: boolean;
  @IsOptional() @IsString() employeeName?: string;
  @IsOptional() @IsString() mileageUnit?: string;
  @IsOptional() @IsNumber() @Min(0) distance?: number;
  @IsOptional() @IsNumber() @Min(0) mileageRateSnapshot?: number;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ExpenseLineItemDto)
  lineItems?: ExpenseLineItemDto[];
}

export class CreateExpenseCategoryDto {
  @IsString() name: string;
  @IsString() code: string;
}

export class UpdateExpenseDto {
  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() referenceNumber?: string;
  @IsOptional() @IsBoolean() isBillable?: boolean;
  @IsOptional() @IsString() employeeName?: string;
}

export class ListExpensesDto {
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() type?: string; // "mileage" | "itemized" | "standard"
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
}

export class CreateMileageRateDto {
  @IsDateString() startDate: string;
  @IsNumber() @Min(0) ratePerUnit: number;
  @IsOptional() @IsString() unit?: string;
}

export class BulkCreateExpenseDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CreateExpenseDto)
  expenses: CreateExpenseDto[];
}

export class ReportQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() groupBy?: string;
}
