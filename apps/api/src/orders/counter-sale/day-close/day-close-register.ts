import { BadRequestException } from "@nestjs/common";
import { COUNTER_DEFAULT_REGISTER, REGISTER_KEY_PATTERN } from "@routeflow/pricing";

// A register key is the till a close belongs to. One till in v1 (R20-10): the web never sends one, and every counter order reads
// as `COUNTER_DEFAULT_REGISTER`. The pattern's ONE home is @routeflow/pricing (counter-register.ts); case-sensitive, never lower-case.
export { REGISTER_KEY_PATTERN };

/** The request's optional register key, validated; absent or blank is the default register. */
export function parseRegisterKey(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return COUNTER_DEFAULT_REGISTER;
  if (typeof raw !== "string" || !REGISTER_KEY_PATTERN.test(raw)) {
    throw new BadRequestException(
      "registerKey must be 1-64 letters, digits, '_', '-' or ':' (a ':' cannot come first)",
    );
  }
  return raw;
}

/**
 * `COALESCE(order."registerKey", 'main') = :registerKey` as a Prisma `Order` filter: `Order.registerKey` has no default, so a
 * counter order created before the seam shipped (null) is on the default register.
 */
export function registerOrderWhere(registerKey: string) {
  return registerKey === COUNTER_DEFAULT_REGISTER
    ? { OR: [{ registerKey: COUNTER_DEFAULT_REGISTER }, { registerKey: null }] }
    : { registerKey };
}
