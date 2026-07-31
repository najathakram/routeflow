import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { TrackedCategoryTaxType, InvoiceTreatment, ReportCadence } from "@prisma/client";
import { TX_UOM_CODES } from "../../regulated/tx-report";

// Flattened across item types — cross-checking a UOM against its item type is a
// service-level concern (or left to the operator); the DTO just validates "is
// this a real TX UOM code at all".
const TX_UOM_ALL = Object.values(TX_UOM_CODES).flat();

export class UpdateTrackedCategoryDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEnum(TrackedCategoryTaxType) taxType?: TrackedCategoryTaxType;
  @IsOptional() @IsNumber() @Min(0) rate?: number;
  @IsOptional() @IsString() @MaxLength(40) unitBasis?: string;
  @IsOptional() @IsBoolean() priceIncludesTax?: boolean;
  @IsOptional() @IsEnum(InvoiceTreatment) invoiceTreatment?: InvoiceTreatment;
  @IsOptional() @IsObject() appliesScope?: Record<string, unknown>;
  @IsOptional() @IsBoolean() requiresLicense?: boolean;
  @IsOptional() @IsString() @MaxLength(40) reportTemplate?: string;
  @IsOptional() @IsEnum(ReportCadence) reportCadence?: ReportCadence;
  // TX Comptroller (TX_COMPTROLLER report template) config — see schema.prisma TrackedCategory.
  // `null` is an explicit CLEAR (the columns are nullable and @IsOptional() skips validation for
  // it); clients must send null rather than omitting the key, which would leave the old value.
  @IsOptional() @IsString() @MaxLength(20) wholesalerLicenseNo?: string | null;
  // DEPRECATED — superseded by Product.regItemType/regUomUnit. Still ACCEPTED (and
  // ignored) so an older mobile build's category save is not rejected by
  // forbidNonWhitelisted. Remove next release.
  @IsOptional() @IsInt() @IsIn([1, 2, 3]) txItemType?: number | null;
  @IsOptional() @IsString() @IsIn(TX_UOM_ALL) txUom?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
  /** Saved custom report column layout, keyed by template code. */
  @IsOptional()
  @IsObject()
  reportColumnPrefs?: Record<string, string[]> | null;
}
