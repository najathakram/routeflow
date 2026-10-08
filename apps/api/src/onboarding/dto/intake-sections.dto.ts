import { BadRequestException } from "@nestjs/common";
import { plainToInstance, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  validate,
  type ValidationError,
} from "class-validator";
import type { IntakeSectionKey } from "@prisma/client";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * One class-validator DTO per IntakeSectionKey (#2159 S2) — playbook Appendix A, sections B–H.
 * Shapes mirror packages/types/api/onboarding.ts (`Intake*Answers`).
 *
 * The public link never carries a secret (plan §2): there is no password, bank/card number or
 * API-key field anywhere, and `validateSectionAnswers` refuses every unknown field
 * (forbidNonWhitelisted), so one cannot be smuggled in either.
 */
export const INTAKE_SCHEMA_VERSION = 1;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const US_STATE = /^[A-Z]{2}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,29}$/;
/** Union of the two reserved lists (platform-admin createTenant + self-signup), so a slug this
 *  form accepts is never refused when S3a creates the workspace. */
export const INTAKE_RESERVED_SLUGS = [
  "admin",
  "api",
  "app",
  "www",
  "platform",
  "auth",
  "health",
  "static",
  "assets",
  "mail",
  "support",
  "login",
  "signup",
  "register",
  "billing",
  "dashboard",
];
const S = 200; // short text
const L = 2000; // long text

export class IntakeAccountDto {
  @IsString() @MinLength(1) @MaxLength(S) legalName!: string;
  @IsOptional() @IsString() @MaxLength(S) displayName?: string;
  @IsString()
  @Matches(SLUG, {
    message:
      "slug must be 3–30 lowercase letters, digits or hyphens, starting with a letter or digit",
  })
  @IsNotReservedSlug()
  slug!: string;
  @IsString() @MinLength(1) @MaxLength(S) ownerName!: string;
  @IsString() @MinLength(1) @MaxLength(S) adminName!: string;
  @IsEmail() @MaxLength(254) adminEmail!: string;
  @IsOptional() @IsString() @MaxLength(60) adminUsername?: string;
  @IsString() @MinLength(1) @MaxLength(S) addressLine1!: string;
  @IsOptional() @IsString() @MaxLength(S) addressLine2?: string;
  @IsString() @MinLength(1) @MaxLength(100) city!: string;
  @Matches(US_STATE, { message: "state must be a 2-letter code" }) state!: string;
  @Matches(/^\d{5}(-\d{4})?$/, { message: "zip must be a US ZIP code" }) zip!: string;
  @IsString() @MinLength(7) @MaxLength(40) phone!: string;
  @IsOptional() @IsEmail() @MaxLength(254) replyToEmail?: string;
  @IsOptional() @IsString() @MaxLength(S) website?: string;
  @IsString()
  @IsTimeZone({ message: "timeZone must be an IANA zone" })
  timeZone!: string;
}

class RegulatedGoodDto {
  @IsIn(["tobacco", "vape", "nicotine", "alcohol", "other"]) category!: string;
  @IsArray() @ArrayMaxSize(60) @Matches(US_STATE, { each: true }) states!: string[];
  @IsOptional() @IsString() @MaxLength(S) note?: string;
}

class LicenceDto {
  @IsString() @MinLength(1) @MaxLength(S) name!: string;
  @IsString() @MinLength(1) @MaxLength(100) number!: string;
  @IsOptional() @Matches(US_STATE) state?: string;
  @IsOptional() @Matches(DATE_ONLY) expiresOn?: string;
}

export class IntakeTaxComplianceDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(30) salesTaxRatePercent?: number;
  @IsOptional()
  @Matches(/^\d{2}-?\d{7}$/, { message: "federalEin must look like 12-3456789" })
  federalEin?: string;
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RegulatedGoodDto)
  regulatedGoods!: RegulatedGoodDto[];
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LicenceDto)
  licences!: LicenceDto[];
  @IsArray() @ArrayMaxSize(60) @Matches(US_STATE, { each: true }) statesSoldInto!: string[];
  @IsOptional() @IsString() @MaxLength(L) exciseNotes?: string;
  @IsBoolean() hasTaxExemptCustomers!: boolean;
  @IsOptional() @IsString() @MaxLength(L) retailLicenceNotes?: string;
}

export class IntakeInvoicingDto {
  @IsOptional() @IsString() @MaxLength(60) lastInvoiceNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) invoiceNumberFormat?: string;
  @IsOptional() @IsString() @MaxLength(60) lastQuoteNumber?: string;
  @IsOptional() @IsString() @MaxLength(60) lastCreditNoteNumber?: string;
  @IsIn(["COD", "NET_7", "NET_15", "NET_30", "NET_45", "NET_60", "OTHER"]) paymentTerms!: string;
  @IsOptional() @IsString() @MaxLength(S) paymentTermsOther?: string;
  @IsOptional() @IsString() @MaxLength(L) invoiceFooterText?: string;
  @IsBoolean() takesDeposits!: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) depositPercent?: number;
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(["cash", "check", "ach", "card", "zelle", "other"], { each: true })
  paymentMethods!: string[];
  /** Method NAMES only — never account or card numbers (plan §2). */
  @IsOptional() @IsString() @MaxLength(S) paymentMethodsOther?: string;
  @IsBoolean() wantsOnlineCardPay!: boolean;
}

class StaffDto {
  @IsString() @MinLength(1) @MaxLength(S) name!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @IsIn(["admin", "office"]) role!: string;
}

class DriverDto {
  @IsString() @MinLength(1) @MaxLength(S) name!: string;
  @IsString() @MinLength(7) @MaxLength(40) mobile!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
}

export class IntakeTeamDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StaffDto)
  staff!: StaffDto[];
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DriverDto)
  drivers!: DriverDto[];
  @IsOptional() @IsInt() @Min(0) @Max(1000) vehicleCount?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  vehicleNames?: string[];
}

export class IntakeOperationsDto {
  @IsString() @MinLength(1) @MaxLength(400) depotAddress!: string;
  @IsArray()
  @ArrayMaxSize(7)
  @IsIn(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], { each: true })
  deliveryDays!: string[];
  @IsOptional() @IsString() @MaxLength(L) deliveryAreas?: string;
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "orderCutoffTime must be HH:MM" })
  orderCutoffTime?: string;
  @IsBoolean() hasTimeWindowCustomers!: boolean;
  @IsOptional() @IsString() @MaxLength(L) timeWindowNotes?: string;
  @IsBoolean() offersCustomerPickup!: boolean;
}

export class IntakeDataFilesDto {
  @IsString() @MinLength(1) @MaxLength(L) currentSystems!: string;
  @IsOptional() @Matches(DATE_ONLY) stockCountDate?: string;
  @IsOptional() @IsString() @MaxLength(L) notes?: string;
}

export class IntakeGoLivePrefsDto {
  @IsOptional() @Matches(DATE_ONLY) earliestGoLiveDate?: string;
  @IsOptional() @IsString() @MaxLength(L) trainingAttendees?: string;
  @IsOptional() @IsString() @MaxLength(L) trainingAvailability?: string;
  @IsOptional() @IsString() @MaxLength(L) notes?: string;
}

export const SECTION_DTOS: Record<IntakeSectionKey, new () => object> = {
  ACCOUNT: IntakeAccountDto,
  TAX_COMPLIANCE: IntakeTaxComplianceDto,
  INVOICING: IntakeInvoicingDto,
  TEAM: IntakeTeamDto,
  OPERATIONS: IntakeOperationsDto,
  DATA_FILES: IntakeDataFilesDto,
  GO_LIVE_PREFS: IntakeGoLivePrefsDto,
};

/**
 * Validates a section's answers. `partial: true` (a draft save) lets required fields be missing
 * but still type-checks every field that IS present and refuses unknown ones; `partial: false`
 * (submit) requires the whole section. Returns the answers as stored (plain JSON).
 */
export async function validateSectionAnswers(
  key: IntakeSectionKey,
  answers: unknown,
  opts: { partial: boolean },
): Promise<Record<string, unknown>> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new BadRequestException("answers must be an object");
  }
  const dto = plainToInstance(SECTION_DTOS[key], answers);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    skipMissingProperties: opts.partial,
  });
  if (errors.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      code: API_ERROR_CODES.INTAKE_ANSWERS_INVALID,
      message: "Some answers need fixing",
      errors: flatten(errors),
    });
  }
  return JSON.parse(JSON.stringify(dto)) as Record<string, unknown>;
}

function flatten(errors: ValidationError[], prefix = ""): { field: string; messages: string[] }[] {
  const out: { field: string; messages: string[] }[] = [];
  for (const e of errors) {
    const field = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) out.push({ field, messages: Object.values(e.constraints) });
    if (e.children?.length) out.push(...flatten(e.children, field));
  }
  return out;
}

function IsNotReservedSlug() {
  return Matches(new RegExp(`^(?!(${INTAKE_RESERVED_SLUGS.join("|")})$)`), {
    message: "that workspace address is reserved — pick another",
  });
}
