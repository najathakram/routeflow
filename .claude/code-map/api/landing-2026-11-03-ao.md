# Api landing 2026-11-03, train an (merge commit `f9f1a592ed`, range `fedb9c4fa7..f9f1a592ed`; train PR #4176, head `591729cb92`)

Paths under `apps/api/` unless they start with `apps/web/`, `apps/mobile/` or `packages/`. Two members: #4172 `9c93f2ebec` (move into `packages/*`, no behaviour change), #4174 `e51f7c53ce` (web only). **No migration**, no cron, no plan flag or addon gate, no new env var, no route. #4130 was held back (its DB spec C-6d disagreed with #4166 on the merged tree) and is not here. Web side: `web/landing-2026-11-03-ao.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4172 `9c93f2ebec` the delivery plan and the stop-key rule move to shared packages (SA-1098 PR-2a)

- Api change is one row: `common/no-hand-typed-enum-mirrors.allow.ts` loses the entry for the moved file (it no longer hand-types a server enum mirror).
- The moved code: `packages/pricing/src/delivery-plan.ts` (was `apps/mobile/lib/short-pick.ts`, verbatim; exported from `packages/pricing/src/index.ts`) and `packages/types/stop-completion-key.ts` (`newStopCompletionKey`, `keepsStopCompletionKey`, `isLockUnavailable`, `retryOnLockUnavailable`, `LOCK_RETRY_DELAYS_MS`; exported from the package root and the subpath `@routeflow/types/stop-completion-key`). Mobile keeps both paths as re-exports; `apps/mobile/jest.config.js` maps the subpath.
- Test: `packages/pricing/src/delivery-plan.spec.ts` (REFUSED at 0, DELIVERED at full, PARTIAL between; one entry per line at a multi-order stop; fails closed with no served remaining; the mobile file holds only re-exports).

## #4174

- No api source; see `web/landing-2026-11-03-ao.md`.
