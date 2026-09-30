// Post-dated check payments PR-1 (2026-09-15) — the ONE canonical export of the check-lifecycle
// forward-transition table.
//
// Until this file, the SAME table was hand-written three times: apps/api/src/invoices/
// invoices.service.ts (a local `CHECK_TRANSITIONS` const), apps/web/app/(dashboard)/invoices/
// [id]/page.tsx (an identical local const, "so the dropdown greys out illegal jumps"), and
// apps/mobile/lib/payments-logic.ts (an identical local const + a local `CheckStatus` type) —
// three independent hand-maintained copies of the exact same values, the drift risk this file
// removes. All three now import from here instead.
//
// V1 ONLY — a deliberate, pure de-duplication. An independent Opus review of the design was
// explicit: PR-1 exports ONLY the current V1 table (byte-identical to the three mirrors above)
// — do NOT add a `CHECK_TRANSITIONS_V2` export here. A future PR introduces V2 (reverse
// transitions) behind a dedicated `CheckTransitionService`; shipping V2 — or wiring web/mobile
// to a V2 shape — now would let a client offer a transition (e.g. a reverse move) the API
// doesn't support yet and would 400.
//
// Re-uses the existing `CheckStatus` type from `./enums` (`CHECK_STATUS_VALUES`) rather than
// redeclaring it — one source for the four values, not two.
import type { CheckStatus } from "./enums";

export type { CheckStatus };

/**
 * Legal FORWARD transitions for the check lifecycle: RECORDED → DEPOSITED → CLEARED (strict
 * sequence); any non-bounced state can go to BOUNCED (a deposited or even cleared check can be
 * returned by the bank). BOUNCED is terminal. Values are byte-identical to the three mirrors
 * this file replaces — this PR only de-duplicates, it never changes the map.
 */
export const CHECK_TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  RECORDED: ["DEPOSITED", "BOUNCED"],
  DEPOSITED: ["CLEARED", "BOUNCED"],
  CLEARED: ["BOUNCED"],
  BOUNCED: [],
};
