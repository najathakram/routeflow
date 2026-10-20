import {
  IsIn,
  IsString,
  ValidateIf,
  registerDecorator,
  type ValidationOptions,
} from "class-validator";
import { Transform } from "class-transformer";
import {
  ADJUSTMENT_REASON_NOTE_MAX,
  ADJUSTMENT_REASON_NOTE_MIN,
  ADJUSTMENT_REASON_VALUES,
  type AdjustmentReason,
} from "@routeflow/types";

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
