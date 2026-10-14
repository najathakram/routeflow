/**
 * Shared @Transform helpers for tolerant optional DTO fields. The global
 * ValidationPipe runs with `transform: true`, so these execute before the
 * validators — turning the "" an HTML form naturally produces into "absent"
 * instead of a 400 (`@IsUUID`/`@IsDecimal` both reject empty strings, and
 * @IsOptional only skips undefined/null).
 */

/** "" / null → undefined (treat as absent). */
export const emptyToUndefined = ({ value }: { value: unknown }) =>
  value == null || (typeof value === "string" && value.trim() === "") ? undefined : value;

/**
 * null → null (an explicit clear), "" → absent. For a pointer whose clients send `null` ONLY to clear it (the web
 * Unlink button, "Variant of: None") while an empty form field must stay "no change" (audit 2026-10-14: with
 * `emptyToUndefined` an unlink returned 200 and changed nothing).
 */
export const nullClearsEmptyAbsent = ({ value }: { value: unknown }) =>
  value === null ? null : emptyToUndefined({ value });

/**
 * "" / null → null (treat an empty selection as an explicit clear, not absent).
 * Use for optional FK pointers a form must be able to CLEAR (e.g. removing a
 * product's regulated section/subcategory) — `null` reaches Prisma as a real
 * "set column to null", whereas `emptyToUndefined` would leave it unchanged.
 * `@IsOptional` still skips `@IsUUID` for null, so a valid UUID or null both pass.
 */
export const emptyToNull = ({ value }: { value: unknown }) =>
  value == null || (typeof value === "string" && value.trim() === "") ? null : value;

/**
 * Optional decimal-string fields: "" / null → absent; finite numbers are
 * coerced to their string form so clients may send 12.5 or "12.5"
 * interchangeably. Anything else passes through for @IsDecimal to reject.
 */
export const toOptionalDecimalString = ({ value }: { value: unknown }) =>
  value == null || (typeof value === "string" && value.trim() === "")
    ? undefined
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : value;
