# F02b — build plan

**Status: APPROVED for execution** · worktree `.claude/worktrees/rf-F02b`, branch
`fix/F02b-destructive-guards` off `master 77a8c058` · executed by the dev-pipeline Workflow
(`~/.claude/skills/dev-pipeline/pipeline.js`), scale **major**. Cherry-pick `27795982` lands as
commit 1 BEFORE any package runs (P0 below).

## P0 — cherry-pick the credit-note-link hotfix (mechanical, pre-pipeline)

- **satisfies:** R0 · **provenBy:** T-B189
- `git cherry-pick 27795982`; resolve the code-map trio per convention (keep both CHANGELOG
  bullets; _meta notes will be replaced at close-out anyway); retitle its 3 describe blocks /
  4 asserts to carry `REG-B189`.

## P1 — API guards: products + routes

- **satisfies:** R1 R3 · **provenBy:** T-B24a T-B96
- **Files (owns exclusively):** `apps/api/src/products/products.service.ts` (`bulkDelete`),
  `apps/api/src/routes/routes.service.ts` (`deleteRoute` guard block only, L519–575 region),
  their spec files.
- Reuse `remove()`'s guard + soft-delete verbatim for the classification; the reference probe is
  one `count` per dependent table over `{ productId: { in } }`, grouped per id.

## P2 — customers: merge + batchDelete force

- **satisfies:** R4 R5(server) · **provenBy:** T-B101a/b/c T-B130a
- **Files (owns exclusively):** `apps/api/src/customers/customers.service.ts`
  (`mergeCustomers`, `batchDelete` signature + `deleteCustomer(id, force)` pass-through),
  `customers.controller.ts` (batch-delete DTO if a force flag is surfaced), spec file additions.
- Ordering constraint from P0: any restructuring keeps orderCreditNote-before-creditNote.

## P3 — bookkeeping tenant scoping (B188)

- **satisfies:** R7 · **provenBy:** T-B188
- **Files (owns exclusively):** `apps/api/src/bookkeeping/invoice.service.ts`,
  `invoice.processor.ts` (job data type), new `invoice.service.tenant-scope.spec.ts`.

## P4 — web surfaces (T2 tier)

- **satisfies:** R2 R5(web) R6 · **provenBy:** REG-B24 REG-B130 REG-B154 (e2e specs authored
  here, `proven-pending-deploy` until the post-merge run)
- **Files (owns exclusively):** `apps/web/app/(dashboard)/products/page.tsx` + `[id]/page.tsx`,
  `customers/page.tsx`, `orders/page.tsx` (selection-reset class), `components/AssignToSectionModal.tsx`,
  `apps/web/lib/api/customers.ts` (force flag), new `apps/web/e2e/21-destructive-guards.spec.ts`.
- Selection reset = one `useEffect` keyed on `[page, search, category/filter]` per page; reuse
  the existing ConfirmDialog component; report processed-vs-skipped in the shape vendor-bills uses.

## P5 — G1 scanner signatures

- **satisfies:** R8 · **provenBy:** T-G1 + `npm run verify` green over the whole repo
- **Files (owns exclusively):** `.claude/skills/bug-hunt/scripts/scan-signatures.mjs` (+ its
  self-test fixtures), suppression annotations at each surveyed known-good site.
- ⚠️ Each signature must land with its suppressions in the SAME commit or verify goes red
  mid-branch.

## P6 — G8 RLS + isolation specs (migration-bearing)

- **satisfies:** R9 R10 · **provenBy:** T-G8a + migration replay + in-migration assertion
- **Files (owns exclusively):** `apps/api/prisma/migrations/20260909000000_rls/migration.sql`
  (contents = `rls.sql` verbatim + trailing assertion `DO` block that RAISES on any policied
  table with `relrowsecurity = false`), new `apps/api/src/prisma/prisma-isolation.spec.ts`,
  new `scripts/rls-preflight.mjs` (read-only NULL-tenantId counter, prod-run via railway).
- **Not in this package:** applying to prod (Phase 7, owner-gated, after F01's flight clears).

## Pipeline args (assembled for the Workflow executor)

- `scale: 'major'` · `workdir: .claude/worktrees/rf-F02b` · `testPackages: [T-B189..T-G8a]` ·
  `redGate: true` · phases all ON incl. UI verify (Browser pane over the three web pages) and
  mutation probe. Money lenses not required (no pricing math here); the six major-scale lenses +
  two refuters run as standard.

## Manual verification

(none — T3 unused; every ID is T1/T2)

## Close-out checklist (Phase 6–8)

1. Ledger `F02.jsonl`: B24/B96/B101/B130/B154 → `proven` or `proven-pending-deploy` per tier;
   B188 → `proven`; **append B189 row** (`tier: T1`, proof = the REG-B189 specs); `buildPlan`
   field = this folder's build-plan.md.
2. `campaign-check --batch F02 --pipeline-dir <this folder>` green with the jest JSON artifact.
3. Code map (surgical) + CHANGELOG bullet + _meta replace + HANDOFF campaign line (`W3 …`).
4. Register: chips for the six + NEW B189 article; republish register artifact `310ae33a…`
   (guide changes → flag to owner, artifact is shared-not-owned).
5. Merge train W3 (public window): RLS pre-flight posted to #515 → owner ack → backup →
   `prod-migrate.mjs` (RLS slot) → merge → BUILDING → private → post-deploy-check +
   `data-integrity-report` delta vs the pre-F02 baseline.
