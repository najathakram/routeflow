import type { ApiErrorCode } from "@routeflow/types";

/**
 * Machine-readable error codes that web and mobile branch on (#2163). The shared source is
 * `packages/types/api/error-codes.ts` (`API_ERROR_CODES`), which the clients import.
 *
 * Literals on purpose: API source never imports `@routeflow/types` at runtime (its dist would
 * load that package's TypeScript source through node), only `import type`. Two pins keep this
 * copy from drifting:
 *   - `satisfies Record<string, ApiErrorCode>`: a value that is not in the shared list fails to
 *     compile;
 *   - `api-error-codes-parity.spec.ts`: this object equals the shared one (same keys, same
 *     values), and no throw site or client file spells a code as a bare literal.
 */
export const API_ERROR_CODES = {
  ADDON_GATE: "ADDON_GATE",
  MAILBOX_CONNECT_SECRET_MISMATCH: "mailbox_connect_secret_mismatch",
  MAILBOX_CONFIRM_IDENTITY_MISMATCH: "mailbox_confirm_identity_mismatch",
  UNLINKED_ITEMS: "UNLINKED_ITEMS",
  PACK_SIZE_UNKNOWN: "PACK_SIZE_UNKNOWN",
  DUPLICATE_VENDOR_BILL: "DUPLICATE_VENDOR_BILL",
  CLEANUP_IMPORTED_DISABLED: "CLEANUP_IMPORTED_DISABLED",
} as const satisfies Record<string, ApiErrorCode>;
