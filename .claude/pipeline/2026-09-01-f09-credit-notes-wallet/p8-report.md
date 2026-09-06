# F09 · P8 report (Sonnet, 2026-09-06) — ledger + records + code map + lesson

Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09`, branch `fix/F09-credit-notes-wallet`,
started at HEAD `179dd400` (merge of origin/master `a94f9428`). Executed `p8-plan.md` steps 1-4
with the two overriding facts from the task brief (L-081/nextId 82, B214 filed before the
`deleteInvoice` map clause was written). No `bugs.mjs prove/discharge/move/tier/reopen` was run;
no push/stash/reset/checkout/rebase; no npm ci/install/Docker/turbo/Jest.

## 1. New bug filed

**B214** — "Deleting an invoice (or its order) leaves the credit notes it sourced fully spendable
with no provenance" · `apps/api/src/invoices/invoices.service.ts#deleteInvoice` · severity high ·
state `uncampaigned` (no batch yet — flagged in the record for `@tech-lead`/`--batch F##`). Files:
`apps/api/src/invoices/invoices.service.ts apps/api/src/orders/orders.service.ts
apps/api/prisma/schema/finance.prisma`. This is the sibling the F09 P3 fix deliberately did not
close (void caps/voids sourced credit notes; delete only unlinks them at full value) — lens A4 /
sweep row D1 in `review-lens-a-api.md`.

## 2. Lesson register — L-081 minted, L-045 archived

- **L-081** (domain, 2026-09-06) appended verbatim from `lesson-L-081.md` at the top of
  `LESSONS.md`'s `## domain` section: "gate a money write inside the primitive that performs it,
  on the row it just read ... keep every status set in one named module with the reason each
  differs written beside it." Guard: REG-B67 T1/T2/T5 + REG-B66 T6/T7/T9-T11 in
  `credit-notes.wallet-integrity.spec.ts`, `invoices/invoice-status-sets.ts`.
- **Archived: L-045** (domain, 2026-09-02, "release the stale `routeRunStopId` pointer on every
  terminal transition") — the oldest active entry whose Guard names a landed automated artifact
  (`REG-B129`/`REG-B211` regression tests + F11 mutation probes) rather than judgment/none/runbook,
  skipping L-044 (security, do-not-touch per the task brief). Moved verbatim into `ARCHIVE.md`
  under a new dated section `## Archived 2026-09-06 — headroom for L-081 (F09 P8 bookkeeping
follow-up)` with a one-line rationale, matching this file's existing per-compaction-event
  convention (e.g. the 2026-09-06 L-079 archival immediately above it). Its one cross-reference
  (`[[L-045]]` inside L-046's Guard, `LESSONS.md:497`) stays valid — archiving keeps a reference
  resolvable; only renumbering would break it.
- `_meta.json`: `nextId: 82`, `activeCount: 40`, `archivedCount: 36` (master's 35 + 1),
  `updatedAt` bumped, `note` rewritten to name both the mint and the archival.
- **Gate:** `node scripts/validate-lessons.mjs` → exit 0. Binding line:
  `✔ .claude/lessons: register is self-consistent. 40/40 entries · 39.8/40.0 KB · archived 36 ·
nextId 82 (max L-081) · binding: size (~0 more entries at 0.99 KB each)` — no second archival was
  needed (the file landed under the 40.0 KB cap on the first pass).

## 3. Code-map entries added/updated (surgical, not a regen)

All claims below were checked against the actual source on this branch (grep/read), not just the
plan text — see "notes" for the two spots where the code differs from the plan's wording.

- `.claude/code-map/api.md`
  - `credit-notes/` — fixed the stale controller/service action lists (`issue` deleted, F09/B18);
    added a new "F09 (2026-09-06)" bullet describing the `CREDIT_SETTLE_EXCLUDED` money-write gate,
    `create()`'s `CREDIT_SOURCE_EXCLUDED` refusal (DRAFT allowed on purpose), `findAll`'s invoice
    include (B19), and the `applyToInvoice` re-point, citing lesson L-081.
  - Extended the existing F09/B66 `voidInvoiceInTx` capping sentence with lens A5 (`voidInvoice`'s
    tx now runs `{ isolationLevel: "Serializable", timeout: 15_000 }`, matching the orders-side
    void caller).
  - `invoices/` — added a bullet for the new `invoice-status-sets.ts` file (all four exclude-lists
    - why each differs) and a `deleteInvoice` bullet naming **B214** as the filed-not-fixed
      sibling door.
  - `returns/` — extended the `processRefund` bullet with lens A2 (live-source invoice select via
    `CREDIT_SOURCE_EXCLUDED`); named the actual test location, `returns-refund.spec.ts` (the
    plan's step 1 text said `returns.service.spec.ts` — the code and `fix-round-3-report.md` both
    show the test landed in `returns-refund.spec.ts`, so the map follows the code).
  - `customers/` — added a one-line A6 note (the advance-wallet guard's hand-typed literal
    re-pointed at `CREDIT_NOT_APPLICABLE`).
  - `CHANGELOG.md` — one dated bullet at the top summarizing the whole batch; `_meta.json`:
    `mappedSha: 179dd400` (HEAD at write time), `generatedAt` now, `notes` replaced with the same
    bullet (no history accumulated).
- `.claude/code-map/web.md`
  - `credit-notes.ts` hooks-table row: `useIssueCreditNote` removed, `CreditNoteStatus`
    re-export from `@routeflow/types` + `CreditNote.invoice?` noted.
  - `customers.ts` hooks-table row: `useApplyAdvancePayment` deletion + B13 disposition noted.
  - Credit-notes page bullet: DRAFT/Issue UI removal + invoice-number rendering (B19) appended.
  - New bullet at the end of the file for `e2e/28-credit-note-wallet.spec.ts` + the
    `credit-note-wallet` Playwright project (REG-B19 T13, REG-B18 T14, `#main-content` heading
    scoping).
- `.claude/code-map/mobile.md`
  - Credit Notes row: `useIssueCreditNote` removed from the hook list; added a clause for the
    `CreditNoteStatus` import switch, `creditNotePillFor`'s DRAFT case / `canIssueCreditNote`
    removal (confirmed by reading `credit-notes-logic.ts` — `creditNoteActionFlags` now returns
    only `{canApply, canVoid}`, no `canIssue` field at all), the test-file trim, and that
    `new.tsx`'s own `DRAFT` is the unrelated invoice-status pill.

## 4. Gate outputs

- `node scripts/validate-lessons.mjs` → exit 0 (binding line quoted in §2).
- `node scripts/campaign/bugs.mjs self-test 2>&1 | tail -3`:
  ```
    ok   campaign-check: the raw stack is hidden by default (no 'at ...' frame)
    ok   campaign-check: CAMPAIGN_CHECK_DEBUG=1 surfaces the real stack instead

  self-test: all checks passed
  ```
- `npx prettier --write` then `--check` on every touched `.md`/`.json` (11 files; `bugs.jsonl` is
  JSONL, not JSON, and prettier has no parser for it — left untouched, correctly): `--write`
  reformatted `api.md` (5 of its bullets — the ones this session edited; a stray
  `*different*` → `_different_` emphasis-marker normalization inside the new A5 sentence, no
  content change) and `B214.md` (freshly written by `bugs.mjs file`, not yet Prettier-formatted);
  every other file reported `(unchanged)`. `--check` afterward: "All matched files use Prettier
  code style!"
- `git status --porcelain` (before staging/commit):
  ```
   M .claude/campaign/bugs.jsonl
   M .claude/campaign/bugs/B13.md
   M .claude/campaign/bugs/B185.md
   M .claude/code-map/CHANGELOG.md
   M .claude/code-map/_meta.json
   M .claude/code-map/api.md
   M .claude/code-map/mobile.md
   M .claude/code-map/web.md
   M .claude/lessons/ARCHIVE.md
   M .claude/lessons/LESSONS.md
   M .claude/lessons/_meta.json
  ?? .claude/campaign/bugs/B214.md
  ```
  `B13.md`/`B185.md` are `bugs.mjs file`'s own side effect (the command's ledger-wide refresh pass
  touched B13's history/state and appended a `commit` history line to B185 reconciled from git log
  since the merge) — not manual edits. Exactly the intended `.claude/` files; nothing under
  `apps/`, `packages/`, or `scripts/` touched.

## 5. Registry records (quoted)

`node scripts/campaign/bugs.mjs note B13 ... --section "Root cause"` → `B13: wrote "Root cause".`
`node scripts/campaign/bugs.mjs file ...` → `filed B214 — Deleting an invoice (or its order)
leaves the credit notes it sourced fully spendable with no provenance` (severity high, carve-out:
money — plan-only, no unattended fix; unbatched, flagged for `@tech-lead`/`--batch F##`).
`node scripts/campaign/bugs.mjs sync` → `sync: recorded 0 new event(s).`

`show B13` (Root cause section, as written):

> Refuted as a bug (F09 S2 refutation + S3 ruling, 2026-09-05): no web affordance for applying a
> customer advance ever existed - git log -S shows useApplyAdvanceToInvoice added once and never
> called; R11 is a FEATURE deferred to dev-pipeline; the duplicate useApplyAdvancePayment hook was
> deleted (R12). Ledger row stays queued pending the owner's feature decision.

`show B214` (full record): id B214, title "Deleting an invoice (or its order) leaves the credit
notes it sourced fully spendable with no provenance", location
`apps/api/src/invoices/invoices.service.ts#deleteInvoice`, severity high, state `uncampaigned`,
sensitive (money); Reported evidence section carries the `--symptom` text verbatim; History: `2026-
09-06 · filed · filed directly via bugs.mjs file`.

## 6. Commit

**Committed.** Sha `afcee3a1` (`afcee3a186084b10350526d045ebef9c29f6779b`) on
`fix/F09-credit-notes-wallet`, on top of `179dd400`. 13 files changed, 288 insertions(+),
33 deletions(-) — the 11 modified `.claude/` files plus the new `.claude/campaign/bugs/B214.md`
and this report. The pre-commit hook's lint-staged (`prettier --write`) ran clean; `git status
--porcelain` is empty post-commit.
