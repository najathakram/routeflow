import { registerDecorator, type ValidationOptions } from "class-validator";
import { canonicalWritableTimeZone } from "./tenant-time-zone";

/**
 * SA-738: `@IsTenantTimeZone()` is the DTO face of the ONE writable-zone predicate
 * (`canonicalWritableTimeZone`), shared with the PATCH /settings writer. class-validator's own
 * `@IsTimeZone()` is not used: it accepts offsets such as "+01:00" on Node 22+ and fixed-offset
 * aliases such as "EST".
 */
export function IsTenantTimeZone(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) =>
    registerDecorator({
      name: "isTenantTimeZone",
      target: target.constructor,
      propertyName: propertyKey as string,
      options: {
        message: "$property must be an IANA time zone such as America/Chicago",
        ...options,
      },
      validator: { validate: (value: unknown) => canonicalWritableTimeZone(value) !== null },
    });
}
