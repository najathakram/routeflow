import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B1406 / SA-1304 A5: `subscribe()` never enters a year. It commits the plan and the period with no
 * charge, and it writes the MONTHLY price as the snapshot, so it has no correct use for ANNUAL.
 * Unconditional: no tenant, plan, trial or card state, and no yearly switch, changes the answer, and an
 * existing yearly row is refused too (staff change a yearly plan). A year is entered only by Checkout
 * or the period-end switch, which charge for it.
 */
export function assertSubscribeNotAnnual(cycle: string | null | undefined): void {
  if (cycle === "ANNUAL") {
    throw new ConflictException({
      code: API_ERROR_CODES.CHECKOUT_ANNUAL_NOT_SUPPORTED,
      message: "Annual checkout is not available. Subscriptions are billed monthly.",
    });
  }
}
