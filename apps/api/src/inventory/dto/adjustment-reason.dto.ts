import {
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from "class-validator";
import { Transform } from "class-transformer";
import { AdjustmentReason } from "@prisma/client";

// The API never value-imports @routeflow/types (no-runtime-workspace-imports.spec): the reasons come
// from the Prisma enum, and the note bounds are pinned equal to the shared
// ADJUSTMENT_REASON_NOTE_MIN / _MAX by product-count.dto.spec.ts.
const ADJUSTMENT_REASON_VALUES = Object.values(AdjustmentReason);
export const ADJUSTMENT_REASON_NOTE_MIN = 3;
export const ADJUSTMENT_REASON_NOTE_MAX = 200;

/**
 * SA-804(3): the reason fields of a manual stock write (an adjustment, a product count). `reason`
 * is required; the note is optional (at most 200 characters) and REQUIRED (3-200 after trimming)
 * when the reason is OTHER.
 */
function IsReasonNote(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: "isReasonNote",
      target: target.constructor,
      propertyName,
      options: {
        message: `reasonNote must be ${ADJUSTMENT_REASON_NOTE_MIN}-${ADJUSTMENT_REASON_NOTE_MAX} characters when the reason is OTHER, and at most ${ADJUSTMENT_REASON_NOTE_MAX} otherwise`,
        ...options,
      },
      validator: {
        validate(value: unknown, args) {
          const other = (args?.object as { reason?: unknown }).reason === "OTHER";
          if (value === undefined || value === null) return !other;
          if (typeof value !== "string") return false;
          const length = value.trim().length;
          if (length > ADJUSTMENT_REASON_NOTE_MAX) return false;
          return !other || length >= ADJUSTMENT_REASON_NOTE_MIN;
        },
      },
    });
}

export abstract class AdjustmentReasonDto {
  @IsIn(ADJUSTMENT_REASON_VALUES)
  reason: AdjustmentReason;

  @ValidateIf((o: AdjustmentReasonDto) => o.reasonNote != null || o.reason === "OTHER")
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsReasonNote()
  reasonNote?: string;
}

/**
 * The legacy manual-adjustment door (`POST /inventory/movements/adjustment`): the reason is OPTIONAL
 * for now because installed mobile builds post no `reason`. An absent reason is stored null and logged
 * (would-refuse); a reason that IS sent is validated as above. Enforcing it is a separate later diff.
 */
export abstract class OptionalAdjustmentReasonDto {
  @IsOptional()
  @IsIn(ADJUSTMENT_REASON_VALUES)
  reason?: AdjustmentReason;

  @ValidateIf((o: OptionalAdjustmentReasonDto) => o.reasonNote != null || o.reason === "OTHER")
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsReasonNote()
  reasonNote?: string;
}
