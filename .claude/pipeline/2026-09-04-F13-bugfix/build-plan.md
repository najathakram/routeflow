# Build plan: F13 close-out — B106 CAS rollback, retry-hint fix, controller-binding pins

> **Stage S5 — "how".** Authored by Fable 5 on 2026-09-04.
> Status: `DRAFT`
> Mode: `bugfix`. Inputs: [cause-brief.md](./cause-brief.md) (S1 evidence),
> [refutation.md](./refutation.md) (S2 adversarial refutation), [cause-ruling.md](./cause-ruling.md)
> (S3 ruling, `R#`-equivalent design), [bug-test-plan.md](./bug-test-plan.md) (`T#`). Bug-pipeline
> runs carry no `discovery.md`/`spec.md`/`ux-spec.md` — `cause-ruling.md` is this run's spec.
> This file is the ONLY context the implementation and review agents receive. It must stand alone.
>
> **All file:line anchors below have been re-anchored against
> `428046772195178cd694109e37d437f9097a8b14`** (`42804677`, this worktree's committed HEAD —
> the master merge has landed, `f60bd27c` merged into `fix/F13-recurring-standing-v2`,
> superseding the pre-merge snapshot `9e5ce526`) — confirmed 2026-09-04 against the merged tree;
> none shifted except where noted inline.

**Gate to pass before S6:** every work package declares `satisfies:` (the `cause-ruling.md` §2 item
it implements) and `provenBy:` (`T#`s). A package proven by nothing is unverifiable.

---

## Objective

Close out F13 (batch B09/B46/B48/B92/B106) from its already-committed v1 snapshot. Four of five
causes are confirmed with `fixes-the-cause` fixes already in the tree (B46, B48, B09, B92) — this
run does not touch their code, only adds two binding pins that would fail if a controller reverted.
B106's fix is `partial`: the outcome-recording half is correct, but the create-failure rollback is
an unconditional plain `update` where the claim it undoes is a compare-and-set, opening a
double-bill race (`cause-ruling.md`'s adopted six-step interleaving), and the provisional `FAILED`
state the claim stamps is operator-visible with a misleading retry invitation during a run that may
still succeed. This run makes the rollback a CAS against the value the claim wrote, and makes the
provisional state read as informational rather than retryable, then closes out the batch's
bookkeeping (registry, code map, lessons, CHANGELOG).

**In scope:** the B106 rollback CAS (`recurring-invoices.service.ts`), the web retry-hint fix
(`apps/web/lib/api/invoices.ts`, `.../recurring/page.tsx`), the B46 T7 date-freeze, two new
controller-binding pins (REG-B92 T34, REG-B09 T35), the two stale `OrdersService` test-double
repairs, the spec-30 e2e comment correction, and F13 close-out bookkeeping.

**Explicitly out of scope (scope fence):** re-implementing or re-testing B46/B48/B09/B92's already
`fixes-the-cause` production code; the sibling hits (`invoices.controller.ts:156`'s `Partial<>`
body, the 13 lock-free `@Cron` sites, `estimates.service.ts` pricing, the item-route role asymmetry
on order-templates) — filed to the owner per `cause-ruling.md`, not built here; any data repair
(none is warranted — see `cause-ruling.md` §6); mobile UI changes for B106 (accepted asymmetry, no
retry button exists there to mis-invite with).

---

## Constraints & conventions

- **Stack / framework:** NestJS 11 + Prisma 7 (API), Next.js 14 App Router (web), Jest for both.
- **Test runner and layout:** Jest, `*.spec.ts` (api), `*.test.ts`/`*.test.tsx` (web/mobile).
  New/edited spec files stay beside their subject, matching existing siblings in the same
  directory (see files named below).
- **Lint / format rules that will fail the gate:** repo ESLint flat config per workspace +
  Prettier (semicolons, double quotes, printWidth 100, trailing commas) — run via
  `formatCommand` below, never a bare root `eslint`.
- **Existing patterns to copy rather than invent:**
  `apps/api/src/order-templates/order-templates.controller.roles.spec.ts` (the
  `Reflect`/`Reflector` metadata-pin idiom for REG-B09 T35); the claim `updateMany` shape at
  `recurring-invoices.service.ts:224-232` (the CAS this run's rollback must mirror).
- **Design system source:** N/A — the only UI change is copy/CTA-styling on an existing pill, no
  new tokens.
- **Must NOT change:** the claim CAS (W1); the unfinalized (billed-but-unlinked) path; the SUCCESS
  write; the cron loop structure; `runNow`; `RUN_INTERRUPTED_ERROR`/`RUN_UNFINALIZED_ERROR`/
  `RUN_UNFINALIZED_PREFIX` text (coupled by a `startsWith` check); any B46/B48/B09/B92 production
  code; `lastRunAt` write behavior on the failure path.
- **Do-not-introduce list (repo-wide):** Vitest, Biome, Supabase, Vercel, a second HTTP client, a
  root-level test runner or root ESLint config.
- **Landmines:** `prisma-mock.ts`'s default `updateMany` resolves `{count: 0}` — every test
  touching the claim or the rollback must set the resolved value explicitly and per-call (see
  `bug-test-plan.md` harness notes); `tenantTransaction` in the mock shares spies with the
  top-level `models` object — do not assume a distinct tx client; the recurring/web e2e spec
  (`30-recurring-standing.spec.ts`) has a real cross-test dependency (`sharedTemplateId`) that
  relies on `playwright.config.ts`'s `fullyParallel: false` — this run touches only its header/
  `finally` comment, never its ordering or fixtures.

---

## Test packages

### TP-API — API jest: rollback CAS, controller-binding pins, harness repair

- **writes:**
  `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` (edit — T17
  rewrite, T17c new, T7 date-freeze),
  `apps/api/src/recurring-invoices/recurring-invoices.controller.spec.ts` (new — T34),
  `apps/api/src/order-templates/order-templates.controller.roles.spec.ts` (edit — T35),
  `apps/api/src/order-templates/order-templates.service.spec.ts` (edit — harness repair only, no
  new test ids)
- **tests:** T17, T17c, T7, T34, T35
- **brief:** T17 asserts the rollback calls `recurringInvoice.updateMany` (not `.update`) with
  `where: {id, nextRunAt: <advanced value the claim wrote>}` and `data.nextRunAt: <pre-claim
value>`; T17c asserts a `{count:0}` rollback result writes nothing further to the row and still
  rethrows; T7 rewrites the existing "claim is strictly future" assertion with a frozen clock; T34
  is a new controller spec asserting `design:paramtypes` on `RecurringInvoicesController.update`
  is `UpdateRecurringInvoiceDto`; T35 is the same pin added to the existing
  `OrderTemplatesController` roles spec for `UpdateOrderTemplateDto`. The harness repair widens the
  two one-method `OrdersService` doubles (`:238`, `:452` — re-anchored from `~:186`/`~:400` at
  `9e5ce526`) to the same four methods every other
  suite in this batch carries — no assertions change, this only prevents a future `is not a
function` failure with no test pointing at the cause. Exact expected values restated from
  `bug-test-plan.md` — the agent does not invent them.
- **must fail with:** T17 — `expected updateMany to have been called, received: 0 calls` (only
  `.update` was called); T17c — the rollback `updateMany` mock cannot even be configured to return
  `{count:0}` in a meaningful way because no `updateMany` call exists on this path today, so the
  assertion "no further write follows a lost CAS" fails on its precondition; T36 (web, see TP-WEB)
  is the sibling to check alongside T17/T17c in the red gate. T7/T34/T35 are pins and are NOT part
  of the red gate (they pass today; see `bug-test-plan.md`).

### TP-WEB — web jest: retry-hint fix

- **writes:** `apps/web/lib/api/invoices.test.ts` (new)
- **tests:** T36
- **brief:** asserts `isRetryableRunFailure(RUN_INTERRUPTED_ERROR)` is `false`, a terminal
  create-failure message string is `true`, and `null`/`undefined` stay `false` (pin).
- **must fail with:** `expected false, received true` for `isRetryableRunFailure(RUN_INTERRUPTED_ERROR)`.

**Red gate command** _(runs only these new/rewritten tests; every REG-tagged one must fail on an
assertion, none may pass)_:

```bash
cd apps/api && npx jest src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts -t "REG-B106 T17" --runInBand
cd apps/web && npx jest invoices.test -t "REG-B106"
```

---

## Work packages

### WP-API-B106 — CAS rollback

- **files:** `apps/api/src/recurring-invoices/recurring-invoices.service.ts`
- **satisfies:** cause-ruling.md §2 "B106-a — CAS rollback"
- **provenBy:** T17, T17c
- **dependsOn:** none
- **effort:** `high` (money/tenancy-adjacent — schedule and billing-cycle correctness)
- **brief:** Replace the plain `update` in the create-failure catch block
  (`recurring-invoices.service.ts:263-268`, confirmed unchanged at `42804677`) with a
  compare-and-set `updateMany` keyed on the `nextRunAt` value the claim (`:224-232`) itself wrote.
  On `{count:0}`, log a `warn` naming both the pre-claim and advanced values and write **nothing**
  further to the row. Always rethrow the original error, whichever branch is taken. Do not touch
  the claim, the unfinalized/link/SUCCESS block, or `lastRunAt` behavior on this path.
- **exact code:**

```ts
} catch (err) {
  // REG-B106: give the cycle back, but ONLY if nobody newer has already claimed it. The
  // claim above (W1) is a CAS against the pre-claim ri.nextRunAt; this rollback must be a
  // CAS against the value the claim just wrote (`nextRunAt`), or restoring unconditionally
  // clobbers a newer claimant's own advance and lets the template fire again for a cycle
  // that newer run may already have billed (see cause-ruling.md's B106 race finding).
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const rolledBack = await this.prisma
    .forTenant()
    .recurringInvoice.updateMany({
      where: { id: ri.id, nextRunAt },
      data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
    })
    .catch((e: any) => {
      this.logger.error(
        `Recurring invoice ${ri.id} rollback could not be recorded (${e?.message ?? e})`,
      );
      return { count: -1 };
    });
  if (rolledBack.count === 0) {
    this.logger.warn(
      `Recurring invoice ${ri.id} rollback skipped: a newer run already moved nextRunAt ` +
        `past this run's claimed value (${nextRunAt.toISOString()}); pre-claim value was ` +
        `${ri.nextRunAt.toISOString()}. Nothing written; the newer run's outcome stands.`,
    );
  }
  throw err;
}
```

`nextRunAt` is the same in-scope variable the claim's own `updateMany` call used
(`recurring-invoices.service.ts:224-232`) — do not recompute it. `rolledBack.count === -1` (the
`.catch` fallback for a DB fault mid-rollback) is deliberately treated the same as a normal
attempt for logging purposes but is NOT logged as a "skipped, newer run" warning — only `0`
triggers that specific message, since `-1` means the write itself failed, not that it lost a CAS.

### WP-WEB-B106 — retry-hint fix

- **files:** `apps/web/lib/api/invoices.ts`, `apps/web/app/(dashboard)/invoices/recurring/page.tsx`
- **satisfies:** cause-ruling.md §2 "B106-b — no retry invitation during a healthy run"
- **provenBy:** T36
- **dependsOn:** none
- **brief:** In `invoices.ts`, change `isRetryableRunFailure` (`:785`, next to
  `RUN_UNFINALIZED_PREFIX` at `:782`; confirmed at `42804677`) so it
  returns `true` only for a terminal create-failure message — i.e. it must return `false` for both
  `RUN_INTERRUPTED_ERROR` (imported/exported alongside `RUN_UNFINALIZED_PREFIX`) and any message
  starting with `RUN_UNFINALIZED_PREFIX` (unchanged behavior for the latter). In
  `recurring/page.tsx` (the pill/hint region at `:184-193`, confirmed at `42804677`), branch the rendered copy
  three ways: SUCCESS → unchanged green pill; a terminal FAILED (`isRetryableRunFailure(lastError)`
  true) → unchanged red pill + existing "use Run Now to retry" hint; a provisional FAILED whose
  `lastError` is exactly `RUN_INTERRUPTED_ERROR` → informational copy, no CTA styling: "Generation
  in progress or interrupted — if no invoice appears by the next cycle, use Run Now." Do not touch
  `RUN_UNFINALIZED_ERROR`/`RUN_UNFINALIZED_PREFIX` text or the mobile mirror
  (`apps/mobile/lib/recurring-invoices-logic.ts`) — mobile has no retry button on this screen, so
  the asymmetry is accepted, not fixed here.

### WP-E2E-COMMENT — spec 30 comment correction

- **files:** `apps/web/e2e/30-recurring-standing.spec.ts`
- **satisfies:** cause-ruling.md §2 "Spec 30 comment only"
- **provenBy:** (none — comment-only, no assertion change; verified by `git diff` review, not a test)
- **dependsOn:** none
- **effort:** `low`
- **brief:** In the file header and its `finally` cleanup block, correct any comment implying the
  template is hard-deleted — `DELETE /order-templates/:id` (and the recurring-invoice equivalent)
  is a **deactivate**, not a destructive delete. Comment text only; do not touch the cleanup calls,
  fixtures, or `sharedTemplateId`/`sharedCustomerName` ordering dependency.

### WP-DOCS — F13 close-out bookkeeping

- **files:** `.claude/campaign/status/F13.jsonl`, `.claude/code-map/api.md`,
  `.claude/code-map/web.md`, `.claude/code-map/mobile.md`, `.claude/code-map/_meta.json`,
  `.claude/code-map/CHANGELOG.md`, `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`
- **satisfies:** F13 close-out (not a cause-ruling item; bookkeeping)
- **provenBy:** (none — bookkeeping; verified by `scripts/campaign-check.mjs` and
  `scripts/validate-lessons.mjs` in the final verify commands)
- **dependsOn:** WP-API-B106, WP-WEB-B106, WP-E2E-COMMENT
- **effort:** `low`
- **brief:**
  - `F13.jsonl`: replace all five rows in place. B46, B48, B106 → `state: "proven"` (proof =
    the REG- jest token list + this run's probe results for B106; B106's proof text must name
    both the outcome-recording tests (T17/T17b/T18/T19, already at POST) and this run's
    CAS/T17/T17c). B09, B92 → `state: "proven-pending-deploy"` (T2, spec 30 e2e; unchanged tier).
    `pr: null` for all five (unmerged). Every `proof` field names its REG tokens, files, and T ids
    — no bare "fixed" text.
  - Code-map: add/extend surgical entries (purpose, exports/signatures, cross-refs — signatures
    not bodies) in `api.md`/`web.md`/`mobile.md` for every file in the 38-file diff
    (`git diff --name-only d0769701 9e5ce526`) plus this run's own touched files
    (`recurring-invoices.service.ts` CAS note, `invoices.ts`/`page.tsx` retry-hint note,
    `recurring-invoices.controller.spec.ts` new-file note, `order-templates.controller.roles.spec.ts`
    T35 addition). `_meta.json`: `mappedSha` → this run's final merge commit (fill in at
    close-out, not knowable at plan time), `generatedAt` → now, `notes` REPLACED (never
    accumulated) with a one-line pointer to this run's `CHANGELOG.md` bullet.
  - `CHANGELOG.md` (the code-map's, at `.claude/code-map/CHANGELOG.md` — no root `CHANGELOG.md`
    exists): one dated bullet atop the list summarizing the F13 close-out.
  - `LESSONS.md`: append **L-046** (pre-allocated to F13 per
    `.claude/pipeline/2026-09-02-wave-a-completion/SEQUENCE.md`; **`nextId` stays untouched** — it
    is 58 on master, and a batch never spends `nextId` on its own pre-allocated id) verbatim:

    ```markdown
    ### L-046 · 2026-09-04 · domain · F13

    - **Symptom:** a MONTHLY recurring invoice never advanced; a standing order billed list
      price; a failed cycle was silently skipped; a failed cycle's unconditional rollback could
      hand the schedule back for a cycle another run had already billed.
    - **Root cause:** a month-advance compared against a mutated date; a second writer priced
      lines outside the one buyer resolver; the cron advanced the schedule before it knew the
      outcome and never recorded it; the restore after failure was not conditioned on the claim
      that made it.
    - **Lesson:** **Every path that materialises an order or invoice from a saved shape is a
      pricing writer and a schedule writer: price through the shared resolver, record the outcome
      on the row you advanced, and undo a claim only by compare-and-set on the value the claim
      wrote — a miss means someone newer owns the row, so write nothing.**
    - **Guard:** REG-B48 T9–T16 through the real resolver; REG-B46 T1–T7b; REG-B106
      T17/T17c/T18/T19 + T36 ([[L-030]]: a write and its record share one condition; [[L-045]]:
      release on the forward-path marker).
    ```

    File this under the `## domain` category (grouped with other domain entries, not appended
    blind at end-of-file). `_meta.json`: `activeCount` +1, `updatedAt` bumped, `nextId` untouched.
    **Note for the implementer:** this pipeline directory already contains a stray
    `l046-draft.md` dated 2026-09-03 under category `testing` with unrelated content (a mutation-
    probe/baseline-disturbance lesson) — that draft is NOT this run's L-046 and must not be used;
    the text above is the only authorized L-046 content for this batch.

### Package map

| WP             | satisfies                       | provenBy  | dependsOn                                | Wave |
| -------------- | ------------------------------- | --------- | ---------------------------------------- | ---- |
| WP-API-B106    | cause-ruling §2 B106-a          | T17, T17c | —                                        | 1    |
| WP-WEB-B106    | cause-ruling §2 B106-b          | T36       | —                                        | 1    |
| WP-E2E-COMMENT | cause-ruling §2 spec-30 comment | —         | —                                        | 1    |
| WP-DOCS        | F13 close-out                   | —         | WP-API-B106, WP-WEB-B106, WP-E2E-COMMENT | 2    |

(Test packages TP-API and TP-WEB run before wave 1, per the engine's standard test-first ordering;
they are not listed in this map, which covers only the WP namespace. `dependsOn` above names only
other WP ids, never a TP id, per the engine's separate TP/WP namespaces.)

Cross-check: every `cause-ruling.md` §2 item (B106-a, B106-b, B46-c, B92-d, harness hygiene,
spec-30 comment) appears in some package's `satisfies:` or a test package's brief (B46-c and B92-d
and harness hygiene are test-only changes, owned by TP-API, which has no `satisfies:` field per the
test-package shape — their coverage is recorded here for the cross-check: B46-c → TP-API/T7,
B92-d → TP-API/T34+T35, harness hygiene → TP-API harness repair). Every `T#` in `bug-test-plan.md`
appears in some package's `provenBy:` or a test package's `tests:` list.

---

## Acceptance criteria

1. `B106-a` — a create failure's rollback calls `recurringInvoice.updateMany` with a `where`
   clause matching the `nextRunAt` value the claim wrote, not a plain `update`; on a lost CAS
   (`{count:0}`) no further write happens to the row and the original error still propagates.
2. `B106-b` — `isRetryableRunFailure(RUN_INTERRUPTED_ERROR)` is `false`; the recurring list page
   renders the provisional-FAILED state with no retry CTA; a terminal failure keeps its existing
   retry hint unchanged.
3. `B46-c` — `REG-B46 T7` fails on PRE (or an equivalent injected defect) on every calendar day,
   not only before the 15th of the month.
4. `B92-d` / `B09` pin — reverting `RecurringInvoicesController.update`'s or
   `OrderTemplatesController.update`'s `@Body()` type back to a `Partial<...Dto>` mapped type turns
   `REG-B92 T34` / `REG-B09 T35` red.
5. Negative case: none of B46/B48/B09/B92's already-shipped production code changes — a diff
   touching `recurring-invoices.service.ts`'s MONTHLY branch, `order-templates.service.ts`'s
   pricing block, `StandingOrderModal.tsx`, or the B92 edit route/form is out of scope for this
   run and should be flagged by review, not merged.
6. Deploy day: existing `RecurringInvoice` rows with a `lastRunStatus` already set (from the v1
   fixes, live since `9e5ce526`) are read unchanged by the CAS rollback — the CAS only changes
   behavior on the NEXT create failure after this run's fix ships; no backfill is required or
   performed.

---

## Verification commands

Per round (scoped to the touched workspaces):

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx jest src/order-templates src/recurring-invoices --runInBand
cd apps/mobile && npx tsc --noEmit
cd apps/mobile && npx jest __tests__/recurring-invoices-helpers.test.ts
cd apps/web && npx jest invoices.test
cd apps/web && npx tsc --noEmit
```

Final (once, deciding the result):

```bash
cd apps/api && npx jest --silent
cd apps/mobile && npx jest --silent
node scripts/campaign-check.mjs
node scripts/validate-lessons.mjs
cd apps/web && npx playwright test --list --reporter=list
```

`--list` only (never a real Playwright run — it clobbers `.campaign/runs/web-e2e.json`, per the
project's own lesson register).

---

## UI verification

_Copy/CTA-styling change only — no new flow, no new route._

- **URL:** `http://localhost:3001/invoices/recurring`
- **Start command:** the repo's local hosting stack (`npm run local:up`) if not already running;
  whatever this agent starts, it must stop.
- **Flows:**
  - A recurring-invoice card whose `lastRunStatus` is `FAILED` with `lastError ===
RUN_INTERRUPTED_ERROR` shows the informational copy with no button/CTA styling (visually
    distinct from the terminal-failure red pill).
  - A recurring-invoice card whose `lastRunStatus` is `FAILED` with a terminal message shows the
    unchanged red pill + "use Run Now to retry" hint.
  - A recurring-invoice card whose `lastRunStatus` is `SUCCESS` is visually unchanged.
- **Viewports:** `desktop`
- **Checks:** `console-errors`, `network-failures`

---

## Risks & rollback

| Risk                                                                                                                                                         | Likelihood | Blast radius                                                                              | Mitigation / what the reviewer should watch                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| CAS rollback's `where.nextRunAt` uses the wrong variable (pre-claim instead of the claim's advanced value), silently reintroducing the unconditional restore | low        | money/schedule — a double-bill on the next failure                                        | T17's exact `where` assertion catches this; reviewer diffs the `where` clause against the claim's own `updateMany` call at `:224-232` |
| Web copy branch mis-detects a terminal vs. provisional failure (e.g. compares the wrong constant)                                                            | low        | UX-only — a real failure loses its retry hint, or a healthy run still invites a duplicate | T36's exact string-equality assertions on both `RUN_INTERRUPTED_ERROR` and a terminal message; UI verification flow 1 vs 2            |
| Harness repair to the two `OrdersService` doubles perturbs an existing passing assertion in `order-templates.service.spec.ts`                                | low        | test-only                                                                                 | full `apps/api` jest run in `verifyCommands.final`                                                                                    |

- **Rollback:** revert this run's diff; the v1 fixes at `9e5ce526` are unaffected (this run only
  changes the rollback shape, the web retry-hint logic, a comment, two new pins, and bookkeeping).
- **Migration reversibility:** N/A — no schema change in this run.
- **Feature flag / entitlement:** none — this is a bug fix, always-on.
- **Deploy day:** no backfill; the CAS rollback only changes behavior on the next create failure
  after deploy. Historical duplicate invoices from the pre-fix race (if any) are an owner-report
  question, not repaired here (`cause-ruling.md` §6).
- **Observability:** the new `warn`-level log line
  ("...rollback skipped: a newer run already moved nextRunAt...") is the 2am signal that the CAS
  guard fired — its presence in production logs means the race was real and the fix worked, not
  that something broke.

---

## Pipeline args

See `pipeline-args.json` in this directory (ready to copy into the Workflow call).
