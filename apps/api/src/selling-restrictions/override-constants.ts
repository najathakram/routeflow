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

/** The staff-only line note label. */
export const RESTRICTION_OVERRIDE_LABEL = "Sold despite restriction";

/**
 * Ruling #2093 (2026-10-13): a historical invoice import is exempt, never refused. Its breached lines carry this fixed
 * reason, the importing user and the rules matched at import, plus an audit row (no new column).
 */
export const RESTRICTION_OVERRIDE_IMPORTED_REASON = "Imported (historical)";

/**
 * The two codes the override protocol sends, named once for its throw sites (restriction-warning.ts, brief 2): a staff
 * write that needs an acknowledged reason (409) and a reason outside the bounds (400).
 */
export const RESTRICTION_OVERRIDE_CODES = {
  warning: API_ERROR_CODES.RESTRICTION_WARNING,
  reasonInvalid: API_ERROR_CODES.RESTRICTION_OVERRIDE_REASON_INVALID,
} as const;
