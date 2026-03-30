import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateExpenseDto {
  @IsUUID() categoryId: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsDateString() date: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() paymentMethod?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateExpenseCategoryDto {
  @IsString() name: string;
  @IsString() code: string;
}

export class ReportQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() groupBy?: string;
}
