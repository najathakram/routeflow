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
module.exports = {
  UserRole: {},
  VENDOR_BILL_STATUS_VALUES: ["DRAFT", "RECEIVED", "PARTIAL", "PAID", "OVERDUE", "VOID"],
  CHECK_TRANSITIONS: {
    RECORDED: ["DEPOSITED", "BOUNCED"],
    DEPOSITED: ["CLEARED", "BOUNCED"],
    CLEARED: ["BOUNCED"],
    BOUNCED: [],
  },
};
