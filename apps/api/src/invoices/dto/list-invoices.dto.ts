import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { InvoiceStatus } from "@prisma/client";
import { MAX_LIST_LIMIT } from "../../common/pagination";

export class ListInvoicesDto {
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional()
  @IsArray()
  @IsEnum(InvoiceStatus, { each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  statuses?: InvoiceStatus[];
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() dateFrom?: string;
  @IsOptional() @IsString() dateTo?: string;
  @IsOptional() @IsDateString() dueFrom?: string;
  @IsOptional() @IsDateString() dueTo?: string;
  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsString() sortOrder?: "asc" | "desc";
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isOverdue?: boolean;
  /** Shipments view: only invoices that carry a carrier tracking number. */
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() shipped?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_LIST_LIMIT) @Type(() => Number) limit?: number;
}
