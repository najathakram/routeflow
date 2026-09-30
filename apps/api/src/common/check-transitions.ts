/**
 * API-local mirror of the check-lifecycle forward-transition table.
 *
 * The canonical copy lives in `packages/types/api/checks.ts` (`@routeflow/types`), consumed
 * directly by web (`apps/web/app/(dashboard)/invoices/[id]/page.tsx`) and mobile
 * (`apps/mobile/lib/payments-logic.ts`) — both transpile workspace TS at build time, so a value
 * import is safe there. The API keeps this local copy instead of importing `@routeflow/types`
 * because that package's entry point is raw TypeScript (`main: "./index.ts"`, no build step):
 * `nest build` does not bundle workspace deps, so a value import emits the
 * `require("@routeflow/types")` verbatim into `dist/`, and `node dist/main.js` then dies parsing
 * the .ts at startup — taking the whole API down. Same convention as
 * `apps/api/src/common/trip-grouping.ts` / `shipping.ts`.
 *
 * `check-transitions-parity.spec.ts` pins this file's `CHECK_TRANSITIONS` value-equal to
 * `packages/types/api/checks.ts`'s export, so the two can never silently drift apart.
 *
 * V1 ONLY — do not add a `CHECK_TRANSITIONS_V2` export here; see the canonical file's header
 * for why (a later PR owns V2 behind a dedicated `CheckTransitionService`).
 */
import type { CheckStatus } from "@prisma/client";

export type { CheckStatus };

/**
 * Legal FORWARD transitions for the check lifecycle: RECORDED → DEPOSITED → CLEARED (strict
 * sequence); any non-bounced state can go to BOUNCED (a deposited or even cleared check can be
 * returned by the bank). BOUNCED is terminal. Values are byte-identical to
 * `packages/types/api/checks.ts`'s `CHECK_TRANSITIONS`.
 */
export const CHECK_TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  RECORDED: ["DEPOSITED", "BOUNCED"],
  DEPOSITED: ["CLEARED", "BOUNCED"],
  CLEARED: ["BOUNCED"],
  BOUNCED: [],
};
