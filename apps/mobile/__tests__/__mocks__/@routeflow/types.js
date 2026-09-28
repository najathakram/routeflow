// Stub for @routeflow/types — real module's `.ts` source can't be transformed
// through the symlinked node_modules path (ts-jest's transformIgnorePatterns
// excludes node_modules by default), so pure-logic tests that need a REAL
// runtime value (not just a type, which is erased at compile time) get it
// hand-copied here. Wave E / imp-10b, L-072: VENDOR_BILL_STATUS_VALUES must be
// kept set-equal to `packages/types/api/enums.ts`'s array — that file (pinned
// against @prisma/client by apps/api/src/common/enum-parity.spec.ts) is the
// source of truth; this copy exists only because this mock can't `require` it
// directly.
//
// X2: hand stub — pinned set-equal to the real arrays by
// apps/api/src/common/enum-parity.spec.ts (the "regression: apps/mobile's
// @routeflow/types stub stays pinned to Prisma" block `require`s THIS file by
// relative path and diffs every `*_VALUES` export against `@prisma/client`).
// That sweep only iterates keys ending in `_VALUES` — CHECK_TRANSITIONS below
// is deliberately named without that suffix so it is not swept into a parity
// diff it doesn't apply to (it isn't a Prisma enum-values array).
//
// CHECK_TRANSITIONS (post-dated check payments PR-1, 2026-09-15): a real runtime value
// `lib/payments-logic.ts`'s `checkNextStates` needs under this stub — must stay byte-identical
// to `packages/types/api/checks.ts`'s export (see that file for the V1-only rule).
// API_ERROR_CODES (#2163): must stay equal to `packages/types/api/error-codes.ts`; pinned by
// apps/api/src/common/api-error-codes-parity.spec.ts, which `require`s THIS file.
module.exports = {
  UserRole: {},
  VENDOR_BILL_STATUS_VALUES: ["DRAFT", "RECEIVED", "PARTIAL", "PAID", "OVERDUE", "VOID"],
  PURCHASE_ORDER_STATUS_VALUES: ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"],
  API_ERROR_CODES: {
    ADDON_GATE: "ADDON_GATE",
    MAILBOX_CONNECT_SECRET_MISMATCH: "mailbox_connect_secret_mismatch",
    MAILBOX_CONFIRM_IDENTITY_MISMATCH: "mailbox_confirm_identity_mismatch",
    UNLINKED_ITEMS: "UNLINKED_ITEMS",
    PACK_SIZE_UNKNOWN: "PACK_SIZE_UNKNOWN",
    DUPLICATE_VENDOR_BILL: "DUPLICATE_VENDOR_BILL",
    CLEANUP_IMPORTED_DISABLED: "CLEANUP_IMPORTED_DISABLED",
  },
  CHECK_TRANSITIONS: {
    RECORDED: ["DEPOSITED", "BOUNCED"],
    DEPOSITED: ["CLEARED", "BOUNCED"],
    CLEARED: ["BOUNCED"],
    BOUNCED: [],
  },
};
