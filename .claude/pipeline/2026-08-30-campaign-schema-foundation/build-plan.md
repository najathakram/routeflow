# F01 · Schema foundation — build plan

**Status: EXECUTED** (single-package batch; authored inline by the campaign session — Fable —
because the whole diff is one migration plus a mechanical rename; spawning the executor for this
would be ceremony).

## P1 — the migration and its sole runtime ripple

- **satisfies:** R1 R2 R3 R4 R5 R6 · **provenBy:** T1 T2 T3
- **Files (owns exclusively):**
  - `apps/api/prisma/schema.prisma` — 8 model edits + 2 enum values (see discovery table)
  - `apps/api/prisma/migrations/20260908000000_campaign_schema_foundation/migration.sql` —
    generated via `prisma migrate diff --from-schema <base> --to-schema <new> --script`
    (local docker was unavailable; CI's replay job is the apply-from-zero validation, and the
    prod apply is owner-gated regardless)
  - `apps/api/src/import/numbering.service.ts` — 5 × `tenantId_docType` → `tenantId_docType_year`
    (`year: 0`) + `DEFAULTS.RETURN/ORDER`
  - `apps/api/src/import/numbering.service.spec.ts` — the one expectation pinning the upsert shape

## Prod apply procedure (Phase 7, BEFORE the merge — owner-gated)

1. Post `migration.sql` to board issue #514 (`team.mjs ask`), block on `answered`.
2. Fresh backup by the house method (`railway ssh --service postgres` in-container dump;
   verify line-count + trailing `PostgreSQL database dump complete`).
3. `railway run --service postgres node apps/api/scripts/prod-migrate.mjs`.
4. Then the merge window; `post-deploy-check` after deploy.

## Manual verification

(none — no UI or behavior surface; T3 tier unused in this batch)
