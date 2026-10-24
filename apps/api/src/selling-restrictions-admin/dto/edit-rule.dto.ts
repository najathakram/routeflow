import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { RestrictionJurisdiction, RestrictionSurface } from "@prisma/client";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
/** A blank optional note means "no note". */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== "string") return value;
  const t = value.trim();
  return t === "" ? undefined : t;
};

/**
 * Row 509 PR3 — wire shape `RuleEditRequest` (POST /selling-restrictions/:id/edit-preview): the rule's FULL new
 * settings. Validation of the values is create's (`rule-settings.ts`); this class only checks shape and size.
 * `effectiveFrom` / `effectiveTo` omitted = unchanged; `effectiveTo: null` = open-ended.
 */
export class EditRuleDto {
  @IsEnum(RestrictionJurisdiction) jurisdiction: RestrictionJurisdiction;

  /** USPS codes or full state names; required (non-empty) for STATE, must be absent/empty for FEDERAL. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  states?: string[];

  @IsEnum(RestrictionSurface) surface: RestrictionSurface;

  @IsOptional() @IsDateString() effectiveFrom?: string;
  @IsOptional() @IsDateString() effectiveTo?: string | null;

  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason: string;

  /** Optional note on the revision. */
  @IsOptional() @Transform(trimToUndefined) @IsString() @MaxLength(500) note?: string;
}

/** Wire shape `RuleEditCommitRequest` (PUT /selling-restrictions/:id). */
export class CommitEditRuleDto extends EditRuleDto {
  /** The `revision` the preview (and the form) was computed against. */
  @IsInt() @Min(1) expectedRevision: number;

  /** The preview's `impactHash`. */
  @IsString() @MinLength(1) @MaxLength(128) @Matches(/\S/) confirmImpactHash: string;
}
