import { BadRequestException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-655: the tenant's system walk-in customer owns every counter sale to an anonymous buyer. It can never
 * be deactivated, deleted or merged away (each sale would lose its customer), so every such entry point
 * refuses it with the coded 400 before writing anything. Kept out of customers.service.ts (size ratchet).
 */
export function assertNotWalkIn(customer: { isWalkIn?: boolean | null } | null | undefined): void {
  if (customer?.isWalkIn === true) {
    throw new BadRequestException({
      code: API_ERROR_CODES.WALK_IN_PROTECTED,
      message:
        "The walk-in customer is part of counter sales and cannot be deactivated or deleted.",
    });
  }
}

/**
 * The customer list and its CSV export never show the walk-in customer: it is a system row, chosen at the
 * counter by the `walkIn` flag, never from a list. `isWalkIn` is nullable and every pre-existing row is NULL,
 * so the filter is the explicit null-or-false (Prisma's `not: true` drops NULL rows) and rides in `AND`,
 * because `OR` is already the search clause's key. Mutates and returns `where`.
 */
export function excludeWalkIn<T extends { AND?: unknown }>(where: T): T {
  const and = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  where.AND = [...and, { OR: [{ isWalkIn: null }, { isWalkIn: false }] }];
  return where;
}

/**
 * The walk-in customer's sign-in email is fixed: update() refuses a CHANGED `email` (the only login-related
 * field UpdateCustomerDto carries) before any write. An unchanged value resent by the edit form passes.
 * Other fields stay editable.
 */
export function assertWalkInLoginUntouched(
  existing: { isWalkIn?: boolean | null; email?: string | null },
  dto: { email?: string | null },
): void {
  if (existing.isWalkIn !== true || dto.email === undefined) return;
  const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();
  if (norm(dto.email) !== norm(existing.email)) assertNotWalkIn(existing);
}
