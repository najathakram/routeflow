import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { Transform } from "class-transformer";
import type {
  RULE_TARGETS_MAX_PER_REQUEST as SHARED_PER_REQUEST,
  RULE_TARGETS_MAX_PER_RULE as SHARED_PER_RULE,
} from "@routeflow/types";

/**
 * Row 509: the API-side copies of the shared caps (the API never imports `@routeflow/types` at runtime). Typed as
 * the shared constants' literal types, so a change to the shared caps fails to compile here until these follow.
 */
export const RULE_TARGETS_MAX_PER_REQUEST: typeof SHARED_PER_REQUEST = 1000;
export const RULE_TARGETS_MAX_PER_RULE: typeof SHARED_PER_RULE = 5000;

/** A blank optional note means "use the default", never an empty stored reason. */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== "string") return value;
  const t = value.trim();
  return t === "" ? undefined : t;
};

/**
 * `{ productIds?, categoryIds? }` (wire shape `RuleTargetsInput`). The DTO only bounds memory (a per-rule-sized array
 * per kind) and checks shapes: the 1,000-per-call cap and "at least one id" are the SERVICE's coded errors
 * (RULE_TARGET_LIMIT / a 400), so the web can branch on `code` + `field`.
 */
export class RuleTargetsInputDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RULE_TARGETS_MAX_PER_RULE)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  productIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RULE_TARGETS_MAX_PER_RULE)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  categoryIds?: string[];
}

/** POST /selling-restrictions/:id/targets (wire shape `AddRuleTargetsRequest`). */
export class AddRuleTargetsDto extends RuleTargetsInputDto {}

/** POST /selling-restrictions/:id/targets/remove (wire shape `RemoveRuleTargetsRequest`). */
export class RemoveRuleTargetsDto extends RuleTargetsInputDto {
  /** Defaults to "Removed from rule"; trimmed, at most 500. */
  @IsOptional() @Transform(trimToUndefined) @IsString() @MaxLength(500) reason?: string;
}

/** POST /selling-restrictions/holding (wire shape `RulesHoldingRequest`): 1..1,000 product ids. */
export class RulesHoldingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RULE_TARGETS_MAX_PER_REQUEST)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  productIds: string[];
}

/** The nested `targets` of POST /selling-restrictions (create). */
export class CreateTargetsDto extends RuleTargetsInputDto {}
