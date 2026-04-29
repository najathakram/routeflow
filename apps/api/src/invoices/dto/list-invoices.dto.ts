import { IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { InvoiceStatus } from "@prisma/client";

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
  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsString() sortOrder?: "asc" | "desc";
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isOverdue?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number;
}
