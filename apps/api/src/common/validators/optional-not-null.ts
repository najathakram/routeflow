import { ValidateIf, type ValidationOptions } from "class-validator";

/**
 * `@IsOptional()` for an OPTIONAL value that may be OMITTED but never sent as JSON `null`.
 *
 * class-validator's own `@IsOptional()` skips every other validator for `null` AND `undefined`.
 * On a money field that lets `{ "unitPrice": null }` straight past `@IsNumber()` into a service
 * whose `x !== undefined ? Number(x) : …` turns it into `Number(null) === 0` — a silent $0 price,
 * discount, fee or tax (rows 591 / 602). This decorator skips validation only for `undefined`, so a
 * present `null` is validated by the `@IsNumber()` / `@IsDecimal()` that follows and refused with
 * the usual 400.
 *
 * Use it on every optional money field. Keep plain `@IsOptional()` ONLY where `null` is a
 * deliberate "clear" (a nullable override column) — and list that field, with the reason, in the
 * allow-list of `money-dto-null.spec.ts`.
 *
 * `PartialType()` (`@nestjs/mapped-types`) re-adds `@IsOptional()` to every inherited field and so
 * re-opens the hole for an `Update*Dto`: redeclare the money field in the subclass with this
 * decorator (own metadata of the same kind replaces the inherited kind — see
 * `UpdateInvoiceDto`).
 */
export function IsOptionalNotNull(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined, validationOptions);
}
