/**
 * B910: the one implementation lives in `@routeflow/types` (`internal-email.ts`
 * there) — this file is a re-export kept so every existing
 * `../common/internal-email` import keeps working. The web and mobile
 * counterparts (`apps/web/lib/formatting.ts`, `apps/mobile/lib/internal-email.ts`)
 * re-export the same module, so the former triple mirror can no longer drift.
 */
export { isInternalEmail } from "@routeflow/types";
