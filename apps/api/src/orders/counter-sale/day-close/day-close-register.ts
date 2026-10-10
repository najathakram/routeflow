import { BadRequestException } from "@nestjs/common";
import { COUNTER_DEFAULT_REGISTER } from "../../../returns/counter-close-lock";

/**
 * A register key: the till a close belongs to. One till in v1 (R20-10): the web never sends one, and every counter order reads as
 * `COUNTER_DEFAULT_REGISTER`. The API's literal copy of `REGISTER_KEY_PATTERN` in `packages/types/api/counter-register.ts` (L-261:
 * no runtime import of that package), pinned to it by register-key-parity.spec.ts. Case-sensitive: never lower-case a key.
 */
export const REGISTER_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9:_-]{0,63}$/;

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
