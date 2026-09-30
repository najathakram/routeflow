# F09 · Fix-round 2 report (Sonnet, client-side findings B1–B5)

Scope: `fix-round-1-ruling.md` §6, applying `review-lens-b-clients.md`'s B1/B2/B3/B4/B5 (FIX);
B6 left untouched (ACCEPT). Worked entirely inside
`C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09` on `fix/F09-credit-notes-wallet`
(started at HEAD `5c0dc4644d0c7eed2dac2549c784583f2cc08559`). No commit, stash, checkout, or
reset was run. No `.claude/` file was touched other than this report.

## ⚠️ Deviation / finding: concurrent live activity in this worktree

My **very first** `git status --porcelain` in this session (before any edit) showed only:

```
 M .claude/code-map/_meta.json
 M .claude/code-map/api.md
 M .claude/lessons/_meta.json
 M .claude/pipeline/2026-09-01-f09-credit-notes-wallet/fix-round-1-ruling.md
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/probes-2026-09-06.md
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/review-lens-a-api.md
?? .claude/pipeline/2026-09-01-f09-credit-notes-wallet/review-lens-b-clients.md
```

By the time I ran the gate 4 check (`git status --porcelain` / `git diff --stat`) at the end of
this round, the working tree additionally showed, **none of which I touched**:

- Modified: `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`,
  `apps/api/src/customers/customers.service.ts`, `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/returns/returns-refund.spec.ts`, `apps/api/src/returns/returns.service.ts`,
  `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/spec.md`.
- New untracked: `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/fix-round-3-ruling.md`,
  `lesson-L-081.md`, `p8-plan.md`.

This is evidence another live process (very likely the lens-A/API-side fix round and/or a P8
close-out step running concurrently against this same worktree) is writing to it right now. Per
the project's multi-session rules ("one owner per item", "verify worktree ownership before
writing", "a dirty worktree with recent mtimes is a LIVE run"), I did **not** interact with any
of those paths — no read for context, no edit, no stash/checkout to "clean" them. I isolated
every verification command below to exactly the 5 files this round owns
(`git diff -- <file> <file> ...` / `git diff --stat -- <file> <file> ...`), so none of my
reported results include or are contaminated by the concurrent changes. The final gate-4 command
in my brief (`git status --porcelain` unscoped) will **not** show "exactly" the 5-file set plus
three dirty `.claude/` files — it will show the additional concurrent paths above too. That is a
fact about the shared worktree's current state, not a defect in this round's edits; see the
scoped diffs below for what this round actually changed.

## Findings applied

### B1 — blocker — heading locators unscoped (`28-credit-note-wallet.spec.ts:102`, `:122`)

Read `15-stock-count-ui.spec.ts:150-152` first (cited convention: `{ level: 2 }` with a comment
explaining the dashboard shell's `<h1>` duplicates the page's own heading string) and
`21-destructive-guards.spec.ts:200-205` (cited convention: `page.locator("#main-content").getByRole(...)`).
Used the `#main-content` scoping form (ruling's primary suggestion) at both sites.

```diff
--- a/apps/web/e2e/28-credit-note-wallet.spec.ts
+++ b/apps/web/e2e/28-credit-note-wallet.spec.ts
@@ (list heading, was :102)
-    await expect(page.getByRole("heading", { name: "Credit Notes" })).toBeVisible({
+    // Scoped to #main-content: the dashboard shell's own <h1> also reads
+    // "Credit Notes" (via setTitle), so an unscoped match resolves 2 elements
+    // and violates strict mode — same trap as 15-stock-count-ui.spec.ts:150-152.
+    await expect(
+      page.locator("#main-content").getByRole("heading", { name: "Credit Notes" }),
+    ).toBeVisible({
       timeout: 15_000,
     });
@@ (detail heading, was :122)
-    await expect(page.getByRole("heading", { name: cn.creditNoteNumber })).toBeVisible({
+    // Scoped to #main-content for the same reason as the list heading above —
+    // the detail page's own <h1> (setTitle) duplicates this <h2> string.
+    await expect(
+      page.locator("#main-content").getByRole("heading", { name: cn.creditNoteNumber }),
+    ).toBeVisible({
       timeout: 15_000,
     });
```

### B2 — major — T14's ISSUED fixture makes the REG-B18 oracle vacuous

Ruling's design: change the T14 fixture to `status: "DRAFT"` (inline spread, per the ruling's
first alternative) plus a one-line comment naming it the phantom value the dead flow keyed on.

```diff
--- a/apps/web/e2e/28-credit-note-wallet.spec.ts
+++ b/apps/web/e2e/28-credit-note-wallet.spec.ts
@@ (was :113)
-    const cn = creditNoteFixture();
+    // REG-B18's oracle needs a fixture the pre-fix build would still show an
+    // Issue button for, or a green result is not evidence of anything: DRAFT
+    // is the phantom status the deleted flow keyed its button on, wire-shaped
+    // but never actually issuable post-P2 (status is created ISSUED).
+    const cn = { ...creditNoteFixture(), status: "DRAFT" };
```

`creditNoteFixture()`'s return type is an un-annotated object literal, so `status` widens to
`string` in the inferred return type (no `as const` / contextual typing) — spreading and
overriding to `"DRAFT"` is a plain string assignment and does not fight the type system anywhere
downstream (`fulfillJson(route, cn)` takes `body: unknown`). Confirmed by the tsc run below
(exit 0).

### B3 — major — stale `/credit-notes/:id/issue` QA-harness checks

Deleted only the named check in each file; left every surrounding check (including the
`state.creditNoteId` / `createdCreditNoteId` assignments in the adjacent "creates credit note"
checks, which are each that check's own id-truthy assertion, not something used only by the
deleted issue check) untouched, per the ruling's "do not touch any other check" instruction.
`git grep -in issue` on both files after the edit returns no matches.

```diff
--- a/apps/api/scripts/qa-run.js
+++ b/apps/api/scripts/qa-run.js
@@ (was :1295-1304)
-  await test(53, "POST /credit-notes/:id/issue → status ISSUED", async () => {
-    const r = await api(
-      "POST",
-      `/credit-notes/${state.creditNoteId}/issue`,
-      {},
-      state.operatorToken,
-    );
-    assert(r.status === "ISSUED", `status=${r.status}`);
-  });
-
   // Returns
```

```diff
--- a/apps/api/scripts/e2e-verify.ts
+++ b/apps/api/scripts/e2e-verify.ts
@@ (was :1286-1303)
-  await check("POST /credit-notes/:id/issue → 200 ISSUED", async () => {
-    // Create a fresh credit note in DRAFT status to issue
-    // Note: credit notes are created as ISSUED directly in this service,
-    // so we just verify the issue endpoint on the existing one (idempotent or 400)
-    expect(createdCreditNoteId !== "", "No credit note id");
-    const { status, data } = await api(
-      "POST",
-      `/credit-notes/${createdCreditNoteId}/issue`,
-      undefined,
-      operatorToken,
-    );
-    // Could return 200 (already issued, idempotent) or 400 (already issued)
-    expect(
-      [200, 201, 400].includes(status),
-      `Expected 200/201/400, got ${status}: ${JSON.stringify(data)}`,
-    );
-  });
-
   await check("POST /credit-notes/:id/void → 200 VOID", async () => {
```

### B4 — minor — void-modal copy still promises "issued"

```diff
--- a/apps/web/app/(dashboard)/credit-notes/[id]/page.tsx
+++ b/apps/web/app/(dashboard)/credit-notes/[id]/page.tsx
@@ (was :63)
       <p className="text-sm text-navy/70">
-        Voiding this credit note will mark it as cancelled. It can no longer be issued or applied.
+        Voiding this credit note will mark it as cancelled. It can no longer be applied.
       </p>
```

### B5 — nit — duplicate `CreditNoteStatus` import/re-export

Adopted the mobile form (`apps/mobile/lib/api/credit-notes.ts:2,10` — one `import type`, one bare
`export type { X };`) for symmetry, as the ruling suggested.

```diff
--- a/apps/web/lib/api/credit-notes.ts
+++ b/apps/web/lib/api/credit-notes.ts
@@ (was :7)
-export type { CreditNoteStatus } from "@routeflow/types";
+export type { CreditNoteStatus };
```

### B6 — nit — ACCEPT, no change

`apps/mobile/lib/credit-notes-logic.ts:28` `default` branch left as-is per the ruling.

## Gate outputs

**1. `cd apps/web && npx tsc --noEmit -p tsconfig.json`**

Exit code 0. Full captured output:

```
[exited with code 0]
```

(no diagnostics emitted — confirms the B2 fixture spread/override and the B1/B5 locator/type
changes all type-check cleanly).

**2. `cd apps/web && PLAYWRIGHT_JSON_OUTPUT_FILE=... npx playwright test --list --project=credit-note-wallet`**

Project name in `playwright.config.ts:503` is exactly `credit-note-wallet` — no substitution
needed. Full `--list` output:

```
Listing tests:
  [setup] › setup\auth.setup.ts:27:6 › authenticate as super admin
  [setup] › setup\auth.setup.ts:46:6 › authenticate as operator
  [setup] › setup\auth.setup.ts:59:6 › authenticate as customer
  [credit-note-wallet] › 28-credit-note-wallet.spec.ts:85:7 › Credit-note wallet UI: invoice number over UUID, no Issue affordance (F09) › REG-B19: /credit-notes renders the mocked row's invoice number, never the raw UUID (R10 / T13)
  [credit-note-wallet] › 28-credit-note-wallet.spec.ts:115:7 › Credit-note wallet UI: invoice number over UUID, no Issue affordance (F09) › REG-B18: /credit-notes/:id loads (number heading) with no Issue Credit Note button (R7 / T14)
Total: 5 tests in 2 files
```

Exactly the two spec-28 tests are listed (`REG-B19` / T13 at `:85`, `REG-B18` / T14 at `:115`),
alongside the 3 `setup` project tests pulled in via `dependencies: ["setup"]` (expected — the
`credit-note-wallet` project depends on `setup`, so `--list` surfaces both). No tests were run.

**3. Prettier**

`npx prettier --write` on the 5 changed files:

```
apps/web/e2e/28-credit-note-wallet.spec.ts 2135ms (unchanged)
apps/web/app/(dashboard)/credit-notes/[id]/page.tsx 1591ms (unchanged)
apps/web/lib/api/credit-notes.ts 358ms (unchanged)
apps/api/scripts/qa-run.js 4131ms (unchanged)
apps/api/scripts/e2e-verify.ts 2418ms (unchanged)
[exited with code 0]
```

`npx prettier --check` on the same 5 files:

```
Checking formatting...
All matched files use Prettier code style!
```

All 5 files were already Prettier-clean after the `Edit` calls — no reformatting was needed.

**4. `git status --porcelain` / `git diff --stat` — scoped to this round's 5 files**

```
$ git diff --stat -- apps/web/e2e/28-credit-note-wallet.spec.ts "apps/web/app/(dashboard)/credit-notes/[id]/page.tsx" apps/web/lib/api/credit-notes.ts apps/api/scripts/qa-run.js apps/api/scripts/e2e-verify.ts
 apps/api/scripts/e2e-verify.ts                      | 18 ------------------
 apps/api/scripts/qa-run.js                          | 10 ----------
 apps/web/app/(dashboard)/credit-notes/[id]/page.tsx |  2 +-
 apps/web/e2e/28-credit-note-wallet.spec.ts          | 19 ++++++++++++++++---
 apps/web/lib/api/credit-notes.ts                    |  2 +-
 5 files changed, 18 insertions(+), 33 deletions(-)
```

Exactly the 5 files named in the brief, and nothing else, changed **by this round**. The
unscoped `git status --porcelain` additionally shows the concurrent-activity paths documented
above in the deviation section — those are not this round's edits.

## Summary of deviations from the literal brief

1. Gate 4's unscoped `git status --porcelain` does not show "exactly" the 5-file-plus-three-dirty
   set, because other files changed concurrently mid-session (see deviation section). Scoped
   diffs/stats above prove this round touched only its 5 files.
2. No other deviation: B1–B5 were each applied exactly as the ruling specified (B1's
   `#main-content` scoping option, B2's inline-spread option, B3's delete-only-the-named-check,
   B4's exact copy replacement, B5's mobile-form adoption); B6 was left untouched (ACCEPT).
