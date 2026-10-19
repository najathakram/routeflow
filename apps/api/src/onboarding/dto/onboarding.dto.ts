import { Type } from "class-transformer";
import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { DemoBookingStatus, OnboardingCaseStatus, OnboardingStage } from "@prisma/client";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";
// Values come from the generated Prisma enums: `@routeflow/types` ships TypeScript source and is
// TYPE-ONLY at API runtime (the compiled API cannot load it). The shared mirrors are pinned
// set-equal to these by enum-parity.spec.ts.
const STAGE_VALUES = Object.values(OnboardingStage);
const CASE_STATUS_VALUES = Object.values(OnboardingCaseStatus);
const DEMO_BOOKING_STATUS_VALUES = Object.values(DemoBookingStatus);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class OnboardingDealTermsDto {
  @IsOptional() @IsString() @MaxLength(40) planKey?: string;
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  addonSkus?: string[];
  @IsOptional() @IsIn(["month", "year"]) interval?: "month" | "year";
  /** Integer cents — never a float dollar amount. */
  @IsOptionalNotNull() @Type(() => Number) @IsInt() @Min(0) setupFeeCents?: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

/**
 * Company/contact fields are optional ONLY when `demoBookingId` is given — the service
 * fills any that are missing from the booking and refuses (400) when one is still blank.
 */
export class CreateOnboardingCaseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) companyName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) contactName?: string;
  @IsOptional() @IsEmail() @MaxLength(254) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(40) contactPhone?: string;
  @IsOptional() @IsUUID() demoBookingId?: string;
  @IsOptional() @IsString() @MaxLength(64) ownerAdminId?: string;
  @IsOptional()
  @Matches(DATE_ONLY, { message: "targetGoLiveOn must be YYYY-MM-DD" })
  targetGoLiveOn?: string;
  @IsOptional() @IsObject() fitNotes?: Record<string, unknown>;
  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardingDealTermsDto)
  dealTerms?: OnboardingDealTermsDto;
}

export class UpdateOnboardingCaseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) companyName?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) contactName?: string;
  @IsOptional() @IsEmail() @MaxLength(254) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(40) contactPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(64) ownerAdminId?: string | null;
  @IsOptional()
  @Matches(DATE_ONLY, { message: "targetGoLiveOn must be YYYY-MM-DD" })
  targetGoLiveOn?: string | null;
  @IsOptional() @IsISO8601() cutoverAt?: string | null;
  @IsOptional() @IsObject() fitNotes?: Record<string, unknown> | null;
  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardingDealTermsDto)
  dealTerms?: OnboardingDealTermsDto;
  @IsOptional() @IsIn(["OPEN", "ON_HOLD", "LOST"]) status?: "OPEN" | "ON_HOLD" | "LOST";
  @IsOptional() @IsString() @MaxLength(1000) lostReason?: string;
}

export class CompleteOnboardingStepDto {
  @IsOptional() @IsObject() evidence?: Record<string, unknown>;
}

export class WaiveOnboardingStepDto {
  /** Required and non-blank — the waiver log's "why". Whitespace-only is refused in the service too. */
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class ListOnboardingCasesQueryDto {
  @IsOptional() @IsIn(STAGE_VALUES) stage?: OnboardingStage;
  @IsOptional() @IsIn(CASE_STATUS_VALUES) status?: OnboardingCaseStatus;
  @IsOptional() @IsString() @MaxLength(64) ownerAdminId?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

export class ListDemoBookingsQueryDto {
  @IsOptional() @IsIn(DEMO_BOOKING_STATUS_VALUES) status?: DemoBookingStatus;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

/** `POST /onboarding/me/sign-off` (#2159 S4). The service trims and re-checks the length. */
export class OnboardingSignOffDto {
  @IsString() @MinLength(2) @MaxLength(200) signedName!: string;
}

/** `GET platform-admin/onboarding/funnel` (#2159 S5). Defaults: the last 90 days. */
export class OnboardingFunnelQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
