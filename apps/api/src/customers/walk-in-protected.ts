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
