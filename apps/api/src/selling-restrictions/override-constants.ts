import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Row 510: API literal mirrors of the shared restriction-override constants in packages/types/api/restrictions.ts.
 * The API never value-imports @routeflow/types at runtime (L-261), so restrictions-mirrors.parity.spec.ts pins each
 * of these equal to the shared one. Edit BOTH or the spec goes red.
 */

/** Reason length bounds, applied AFTER trim; outside them the write is a 400 RESTRICTION_OVERRIDE_REASON_INVALID. */
export const RESTRICTION_OVERRIDE_REASON_MIN = 3;
export const RESTRICTION_OVERRIDE_REASON_MAX = 200;

/** The `message` of the 409 SELLING_RESTRICTED a DRIVER (who may not override) gets on a staff write. */
export const DRIVER_RESTRICTION_BLOCK_MESSAGE = "Ask the office to approve this sale";

/** The `message` of the 409 SELLING_RESTRICTED a support session gets (it can't override): the account admin decides. */
export const SUPPORT_SESSION_RESTRICTION_BLOCK_MESSAGE = "Ask the account admin";

/** The staff-only line note label. */
export const RESTRICTION_OVERRIDE_LABEL = "Sold despite restriction";

/**
 * Ruling #2093 (2026-10-13): a historical invoice import is exempt, never refused. Its breached lines carry this fixed
 * reason, the importing user and the rules matched at import, plus an audit row (no new column).
 */
export const RESTRICTION_OVERRIDE_IMPORTED_REASON = "Imported (historical)";

/** Row 672 (SA-844): the remedies an unresolved-state INDETERMINATE line can name (`RestrictionRemedy`). */
export const RESTRICTION_REMEDIES = ["ADD_CUSTOMER_STATE", "ADD_STORE_STATE"] as const;

/** Row 672: a buyer's checkout refusal when every refused line waits on the buyer's own delivery state. */
export const PORTAL_NEEDS_STATE_MESSAGE =
  "We need your delivery state before we can sell this item. Add it in your account.";

/**
 * The two codes the override protocol sends, named once for its throw sites (restriction-warning.ts, brief 2): a staff
 * write that needs an acknowledged reason (409) and a reason outside the bounds (400).
 */
export const RESTRICTION_OVERRIDE_CODES = {
  warning: API_ERROR_CODES.RESTRICTION_WARNING,
  reasonInvalid: API_ERROR_CODES.RESTRICTION_OVERRIDE_REASON_INVALID,
} as const;
