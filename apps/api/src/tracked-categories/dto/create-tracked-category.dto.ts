import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { TrackedCategoryTaxType, InvoiceTreatment, ReportCadence } from "@prisma/client";

export class CreateTrackedCategoryDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsEnum(TrackedCategoryTaxType) taxType?: TrackedCategoryTaxType;
  @IsOptional() @IsNumber() @Min(0) rate?: number;
  @IsOptional() @IsString() @MaxLength(40) unitBasis?: string;
  @IsOptional() @IsBoolean() priceIncludesTax?: boolean;
  @IsOptional() @IsEnum(InvoiceTreatment) invoiceTreatment?: InvoiceTreatment;
  @IsOptional() @IsObject() appliesScope?: Record<string, unknown>;
  @IsOptional() @IsBoolean() requiresLicense?: boolean;
  @IsOptional() @IsString() @MaxLength(40) reportTemplate?: string;
  @IsOptional() @IsEnum(ReportCadence) reportCadence?: ReportCadence;
  @IsOptional() @IsBoolean() active?: boolean;
}
