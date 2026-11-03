# Api landing 2026-11-03, train ak (merge commit `d833210811` via #4163, range `9dfd480c30..d833210811`; train PR #4163, head `832a7f8489`)

Paths under `apps/api/` unless they start with `apps/web/`. Three members: #4153 `4b88eb717d` (web only), #4158 `f65657e48c` (web only), #4159 `344ff8c04c` (api + web). **No migration**, no cron, no plan flag or addon gate, no new env var, no route. Web side: `web/landing-2026-11-03-ak.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4159 `344ff8c04c` F13: the effective-features answer carries the override's kind, reason and end date (SA-963 W-901 slice a, A-1)

Rule: the real `/features/effective` answer names the override behind a verdict. Before, it carried none of it, so on a live tenant the console chips fell back to "Set for this business".

- `billing/feature-override.service.ts`: `activeRows` also selects `kind` and `reason`; `rowAt` is the one rule (an expired row never supplies a date); `effectAt` is `rowAt(...)?.effect`; new `activeDetail(tenantId)` returns `Map<key, {kind, reason, expiresAt}>` from the same cached read, with the same fail-open as `allActive`.
- `billing/feature-resolver.service.ts`: `ResolveContext.overrideDetail` (optional), spread on the two override returns of `resolveOneKey`; the `overrides` verdict map is unchanged.
- `billing/feature-preview.service.ts`: `before` carries the stored detail; `after` replaces each requested key by the request's kind, reason and end date (no end date gives `null`, never the stored one).
- Tests: `feature-override-detail.sa963.spec.ts`, `feature-override-detail.sa963.db.spec.ts` (DB lane), `tenants/tenants.controller.features-no-detail.sa963.spec.ts`; fixtures in `billing/feature-fixtures.ts`.

## #4153, #4158

- No api source; see `web/landing-2026-11-03-ak.md`.
