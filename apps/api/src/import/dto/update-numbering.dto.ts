import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from "class-validator";
import { validateDocumentPrefix } from "@routeflow/types";

/** B1188: the shared prefix rule (length, charset, no trailing digit), same fn the web forms use. */
@ValidatorConstraint({ name: "documentPrefix", async: false })
export class DocumentPrefixConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return validateDocumentPrefix(value) === null;
  }
  defaultMessage(args: ValidationArguments): string {
    return validateDocumentPrefix(args.value) ?? "Invalid prefix.";
  }
}

/** Body for `PUT /import/numbering/:docType` — a partial edit plus the required version token. */
export class UpdateNumberingDto {
  @IsOptional()
  @IsString()
  @Validate(DocumentPrefixConstraint)
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  // 9 digits: the numbering scans capture \d{1,9} (an int cast), so a larger next number would
  // be invisible to the max-first guard and the save check (SA-274 invariant).
  @Max(999_999_999)
  nextNumber?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  padding?: number;

  /**
   * Optimistic-concurrency token (SA-274 Q3): the stored `nextNumber` the web
   * card loaded before editing (1 for an unsaved row). The server
   * compare-and-sets against it and 409s (numbering changed since the card was
   * opened) instead of silently overwriting a save that landed in between.
   * REQUIRED by the service (SA-287b): a save without it is a 400 asking the
   * user to reload; it stays `@IsOptional` here only so that 400 carries that
   * wording rather than the validation pipe's generic one.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  expectedNextNumber?: number;
}
