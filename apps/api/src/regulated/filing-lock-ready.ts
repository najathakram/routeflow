import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-997: the hard-off switch of the regulated filing lock. While it is false `lockFiling` (the only caller of
 * `claimFilingLock`) refuses with 409 FILING_LOCK_NOT_READY before any read or write, so no filing can reach LOCKED
 * until a sale booking into a locked period is routed to the current one (W-965). The flip is its own later diff.
 * A local literal, not an import: the API never value-imports `@routeflow/types` (see
 * `no-runtime-workspace-imports.spec.ts`); `filing-lock-ready.spec.ts` pins both copies equal.
 */
export const FILING_LOCK_READY = false;
export const FILING_LOCK_NOT_READY_MESSAGE =
  "Locking a filing isn't available yet. You can still generate, check and download it.";

export function assertFilingLockReady(): void {
  if (!FILING_LOCK_READY)
    throw new ConflictException({
      code: API_ERROR_CODES.FILING_LOCK_NOT_READY,
      message: FILING_LOCK_NOT_READY_MESSAGE,
    });
}
