import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-832 row 453: the coded 409 for a tenant a payment may not reinstate ({@link paymentReinstatable} is false):
 * `subscribe()` and checkout creation refuse with it, so the platform never takes money it will not honour.
 * Fixed copy that names no cause - a customer is never told who locked the workspace, and the web shows its own
 * fixed sentence for the code (`genericToastCopy`).
 */
export function adminLockedRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.TENANT_ADMIN_LOCKED,
    message: "This workspace is locked and can't take a payment right now. Please contact support.",
  });
}
