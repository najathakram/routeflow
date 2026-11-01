import { UserRole, UserStatus } from "@prisma/client";
import type { JwtPayload } from "../../auth/jwt-payload.interface";

/**
 * A principal that holds NO price-edit rights (`roleMayEditPrice` is false for a buyer, so `priceEditAllowedFor` answers
 * without a database read). SA-1034 rule 4: `EstimatesService.create` and `RecurringInvoicesService.create/update` take a
 * REQUIRED actor; a spec that is not about price rights passes this, which behaves exactly as the old missing actor did.
 */
export const NO_PRICE_RIGHTS: JwtPayload = {
  sub: "spec-no-price-rights",
  username: "spec-no-price-rights",
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
};
