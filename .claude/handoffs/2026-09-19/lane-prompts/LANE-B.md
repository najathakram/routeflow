# Lane B — backoffice, entitlements, tooling (window title: "RouteFlow Lane B")

Read `LANE-COMMON.md` first. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-B`, branches `feat/b-<step>` /
`fix/b-<step>`. Evaluation cards A1–A3 and table 3 (T2, T3, T6) plus D6. Local checkout is
stale — read billing files from your worktree, never from `C:/ClaudeCode/routeflow`.

## What already exists (do not rebuild)
`FeaturePreviewService.preview(tenantId, request)` (`apps/api/src/billing/feature-preview.service.ts`)
returns a zero-write before/after per feature key; `EntitlementAuthority.resolveAll`;
`TenantFeatureConfig` + `FeatureResolverDiff` tables; 13 platform-admin pages under
`apps/web/app/(platform-admin)/admin/`; `apps/api/scripts/lib/railway-db-url.mjs`
(`resolveDatabaseUrl`, `redactUrl`); tonight's Windows backup prototype
`C:\Users\nakram\AppData\Local\Temp\claude\C--ClaudeCode-routeflow\20f39e54-c9b5-4469-a28a-cb7ec44dff13\scratchpad\backup-prod-pgdump.mjs`
(copy it into the repo — the scratchpad is deleted at session end).

## Order of work (one PR each; est. builder-days)
0. **Affected-scope pre-push** (owner ruling 2026-09-19) — the pre-push hook on a NON-master
   branch runs `tsc`/lint/Jest only for workspaces changed vs `origin/master`
   (`turbo run check-types lint test --filter=...[origin/master]`), keeps campaign-check
   freshness and the stop-hook gates untouched, and prints "AFFECTED SCOPE: <workspaces>";
   pushes from `master` and the coordinator's `FULL_VERIFY=1` run the full chain unchanged.
   Add a spec that proves a change under `packages/pricing` still selects api + web + mobile.
   In the same PR: `npx prettier --write` on the 5 drifted files only
   (`apps/api/src/bookkeeping/dto/create-expense.dto.ts`, `apps/api/src/common/sentry-exception.filter.ts`,
   `apps/web/lib/api/batch-import.ts`, `apps/web/lib/api/payment-requests.ts`, `apps/web/lib/plan-gate.ts`)
   and a **size ratchet** spec (`apps/api/src/common/size-ratchet.spec.ts`): the 15 largest source
   files from `local-assets/handoff/2026-09-19/repo-hygiene-audit.md` §3 with their current line
   counts; the spec fails if any of them GROWS (touching one must shrink it or hold it flat).
   Land this FIRST — every later push on both machines gets faster. 0.75
1. **A1 tier-change preview UI** (B539) — in the tenant plan-change dialog: gained / lost /
   limits-changed panel from `preview()`, confirm step, "no change" state. 1.0
2. **T2 `backup-production.mjs`** — replaces the `.sh`: runs under `railway run --service
   postgres`, finds `pg_dump` (PATH, then `C:\Program Files\PostgreSQL\*\bin`), keeps the
   password off argv (PGPASSWORD), writes `backups/production_<ts>_<label>.sql`, refuses a dump
   with < 100 tables or no `_prisma_migrations` COPY block (match `COPY public._prisma_migrations`
   unquoted). Update CLAUDE.md's backup line + the session preamble. 0.5
3. **T3 e2e fixtures (B566)** — `e2e-seed.js` seeds ≥ 3 customers and a boxed product for
   `e2e-routeflow`; spec 13 fails (not skips) when the fixture is missing. 0.5
4. **A3 backoffice audit → fixes** — spawn `intent:vigil` (heuristic + WCAG audit) over the
   13 admin pages at 1440/768/390 with Playwright; file P0–P2 as NEED-ID lines; fix the P0/P1
   batch (a11y, layout, dead ends, "not user friendly" items). 3.0
5. **A2 entitlement snapshot/restore** — spec is written:
   `local-assets/handoff/2026-09-19/SPEC-entitlement-snapshot-restore.md` (read it first; it
   overrides the summary below where they differ). Then: additive migration `TenantFeatureConfigSnapshot(tenantId,
   planKey, takenAt, reason, payload jsonb)`; snapshot on downgrade, restore on re-upgrade to
   same-or-higher plan, never hard-delete; admin note "restored from snapshot of <date>".
   The OWNER applies the migration to prod before merge (hand the command to the lead). 2.5
6. **D6 / B462** — DRAFT invoices excluded from the hard credit-limit block, shown as
   "pending exposure" in the customer credit panel; unblocks check-payments PR-2. 0.5
7. **T6 `tenantId NOT NULL`** — for each tenant-owned business table (list = `local-assets/handoff/2026-09-19/d5-nullable-tenantid-models.md`: 56 SET NOT NULL now, 19 need a backfill first — do those after a read-only prod count the owner runs, 6 stay nullable; from the lead's
   D5 line; `RefreshToken` and super-admin `AuditLog` stay nullable): `ADD CONSTRAINT
   <t>_tenantId_nn CHECK ("tenantId" IS NOT NULL) NOT VALID` → `VALIDATE CONSTRAINT` →
   `ALTER COLUMN "tenantId" SET NOT NULL`, exactly that CHECK wording (PG12+ skips the scan);
   Squawk whitelist with `-- reason:`; owner applies. 1.5

Proof: Playwright 1440/768/390 for 1 and 4 (F); `local:drift` green after 5 and 7; unit
specs for 5 and 6. Post PROOF-REQ per UI PR.
8. **B569 expiry sweep** — `@LeaderCron` job that revokes `TenantFeatureOverride` rows whose `expiresAt` passed (reason `expired`), so the partial unique slot frees and the console can re-grant; spec: sweep is idempotent, never touches rows without expiresAt. 0.5
9. **B570 Node runtime drift** — two deps declare engines above the prod runtime (`@prisma/streams-local` ≥22, `@zxing/library` ≥24 vs `node:20-alpine` Dockerfiles + CI 20). Owner decides: bump Dockerfiles + CI + `engines` to Node 24 LTS (recommended, matches every dev machine) or pin the two deps. Prove with a compose image build + local:validate. 0.5
