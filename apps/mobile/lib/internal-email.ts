/**
 * B910: the one implementation lives in `@routeflow/types` (`internal-email.ts`
 * there) — this file is a re-export kept so every existing `lib/internal-email`
 * import keeps working. Web re-exports the same module. The api keeps a LOCAL copy
 * (runtime source cannot value-import this package) pinned functionally equal by
 * `apps/api/src/common/internal-email.spec.ts`. The SUBPATH import matters:
 * mobile's jest stubs the types package ROOT (its index pulls the whole DTO
 * surface), and the subpath resolves to source past that stub (jest.config.js).
 */
export { displayEmail, isInternalEmail, NO_EMAIL_COPY } from "@routeflow/types/internal-email";
