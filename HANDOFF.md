# HANDOFF — current state & what to pick up next

> # ▶️ MULTI-SESSION STATE — F05 FULLY CLOSED, B167 DISCHARGED (2026-09-01, master `896d5f7e`)
>
> Several sessions ran concurrently today and the repo state is not obvious from any one of
> them. This banner is the reconciled picture, verified against `origin/master` — not a single
> session's view. It is maintained by the merge-coordinator session running the train
> **#580 ✅ → B167 discharge ✅ → #581 ✅ → #579 (this) → #571 → #574**.
>
> **Ledger now: 193 rows — 46 `done`, 2 `already-fixed`, 145 `queued`, NOTHING mid-flight**
> (48 of 193 = 24.9% terminal) — counted off the shards, not carried forward from an earlier
> banner. Shipped and fully discharged: F00, F01, F02 (9), F03 (9), F04 (3), **F05 (5)**,
> F06 (6), F17 (4), F30 (12). **11 Criticals still open** (B46 B48 B52 B53 B54 B55 B56 B58 B59
> B128 B129).
>
> ## 1. ✅ B167 is DISCHARGED — F05 is closed
>
> The `deployment_status`-triggered e2e for master `0771a9d9` (#580) went green
> ([run 33522301206](https://github.com/najathakram/routeflow/actions/runs/33522301206)):
> `✓ 134 [run-settlement] REG-B167 … (2.4s)`, suite **115 passed / 22 skipped / 0 failed** in
> 4.0m, with the freshness gate satisfied so it ran against the deployed build of that sha. It
> fired itself off Railway's deploy signal — nothing was dispatched. B167 flipped to `done` in
> #584 carrying that run id as `dischargeEvidence`. **It was NOT discharged on the strength of
> the fix** — that distinction is the whole reason the row was held.
>
> ⚠️ **The earlier B167 red was the SPEC, not the product.**
> `getByRole("heading", { name: "Settlement" })` resolved to 3 elements: Playwright matches
> accessible names by SUBSTRING, and the fixture route was named `E2E B167 Settlement <ts>`,
> which renders as an `<h1>` in both the shell banner and `#main-content`. **The failure output
> was itself the proof the feature works** — element 3 was `<h3>Settlement</h3>` on a COMPLETED
> run's detail page, exactly what B167 requires. #580 shipped **both** halves: `exact: true` on
> the assertion **and** the fixture renamed to `E2E B167 Run <ts>` (salvaged from closed #575),
> so the colliding word is gone rather than merely dodged — the rename alone would not have
> covered fixtures leaked by earlier failed runs, which is why both landed.
>
> ## 2. PRs — what landed today and what is still open
>
> | PR       | Branch                           | State         | What                                                              |
> | -------- | -------------------------------- | ------------- | ----------------------------------------------------------------- |
> | ~~#580~~ | `docs/status-refresh`            | **MERGED**    | B167 fix + fixture rename + F05 ledger (`0771a9d9`)               |
> | ~~#582~~ | `docs/supersede-blockers-plan`   | **MERGED**    | old release-blockers plan marked SUPERSEDED (`a8220795`)          |
> | ~~#584~~ | `chore/discharge-b167`           | **MERGED**    | B167 → `done` on the green e2e (`f5812191`)                       |
> | ~~#581~~ | `docs/multi-session-state`       | **MERGED**    | the reconciled banner + `.tmpjest` gitignore (`896d5f7e`)         |
> | **#579** | `docs/handoff-f17-session`       | **this PR**   | F17's close-out threads, rebased onto the reconciled banner       |
> | #571     | `chore/lessons-learned-system`   | next in train | lessons register + `stop.mjs` Gate 3; **also rewrites this file** |
> | #583     | `fix/mobile-google-signin-sdk55` | open, owner's | the Android fix PR below — **its session rebases it, not you**    |
> | #574     | `dependabot/…e1a987a042`         | last in train | 16 dep bumps — see the multer finding in §10                      |
> | ~~#575~~ | `fix/F05-b167-e2e-selector`      | CLOSED        | superseded by #580 (its fixture rename was salvaged)              |
>
> ⚠️ **FIVE things have competed to rewrite HANDOFF.md**, not three: #575 (closed), #580, #581,
> this PR, and **#571 — which carries the entire Android publish-readiness banner** (commit
> `1c81e2e4`). #583 additionally collides on `.claude/code-map/CHANGELOG.md` (the usual prepend
> conflict — **re-append the anchor bullet**). Sequence deliberately and preserve each one's
> unique content; never let a rebase pick a winner.
>
> ## 2b. ⚠️ The Android publish-readiness session — a DECIDED, UNSTARTED fix PR
>
> The other live session was **not** doing campaign work. It produced a Google Maps key, an
> on-device test of the real APK, and an 11-agent publish-readiness audit, then the owner
> **chose a fix scope and nothing was implemented.** Its handoff was sitting **uncommitted**
> in the main checkout; it is now preserved as commit `1c81e2e4` on
> `chore/lessons-learned-system` (PR #571). **Read that banner before starting Android work** —
> only the headline is repeated here:
>
> - **A hard blocker, verified by hand:** `apps/mobile/app/(auth)/google-callback.tsx:47,79` do
>   `const { default: SecureStore } = await import("expo-secure-store")`. That package has **no
>   default export**, and the call sits in the `!isWeb` branch — so **native Google Sign-In is
>   completely broken** and always has been. Web is fine via the localStorage branch, which is
>   why nobody saw it. Fix is a namespace import, matching `lib/auth.ts:1`. Predates B204.
> - **Five native modules still pinned pre-SDK-55** — the exact class that crashed the first APK
>   (B203). ⚠️ **`npx expo install --fix` is WRONG here:** root `package.json` `overrides` pin
>   three of them and the root override wins on `npm ci`, silently reverting a workspace-only
>   bump. Edit the workspace manifest **and** the root overrides in one commit.
> - **Versioning is a duplicate-versionCode generator today** (`appVersionSource: "local"` +
>   production `autoIncrement: true`); Play rejects a reused versionCode outright. The decided
>   fix moves to `"remote"`.
> - **Maps key done except one read-back** — the application restriction was never re-read after
>   the console hung. ⚠️ **Never restrict the other key** ("Maps Platform API Key"): the API
>   re-serves it to browsers, so restricting it repeats the 2026-08-26 outage.
> - Two new lessons landed in the same commit: **L-024** (one credential per call origin) and
>   **L-025** (a `Platform`/`isWeb` branch is untested code unless something runs that platform —
>   the general form of the Sign-In bug above).
>
> ## 3. Worktrees — live vs prunable, and an ancestry trap
>
> All worktrees are **clean** (no uncommitted work anywhere) as of this banner. What matters is
> which have a **live session** attached — never remove one of those; message its session instead.
>
> | Worktree      | Branch                                       | Status                                        |
> | ------------- | -------------------------------------------- | --------------------------------------------- |
> | main checkout | `fix/mobile-google-signin-sdk55`             | **LIVE** — the Android session, mid-edit      |
> | `rf-F07`      | `fix/F07-order-lifecycle-stock-conservation` | **LIVE** — F07 batch (board #520)             |
> | `rf-F10`      | `fix/F10-reopen-stop-state-guards`           | **LIVE** — F10 batch (board #523)             |
> | `rf-F17`      | `docs/handoff-f17-session`                   | **this PR's branch** (was F17's, reused)      |
> | `rf-F05`      | `docs/multi-session-state`                   | #581 — MERGED; prunable once the train clears |
> | `rf-docs`     | `docs/status-refresh`                        | #580 — MERGED; prunable once the train clears |
> | `rf-F06`      | `chore/discharge-b167`                       | #584 — MERGED; reusable                       |
> | ~~`rf-F03`~~  | ~~`fix/F03-payment-truth`~~                  | **PRUNED** 2026-09-01 — had landed in #564    |
>
> ⚠️ **`fix/F03-payment-truth` and `fix/F17-import-robustness` looked unmerged and were NOT.**
> `git log master..branch` showed 8 and 5 commits because squash-merge rewrote the SHAs. **And
> the three-dot `git diff master...branch` is equally misleading here** — the merge-base is
> ancient, so it reports thousands of already-landed lines. Verify by CONTENT:
> `scripts/repair-f03.mjs`, `apps/web/e2e/22-payment-truth.spec.ts`, `scripts/repair-f17.mjs`
> and `apps/web/e2e/26-import-duplicates.spec.ts` are all on master, so both had landed (#564,
> #566). Both were pruned on that evidence — the `rf-F17` **directory** is reused above for this
> PR's branch, which is not the same thing as its old branch being live.
>
> ## 4. Two campaign-wide traps — each cost a failed run today
>
> - ⚠️ **`npx playwright test --list` POISONS the campaign artifact.** It writes
>   `.campaign/runs/web-e2e.json` as an **all-skipped** report, so the whole-ledger
>   `campaign-check` then fails on OTHER batches' T2 rows (it produced a confusing red on
>   F02b's B24/B130/B154, discharged weeks earlier). **Always `--list --reporter=list`.**
> - ⚠️ **A rebase that pulls in another batch's ledger rows can red the pre-push
>   `campaign-check` on rows you never touched** — it rejected a push here for F06's
>   B47/B51/B60/B63/B78. **CORRECTED 2026-09-01, verified at source — the old advice to hand-run
>   `jest --json --outputFile=…` is RETIRED.** `scripts/jest-campaign-reporter.cjs` is wired as a
>   second jest reporter in both `apps/api/package.json` (`jest.reporters`) and
>   `apps/mobile/jest.config.js`, so **every jest run rewrites the artifact by itself**, and
>   `verify` orders the full test pass before `campaign-check` by design.
>   ⚠️ **But the reporter only fires when jest actually EXECUTES, and a rebase does not bust
>   turbo's test cache** — the ledger is not an input to the test task's hash, so pulling in
>   another batch's rows can never invalidate it. That is exactly how the failure above happened:
>   verify ran the test task, turbo replayed cached logs (L-009), jest never ran, and the artifact
>   stayed two days stale. **So: if `campaign-check` reds on rows you did not touch, check the
>   artifact's mtime FIRST.** If it predates your rebase, force execution (`turbo run test
--force`, or a direct `npx jest`) — do not go debugging the ledger. A scoped jest run
>   overwrites the artifact with only its own tests, which can produce a false RED but never a
>   false green.
>
> Same root cause both times: **the gate reads run artifacts, so a stale artifact reads as an
> undischarged claim.** Both are documented in F05's build-plan.
>
> ## 5. Small — ✅ done in this PR
>
> `apps/mobile/.tmpjest/` (dev-pipeline probe scratch) was **not gitignored**, so a `git add -A`
> from any session would commit another session's throwaway probes. Added to root `.gitignore`
> beside `.campaign/`. The files themselves are left alone — a live session may be using them.
>
> ## 6. F05 shipped — what the next routes batch inherits
>
> **#569 → master `86844f88`**, both Railway services SUCCESS, `post-deploy-check` green,
> `feature-smoke` green (91/91 on re-runs; the FIRST run reported 1 failure in S1–S5, none of
> which touch routes/settlement, and two of those sections are first-run-vs-rerun sensitive —
> recorded rather than buried). **G7 delivered:** `RUN_LINE_ITEMS_SELECT` is the single run-read
> lineItems select — **F10/F11/F12/F22 extend that const, never re-inline the literal.**
>
> ⚠️ **The register missed the real settlement bypass:** RF-016 auto-complete inside
> `completeStop`/`completeWithPayment` flips a run COMPLETED in its own tx, so gating
> `updateRunStatus` alone would never have fired on the common path. All three paths now carry
> the predicate. ⚠️ **B148 was the reachability blocker** — every stop completion 400'd on a
> DTO/payload mismatch, so no money fix was reachable until it landed.
>
> **F11 inherits two gates F05 deliberately did not take** (found by the Fable final pass): the
> CANCEL path and `deleteRun` can still close or destroy a cash-carrying run unsettled.
> `settleRun` now accepts CANCELLED post-hoc so the money is never _stranded_, but nothing
> forces reconciliation there. Full write-up is on F11's fix-card.
>
> **Next per the schedule:** F07 on track A (**claimed**, board #520); F10 in the routes lane
> behind F05 (**claimed**, board #523). Both sessions rebase onto post-train master before
> pushing, and both regenerate `.campaign/runs/api.json` after that rebase (see §4).
>
> ## 7. F17's close-out — the threads it left open
>
> **B99's repair flight is DONE, and it found nothing to repair.** `scripts/repair-f17.mjs` ran
> as a dry run (read-only session, production DB) and reported no repairable duplicate pairs and
> no ambiguous clusters. Its detection query — invoices carrying two or more non-VOID payments
> with no distinguishing reference, B99's exact damage signature — matched **zero rows**, so no
> tenant ever re-uploaded through the un-deduped path. No backup and no writes were needed; the
> bug was real in code but never fired on live data. **F17 is fully closed, all four rows
> `done`.**
>
> ⚠️ **B205 is a NEW register entry, not a miss.** The Migration Hub's own products-CSV path
> still carries B98's class. A fix was written during F17 and **deliberately reverted** after
> adversarial review: routing `pricePerUnit` through a lenient parser turned a
> present-but-unparseable price from a loud `products.create` throw into a **silent $0.00
> commit**, and `parseFloat` leniency admitted `-$5`/`12abc`on a path that calls`ProductsService.create()` in-process, so the DTO never runs. **It needs its own batch with an
> e2e** (no web unit runner, per D1).
>
> ## 8. 🔴 Owed to the owner — decisions no session can take
>
> - **RLS arming (D3) — a decision, not a task.** Parked at `prisma/deferred-rls/`; ⚠️ **read
>   that folder's README before touching it (#570).** The 15 blocked tables split four ways:
>   2052 rows across five tables are the nested-create defect and backfill deterministically
>   from a parent that does hold a `tenantId`; two rows need their headers first; five
>   singletons need eyes; and **1795 rows cannot be backfilled at all.** Arming as written would
>   **log every user out and kill platform-admin login** — FORCE ROW LEVEL SECURITY hides a
>   null-tenant row from the app's own connection, not just from other tenants. The README
>   previously assumed the 1729 `RefreshToken` nulls were super-admin tokens; they are not
>   (OPERATOR 1104, SUPER_ADMIN 249, CUSTOMER 228, TENANT_ADMIN 129, DRIVER 19 — the column has
>   simply never been populated), and backfilling from `User.tenantId` cannot fix it because the
>   super-admin owners are themselves null by design. **Owner decision needed:** drop `User` /
>   `RefreshToken` / `ExpenseCategory` from the policy list, as the file now recommends.
>   Re-characterise any time with `local-assets/rls-null-triage.mjs` (gitignored, read-only).
> - **User-guide republish.** `local-assets/docs/routeflow-user-guide.html` is UPDATED and waits
>   only on an owner republish — the artifact is shared-not-owned, so no session can publish it.
>   It now documents F17's two user-visible changes, F03's draft-payment/PDF/email behaviour and
>   the F30+B202 scan improvements, and corrects a Migration Hub passage F17 made false.
> - **3 TENANT_ADMIN users have no tenant** — surfaced by that RLS triage. A tenant admin
>   without a tenant is a data defect, not a design choice, and wants chasing on its own merits.
>   Not yet a register entry.
>
> ✅ **Policy layer is no longer owner-blocked — APPROVED 2026-09-01**, all four asks answered:
> full default→tenant→category→customer scope chain; ONE append-only `PolicyValue` table
> (`tenantId`, `key`, `scopeType`, `scopeId`, Json `value`, `setBy`, `supersededAt`) with a 30s
> invalidate-on-write cache copying `EntitlementsService`; **all three pilots**
> (`orders.driverAtDoorEdit` default `amend`, `credit.approvalThreshold` default `null`,
> `invoicing.priceDisclosure`) with defaults reproducing today's behaviour exactly, so nothing
> changes on deploy day; **build AFTER Wave A** — the first two pilots live in
> `orders.service.ts` / `credit-notes.service.ts`, the files Wave A is rewriting. When Wave A
> closes → `/feature-plan` phases 1–2. Do not start earlier; the rebase churn is the whole
> reason for that sequencing answer.
>
> ## 9. More traps — each cost real time, recorded nowhere else
>
> - **`npm run post-deploy-check` silently defaults to `localhost:3000`** and reports "fetch
>   failed". It needs `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app`.
> - **In a dev-pipeline call, an implementation package's `dependsOn` must name IMPLEMENTATION
>   packages.** Naming a testPackage raises a `(build-plan)` blocker even though phase ordering
>   already guarantees it — two false blockers on the F17 run came from exactly this.
> - **Republishing the register requires a genuine full `Read` of the ~3660-line fetched copy** —
>   a structural diff is refused however conclusive, and the first publish attempt after the
>   fetch is refused as "identical content already refused". The sequence that works:
>   `action: "read"` the URL, `Read` every line of the saved file, `read` the URL once more,
>   then publish. Budget ~150k tokens and do it LAST in a session so it cannot crowd out
>   operational context.
> - **Direct pushes to master are blocked by a pre-push hook** — even a one-line ledger flip
>   needs a branch and a PR. That hook also runs the full `npm run verify`, so a push can take
>   5+ minutes: never run push and `gh pr create` under one short timeout. ⚠️ It caches a
>   **verified-tree marker keyed on the commit TREE hash** in `.git/rf-verified`, so re-pushing
>   identical content skips the gate — which also means a clean worktree whose tree already
>   passed can push another worktree's ref cheaply.
> - **Commitlint rejects a subject starting with a bare batch token** (`F17 rows to done …`
>   fails `subject-case`) and rejects uppercase words like `E2E` in the subject. Lead with a
>   lowercase verb. ⚠️ A PowerShell here-string (`@'…'@`) mangles multi-line commit messages —
>   write the message to a file and use `git commit -F`.
> - **CI legitimately reports ZERO checks on a docs-only PR.** `ci.yml`'s `paths-ignore` covers
>   `**.md`, `.claude/**`, `docs/**`, `local-assets/**` — so a ledger flip or a handoff edit
>   produces no run at all, and the pre-push `verify` is the authoritative gate (ci.yml says so
>   itself). Do not confuse this with the **CONFLICTING** PR case, which also shows zero checks
>   but for a different reason: there, rebase first.
> - ⚠️ **On Windows, `git worktree remove` can fail with `Filename too long`** and leave a
>   half-deleted directory that is already deregistered. Recover by mirroring an empty directory
>   over it (`robocopy <empty> <dir> /MIR`) and then deleting it.
>
> ## 10. Dependabot #574 — reviewed, and one bump does NOT do what it says
>
> #546 cleared 13 of these bumps. Its one blocker was `react-test-renderer@19.2.8`, whose peer
> wants `react ^19.2.8` while `apps/mobile` pins `react` exact at 19.2.0 per Expo SDK 55 — npm
> resolves that by forking a **second renderer** under `jest-expo`. ⚠️ **Neither gate catches
> it:** the lock-edge validator reports peer mismatches without failing, and `npm ci` installs
> the lock verbatim without re-resolving peers. The ignore rule with that reasoning is on master
> (#572) and Dependabot's recreate correctly dropped it. **#574 then came back as 16 bumps**,
> adding `@sentry/node`, `@sentry/react` and `multer`. Those three were reviewed here:
>
> - **`@sentry/node` 10.71.0 → 10.72.0 — safe, one behavioural note.** 10.72.0 stops sending an
>   event for errors the AI frameworks propagate to your code. That path is live here
>   (`bookkeeping.service.ts` calls `@anthropic-ai/sdk`), but the Anthropic call rethrows a raw
>   `Error` → 500 → still captured by `common/sentry-exception.filter.ts`. Net effect is one
>   fewer duplicate report, not lost visibility.
> - **`@sentry/react` 10.71.0 → 10.72.0 — safe.** Nothing in the release touches browser
>   `init`/transport, and `apps/mobile/lib/sentry.ts` returns early unless `Platform.OS === "web"`,
>   so the browser SDK never loads in a native context — the RN-peer worry is moot by construction.
> - ⚠️ **`multer` 2.2.0 → 2.3.0 — the bump is INEFFECTIVE and every upload endpoint stays on
>   2.2.0.** `@nestjs/platform-express@11.2.3` declares `"multer": "2.2.0"` — an **exact** pin —
>   and #574's lockfile adds `apps/api/node_modules/multer` @ 2.3.0 while leaving the hoisted
>   `node_modules/multer` @ **2.2.0** untouched. `FileInterceptor`/`FilesInterceptor` come from
>   platform-express, which resolves from the root, so all 15 interceptor sites keep 2.2.0. Only
>   the two direct `import { memoryStorage } from "multer"` sites see 2.3.0. **multer < 2.3.0 is
>   affected by four advisories; two apply here** — CVE-2026-82333 (High, event-loop DoS via the
>   field parser; ⚠️ its fix is **opt-in** via the new `fieldArrayIndexLimit`, so upgrading alone
>   does not mitigate it) and CVE-2026-77078 (Medium, uncaught `RangeError` kills the process).
>   The other two do not: all three RouteFlow `fileFilter`s are synchronous, and the repo is
>   `memoryStorage`-only with no `diskStorage` anywhere. **Merging #574 is not a regression, but
>   it buys no security here.** The real fix is a root `overrides` entry (the only lever when the
>   parent pins exactly — the repo already does this for `sanitize-html`) plus setting
>   `fieldArrayIndexLimit`, as its own scoped PR. Filed as a follow-up task.
>
> ---
>
> <details><summary>Previous banner (F03 + F17 shipped, F05 in flight)</summary>
>
> # ▶️ CAMPAIGN RESUMED — F03 + F17 SHIPPED, F05 IN FLIGHT (2026-09-01)
>
> The pause below was lifted by the owner. Since it was written: **F03 SHIPPED** (#564, master
> `f1599490` — 8 of its 9 bugs `done`, B11 since discharged by #568), **#565** landed the two
> native launch blockers (B203/B204), **F17 SHIPPED** (#566, ledger discharged in #567), and
> **F05 is in flight as PR #569** (branch `fix/F05-driver-at-door-money-settlement`, rebased
> onto master `e41a1e28`).
>
> **F17 — import robustness (B98, B99 both Critical; B112; B08).** `parseFloat("1,234.56")` is
> `1`, so $1,234.56 imported as $1.00 across four importers; a payments re-upload had no dedupe
> at all despite a comment promising one, so every retry doubled recorded payments and flipped
> invoices to PAID; Excel's UTF-8 BOM blanked column one; the Migration Hub started jobs for
> connectors that only exist as a stub that throws. All four fixed, ledger flipped to
> `proven` / `proven-pending-deploy`, campaign-check green 4/4, full `npm run verify` green
> (3338/3338 api tests).
>
> ⚠️ **Two things F17 leaves for whoever picks up next.** (1) **B205 is a NEW register entry**,
> not a miss: the Migration Hub's own products-CSV path still carries B98's class. A fix was
> written in F17 and **deliberately reverted** after adversarial review — routing `pricePerUnit`
> through a lenient parser turned a present-but-unparseable price from a loud `products.create`
> throw into a **silent $0.00 commit**, and `parseFloat` leniency admitted `-$5`/`12abc`on a
path that calls`ProductsService.create()`in-process, so the DTO never runs. It needs its own
batch with an e2e (no web unit runner). (2) **B99's repair flight is owed post-deploy**:`scripts/repair-f17.mjs`, fresh backup first, dry run, apply only exact-signature duplicate
> pairs.
>
> **F05 — driver at-door money and settlement (B49 Critical, B83, B148, B152, B167), PR #569.**
> The route-run payload never carried the billed line money, so five driver surfaces re-derived
> `qty × unitPrice` and over-collected ~`unitsPerBox` on every boxed stop — then posted that
> figure as `payment.amount`. **G7 landed:** `RUN_LINE_ITEMS_SELECT` is the single run-read
> lineItems select. ⚠️ **B148 gated everything else** — the mobile payload always sent
> `deliveries[].productId`, the DTO never declared it, and `forbidNonWhitelisted` 400'd _every_
> stop completion.
>
> **State (verified against the ledger at this commit, 2026-09-01): 47 of 193 closed — 45 `done`
>
> - 2 `already-fixed` LIVE (24.4%), plus B167 held at `proven-pending-deploy`. 145 queued across
>   22 batches, 11 Criticals still open** (B46 B48 B52 B53 B54 B55 B56 B58 B59 B128 B129).
>   Complete: F00+F01 enablement, F02 (9), F03 (9), F04 (3), F05 (5), **F06 (6)**, F17 (4), F30 (12).
>
> ⚠️ **B167 is NOT discharged — its post-deploy e2e is RED and the cause is the spec, not the
> product.** Run 33478558164: `23-run-settlement-note.spec.ts` fails strict mode because
> `getByRole("heading", {name: "Settlement"})` matched 3 elements — the spec's own fixture route
> was named `E2E B167 Settlement <suffix>`, so a substring name match selects the fixture's own
> `<h1>`, once per fixture a failed run leaked. **Fixed in this PR** with `exact: true` plus a
> comment saying why it is load-bearing, AND the fixture route renamed to `E2E B167 Run <suffix>`
> so no leaked fixture can ever match again (belt and braces — the rename came from closed #575).
> B167 stays `proven-pending-deploy` until a post-deploy run is actually green — do not discharge
> it on the strength of the fix alone.
>
> **This is the third instance of one pattern: a spec broken by data it or a sibling spec
> created** (OP-09c/OP-11b poisoned by spec 21's undeletable B24 fixtures; two specs shipped with
> no `playwright.config.ts` project entry; now this). When writing a T2 spec: never select on a
> loose name your own fixtures can match, never index into a list fixtures can enter, and add the
> `projects[]` entry in the same PR.
>
> ## Next up
>
> 1. **F05 unblocks the routes lane.** F10, F11, F12 and F22 all consume G7's
>    `RUN_LINE_ITEMS_SELECT` — extend that const, never re-inline the literal.
> 2. **F11 owes two gates F05 deliberately did not take** (Fable final pass): the CANCEL path and
>    `deleteRun` can still close/destroy a cash-carrying run unsettled. `settleRun` now accepts
>    CANCELLED post-hoc so the money is never stranded, but nothing forces the reconciliation on
>    those paths. `deleteRun`'s only guard is an existing deliveryMutation — which a
>    payment-only completion never creates.
> 3. Then the audited schedule: ~~F06~~ (✅ SHIPPED + fully discharged 2026-09-01: #573 master `e6d1ab34`, T1 flips #576, B62 discharge #577 off e2e run 33478558164 — all six rows done; residuals filed as B206/B207/B208, next free B209; ⚠️ that run also showed F05's OWN spec 23 REG-B167 red ×3 — flagged on #518, F05 owns it) → **F07 (NEXT on track A)** → F11 → F22+F24 → F16; F10, F09, F15, F13,
>    F14, F12, F17 (staged, artifacts committed), F19 → F20, F21 after F16, F25 → F26, F08,
>    Wave C, then F31.
>
> ## Owner-blocked (nothing I can do)
>
> - **Expo build** — F30's mobile scan fixes are merged but only reach devices via a build; the
>   server half is live and stricter, so old clients are safe meanwhile. Client retest after.
> - **GitHub Actions billing** for private minutes — until fixed, every CI green needs the repo
>   PUBLIC, which it already is per the standing directive.
> - **Final flip to private** when the campaign closes.
> - **RLS arming** (D3) stays parked at `prisma/deferred-rls/`; 15 tables still hold NULL-tenant rows.
> - **Policy-layer proposal** (artifact `b3592216…`) — four asks still open.
>
> ## Worktrees
>
> | Worktree                  | Branch                                                | State                    |
> | ------------------------- | ----------------------------------------------------- | ------------------------ |
> | main                      | `master` @ `e41a1e28`                                 | clean, green, deployed   |
> | rf-F05                    | `fix/F05-driver-at-door-money-settlement`             | **IN FLIGHT — PR #569**  |
> | rf-F06                    | `fix/F06-update-order-items-authorization-line-build` | MERGED (#573) — prunable |
> | rf-F03                    | `fix/F03-payment-truth`                               | MERGED (#564) — prunable |
> | rf-F17                    | `fix/F17-import-robustness`                           | MERGED (#566) — prunable |
> | rf-F30, rf-F04            | merged branches                                       | prunable                 |
> | rf-F02b, campaign-kickoff | merged branches                                       | prunable                 |
>
> Register artifact `310ae33a…` is CURRENT. The user-guide artifact `cae40575…` is
> shared-not-owned — guide changes must be flagged to the owner.

> </details>

**Written:** 2026-09-01 · **Visibility:** ⚠️ **PUBLIC by owner directive until the campaign completes** (do NOT flip private mid-campaign; the final flip is the owner's if the session dies) · **Campaign:** `W-serial (D6: merge as ready, no windows) · F00+F01+F02(9)+F04(3)+F30(12)+F03(9)+F17(4)+F05(5)+F06(6) SHIPPED LIVE AND FULLY DISCHARGED · 48/193 = 24.9% terminal, nothing mid-flight · in flight: F07 track A (claimed, board #520 — ⚠️ F06 filed B208 in F07's file region: honour STORED MANUAL overrides on the buyer merge, never client ones), F10 in the routes lane (claimed, board #523 — extend G7's RUN_LINE_ITEMS_SELECT, never re-inline; the CANCEL/deleteRun gates belong to F11, not F10)`. Owner delegations ACTIVE (.claude/campaign/DECISIONS.md D1–D6 + memory): Fable review replaces owner approval except system-harm/client-data risk; merge-as-ready any hour; repair-as-we-go per batch; repo stays public. ⚠️ Register debt SETTLED — keep it settled: every batch updates the register in its own close-out.

> **F05 ✅ SHIPPED (this PR):** driver at-door money truth + run settlement — **B49 (Critical), B83, B148, B152, B167**. No migration (F01's `settlementNote`/`settlementVariance` columns were already live and dead). **G7 delivered:** `RUN_LINE_ITEMS_SELECT` is now the single run-read lineItems select, carrying `subtotal`/`boxes`/`pieces`/`unitsPerBox` — **F10/F11/F12/F22 consume it; extend, never re-inline.** ⚠️ **B148 was the reachability blocker:** mobile always sent `deliveries[].productId`, the DTO never declared it, and the global `forbidNonWhitelisted` pipe 400'd _every_ stop completion — none of the money fixes were reachable until it landed. ⚠️ **The register missed the real settlement bypass:** RF-016 auto-complete inside `completeStop`/`completeWithPayment` flips a run COMPLETED in its own tx, so gating `updateRunStatus` alone would never have fired on the common path — all three paths now carry the predicate. B83 books over-collection as an `AdvancePayment` (`RUN:<runId>:STOP:<stopId>` reference — load-bearing, matched by prefix). Proof: 3339 api + 1383 mobile jest green, 26 review findings fixed across 2 rounds, mutation probe 6/6 caught + restore-verified, red gate properly red; B167 rides its T2 leg (e2e spec 23, project entry wired — `playwright test --list` shows 134 tests in 23 files). **Handed to F11:** the CANCEL path and `deleteRun` remain ungated for a cash-carrying run.

> **W1 ✅ SHIPPED 2026-08-30:** F00 = PR #545 → master `7e5c2d98`; deploy-signal E2E **proven
> live** (run started 21s after deploy SUCCESS; echo event self-skipped without cancelling);
> post-deploy 9/9 + feature-smoke green; measured Verify = 5m11s/run. ⚠️ **Actions billing still
> refuses private minutes account-wide** (0-step failures) — every CI green still needs a public
> window until the owner fixes Settings → Billing. F01 adds migration slot
> `20260908000000_campaign_schema_foundation` (additive only, 12 columns + 2 enum values across
> 8 models — see `.claude/pipeline/2026-08-30-campaign-schema-foundation/`).

> **F30 ✅ CLOSING (this PR):** the owner-reported mobile scan-loss cluster, B190–B201 (12 bugs,
> 13/13 + 1325 mobile green, campaign-check 12/12). Mobile: 4-slot scan gate, pending buffer,
> resolve abort, archived outcome, boxed-qty fold, synchronous wedge clear, never-silent offline
> drain (hook-level wiring test kills the escaped `notifyFailed` mutant — proven red under the
> mutation), iOS toast host, per-cart-session Idempotency-Key. API: replay + content-409 +
> first-key-wins on POST /orders, all-or-nothing diff-add, explicit-only replaceAll,
> denomination-aware atomic merge (MANUAL-only price survival), buyer scan endpoint.
> **Migration `20260910000000_order_idempotency` (additive) prod-applies BEFORE the merge.**
> Residuals recorded in the fix card: `POST /orders/sell` has no idempotency (candidate future
> register entry); single-slot key carry on multi-loser merges (Low, by design). Client retest +
> an Expo release are owed to the owner — the mobile half only reaches devices via a build.

## 🟡 ACTIVE — bug-register burn-down campaign (W1: F00)

Full plan: `C:\Users\nakram\.claude\plans\read-the-bug-registry-scalable-gosling.md` (28 fix
batches F02–F29 + two enablement batches F00/F01, ~30 PRs across 8 merge windows W1–W8; all
Criticals close by end of W6). Register: `local-assets/docs/routeflow-bug-register.html`
(**188 entries, 180 open** — B188 added 2026-08-31, see below; artifact
`310ae33a-f47a-4d67-876d-4f3c880200a5` — the old `da34f8d6…` URL is DEAD, never publish to it);
user guide artifact `cae40575-f391-4db3-b0c4-d3da779fcfba` (shared-not-owned — sessions cannot
republish it; flag guide changes to the owner).

**State of the machinery (all of it ships in the F00 PR, branch `fix/F00-ci-campaign`):**

- **Ledger seeded and tracked** — `.claude/campaign/status/F##.jsonl`, one shard per batch
  F00–F29, 180 rows (id / batch / frozen tier / state / pr / proof / evidence / roundSha).
  **B126/B127 are `already-fixed`**: shipped pre-campaign via PR #506 (master `cc8c7d46`),
  deployed, post-deploy-check 9/9 — evidence names the two #506 specs. That is F02a done;
  F02b (B24, B96, B101, B130, B154, B188) is not started.
- **`scripts/campaign-check.mjs`** — the unfakeable gate; now **wired into `npm run verify`**
  (step 3, before turbo), so every PR and the pre-push hook reconcile ledger claims against
  jest/Playwright JSON run artifacts. Proven to fail on synthetic bad claims and to pass the
  real ledger. Run artifacts go to `.campaign/runs/` (gitignored).
- **Citations re-anchored** — audit + per-batch attention list in
  `.claude/campaign/citation-reanchor-log.md` (1,176 checked against `6c8f1401`, 13 corrected
  in the register, 47 multi-candidate flags for per-batch discovery). Read it before any
  batch's discovery phase.
- **28 F-cards** at `.claude/pipeline/fix-cards/F##-<slug>.md` — each dev-pipeline run's brief;
  never re-read the register in a batch.
- **Decisions of record** in `.claude/campaign/DECISIONS.md` — D1: no web unit runner, web-side
  logic stays tier T2 (proven post-deploy via the e2e run); D2: B126/B127 stay `already-fixed`.
- **Board driver is on master** — PR #507 landed `scripts/team/team.mjs`, the `team` skill and
  the three agent roles, so fresh worktrees off master have the board. Campaign epics/batch
  issues: seed via `team.mjs epic/task` if not yet present.
- **B188 (added 2026-08-31, capability-model follow-up):** `generateInvoicePdf`
  (`apps/api/src/bookkeeping/invoice.service.ts:37-91`) reads AND writes `transaction` on a bare
  unscoped Prisma client — the missed sibling of the F1-002 fix. Dormant (the "invoices" Bull
  queue has no producer); routed to F02b, tier T1, cited fresh on `77b88623`. Plan prose says
  "179" — the ledger, not the prose, is `campaign-check`'s source of truth.

**⚠️ F00's merge is also the LIVE TEST of the `deployment_status` E2E trigger** (`2073d6be` —
untestable on a branch: GitHub only runs the default branch's copy for that event). After F00's
first master deploy, an "E2E (Playwright)" run must appear within ~20 min, or apply the
two-line revert spelled out in ci.yml's `on:` block. Also record F00's measured billed minutes —
it is the CI diet's proof.

**Then:** F01 (consolidated additive migration, slot `20260908000000_*` — backup first,
`prod-migrate.mjs` BEFORE the merge, per CLAUDE_SESSION_PREAMBLE.md), then Wave A batch loop:
worktree off master → dev-pipeline from the F-card → `REG-B###` proofs → ledger flip in the PR
→ `npm run verify` → merge train → register/guide update in the main checkout → republish.

---

## Pre-campaign history below (2026-08-24 through 2026-08-26)

## ✅ SHIPPED + LIVE 2026-08-26 window — NINE PRs merged, migration 20260905 applied, all deploys SUCCESS

Sequence executed: validated 12.15MB backup (126==126 CREATE TABLE) → migration
`20260905000000_customer_deposit_default` applied via prod-migrate.mjs → public window →
CI green per branch → serial rebase→hook-verify→merge pipeline → deploys SUCCESS → private
(read-back confirmed) → `post-deploy-check` GREEN → `feature-smoke` GREEN (write paths) →
demo reseed complete (59 orders / 51 invoices / 8 runs).

| PR   | What                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #438 | iOS invoice (PDF) share — lost-transient-activation retap recovery                                                                                                                                                                                                                                                        |
| #439 | Same for the CSV share path (retargeted to master BEFORE base delete — doctrine held)                                                                                                                                                                                                                                     |
| #440 | Idle super-admin cross-client 401 redirect hijack fixed; kills the /auth/refresh storms                                                                                                                                                                                                                                   |
| #441 | Purchase-orders list DTO coercion (`take:"20"` 500)                                                                                                                                                                                                                                                                       |
| #432 | repair-escaped-entities buyerAccount scoping via customerLinks + errorReason()                                                                                                                                                                                                                                            |
| #445 | **Buyer-connect auth hardening (HIGH)** — Google-merge squat hijack neutralized pre-link; email-change token/session revoke; roster-oracle redaction + request throttle; F3 audit script (owner runs read-only)                                                                                                           |
| #446 | **Tenant-scope findUnique sweep** — 79 sites / 23 files to findFirst; cross-tenant existence-oracle + data-echo closed; RULE recorded in the code map                                                                                                                                                                     |
| #442 | Customer-feedback batch phases 1+2 — address CRUD, agent quick-create, deposit defaults (migration `20260905`), due chips, qty-zeroing MONEY fix + zero-qty invariant, order-discount carried onto generated invoices, DELIVERED reopen + one-step-back demotions, delete-any behind the money gate, `deliveredOn` picker |
| #443 | `recurring_routes` / `order_delivery` split into independent addons; deploys dark                                                                                                                                                                                                                                         |
| #447 | demo-seed: clean route-stop rebuild on customer-map drift (found live during the reseed)                                                                                                                                                                                                                                  |

**Recovered from dead sessions before the window** (committed, rebased, hook-verified, then
merged above): the two uncommitted security batches (#445 — 24 files, #446 — 51 files) and
#442's fully-implemented phase 2 (21 files) — nothing from the interrupted sessions was lost.
Three cross-branch regressions the rebases introduced were caught by the hook gate and fixed
with specs (fulfillPath default-chain mocks, resolveDefaultTerms/deposit mocks, the
deleteOrder↔cancelImpact finder split).

## ✅ SHIPPED 2026-08-26 — #449 client-release-blockers (RESCOPED; CI green; deploy watched)

Plan `.claude/pipeline/plans/2026-08-25-client-release-blockers.md` rescoped: WP2/WP3
(customer address edit) SUPERSEDED — #442 phase 1's Addresses-tab CRUD already fixed that
defect. Built + merged as **#449**: **WP1** — order edits SETTLE stock (`settleStockForEdit`:
union deltas, product-row + Order-row `FOR UPDATE`, in-tx held snapshot, **delivered-clamp** —
negative deltas credit only the undelivered portion, so cancelling a delivered line no longer
inflates inventory; at-door approvals now settle too; specs a–j + at-door case, 253/253) and
**WP4-reduced** — EditTerms terms→dueDate linkage from the ISSUE date (the "Net 60 shows
Net 30" complaint) + `calendarDaysUntil` for the two remaining LOCAL-time badge sites
(`renderStatus`); helpers extracted to `web/lib/invoice-terms.ts`. Pipeline: Fable plan →
2 Sonnet implementers → Opus review (caught the delivered-clamp + stale-snapshot races) →
Opus fixer → hook verify + CI green → merged. **The bb-distro NO_GO verdict's three blockers
are now all closed** (terms↔date by #449, address edit by #442, stock settle by #449; the
badge −1-day survivor also by #449).

Same-day parallel session (from this session's task chip): E2E suite resurrection — all 5
red specs root-caused (4 REAL web bugs incl. a router.replace swallowing row clicks on all
13 list pages), PR #448 open — see memory `project_e2e_suite_resurrection_2026-08-26`.

## 🔴 OWNER ACTIONS (nothing else unblocks these)

1. **Fix GitHub billing** (Settings → Billing & plans) — Actions still refuses jobs outside
   free public windows; nightly regression red since 2026-08-22.
2. **Enable `driver_payments` for affa** (Admin → Tenants → affa → Addons) — until flipped,
   affa drivers 403 on at-door collection ($0/on-account unaffected).
3. After #443: assign `recurring_routes` / `order_delivery` per tenant as sold.
4. ✅ DONE 2026-08-26 via #450 (script connection fixed; first read-only run: 16 suspects,
   12 e2e fixtures, 1 reported). ~~Run the #445 F3 audit read-only:
   `railway run --service postgres node apps/api/scripts/audit-buyer-verification-grandfather.mjs`.~~
5. Google-key hygiene: restrict the new key to Geocoding + Places; delete stray project
   routeflow-489906.
6. E2E-on-master infra (task chip filed): the Playwright job's global-setup seed fails against
   the CI database; make the job meaningful again, then stop tolerating seed errors in
   `global.setup.ts`.

## ✅ SHIPPED + LIVE 2026-08-24 (evening) — #433 addon hygiene · #434 tobacco consolidation

Both merged, deployed (api/web/mobile SUCCESS), post-deploy green.

- **#433**: addon enable validates against the published catalog (400 + remedy); every toggle
  invalidates the entitlements cache; self-service allowlist (MSRP/SALES_AGENTS admin-only);
  6 vaporware admin toggles deleted; catalog **v11 published** (BUYER_PORTAL/SEAT_EXTRA/
  OCR_PACK_250/ROUTE_EXTRA/MSG_BUNDLE_500 retired); 7 inert TenantAddon rows deactivated;
  consistency probe: ZERO orphaned grants. Full evaluation: the Addon Truth Matrix artifact.
- **#434**: ONE regulated surface — /tobacco retired into the Regulated Items hub as the
  addon-gated 'Regulated compliance pack' (same tobacco_dealer key). Product.isTobacco is a
  write-synced mirror of Tobacco-type membership (un-flag PRESERVES the reg reporting trio).
  NO migration. **Byte-equivalence PROVEN**: demo July report identical pre/post-deploy.
  Backfill executed: routeflow-demo 16 + affa 66 mirrors healed, 0 conflicts, re-run clean —
  those 66 affa tobacco products were MISSING from compliance reports until now; regenerating
  any PAST affa period will now include them (owner decision before restating filed periods).
  Fresh validated backup: production_20260824_pre-tobacco-consolidation.sql (126==126).

Also 2026-08-24: sales-agents outage root-caused (catalog v10 was never published — published
same day) and demo fully seeded (2 agents, backdated rates, CST-2026-0001 approved + $700
partial payout). In-flight elsewhere: the ad-hoc order trips session (feat/adhoc-order-trips,
migration slot 20260904 claimed) — its runbook: prod migration BEFORE deploy; check
GOOGLE_MAPS_API_KEY exists on the prod API service.

## ✅ SHIPPED + LIVE 2026-08-24 (morning window) — #427 / #428 / #429 / #430

All four merged in ONE public window (public → squash-merge x4 → all three services BUILDING →
private confirmed → deploys SUCCESS → post-deploy-check GREEN). What landed:

| PR   | What                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #427 | Repair scripts: receiving-units (HIGH-signature + printed recompute-costs follow-up), escaped-entities, drift scan covers TRIAL                                                        |
| #428 | NSF bounce fees excluded from the commission base (shared NSF_FEE_DESCRIPTION_PREFIX; ratio deliberately conservative). Pipeline clean + Fable money-pass PASS                         |
| #429 | PR-D — full sales-agents & commissions UI (agent box, statements w/ stale-409 regenerate, order override, mobile row, e2e 18). Dark until the sales_agents addon is enabled per tenant |
| #430 | This handoff refresh                                                                                                                                                                   |

## 🔵 Enforcement is LIVE (2026-08-23)

`PLAN_FLAG_ENFORCEMENT=on` set on the API service by the owner, deploy `9090d918` SUCCESS,
`post-deploy-check` green. The audit script showed ZERO tenants lose anything. Kill switch
removal date stands: 2026-10-01.

## 🔵 Client-data repairs — exact sequence for the owner (#427 is merged; `git pull` first)

All from `C:/ClaudeCode/routeflow` (main checkout). Backups first where marked.

1. **bb-distro drift report** (works even BEFORE #427 via explicit slug):

   ```bash
   set REPORT_TENANT_SLUG=bb-distro&& railway run --service postgres node apps/api/scripts/report-receiving-unit-drift.mjs
   ```

2. **affa receiving repair** (client has reported the symptom; still take a fresh validated
   backup first): dry-run → review the printed plan → execute → run the printed
   `POST /inventory/recompute-costs` body as an operator.

   ```bash
   railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs --tenant=affa
   ```

   ```bash
   railway run --service postgres node apps/api/scripts/repair-receiving-units.mjs --tenant=affa --execute --confirm-tenant=affa --live-tenant-override
   ```

3. **bb-distro escaped-entities repair** (3 rows in the census; needs the client's explicit
   request + fresh backup): dry-run → execute, same flag pattern with `--tenant=bb-distro`
   via `apps/api/scripts/repair-escaped-entities.mjs`.

4. **PR-D rollout**: enable the `sales_agents` addon on `routeflow-demo` from platform-admin,
   exercise the agent box + a statement cycle there, then enable for the requesting client.

## ✅ SHIPPED + LIVE 2026-08-23 — the client-2 feedback batch (12 PRs, 3 prod migrations)

All merged, deployed, `post-deploy-check` green after every wave. Memory
`project_client2_feedback_batch_2026-08-22` holds the full per-PR detail.

| PR          | What                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #416 + #424 | Sale flow honours chosen terms/due-date; −1-day calendar rendering fixed everywhere (UTC-safe `fmtCalendarDate` web + mobile `lib/format-date.ts`; timestamps stay local)                                                                                                                                                                                            |
| #417        | Inventory RECEIVING converts boxes→pieces (Quick Restock + PO receive); silent under-receive clamp → loud reject; on-hand renders `N pcs (X boxes + Y pcs)`; read-only `report-receiving-unit-drift.mjs` stages the client stock repair                                                                                                                              |
| #418        | Three tier-blind edit paths now honour `Customer.pricingTier` (server `updateOrderItems` operator branch → SPECIAL never MANUAL; web order-edit add-item; web invoice-edit page)                                                                                                                                                                                     |
| #419        | Tenant-configurable tier names (`pricing.tierLabels` SystemConfig; `tierLabel()` triple-mirrored; settings card)                                                                                                                                                                                                                                                     |
| #414        | `StripHtml` no longer stores `&amp;`; supplier create refreshes every list (cross-invalidated query keys). Stored-`&amp;` repair still pending (read-only census script exists)                                                                                                                                                                                      |
| #420        | Plan-flag enforcement wired, **INERT** — `PLAN_FLAG_ENFORCEMENT` defaults off; audit script `apps/api/scripts/audit-tenant-entitlements.mjs` written for the owner to run BEFORE ever switching on                                                                                                                                                                   |
| #421        | Sales agents & commissions ENGINE (PR-C), **ships dark** (`flag.sales_agents` granted by no plan). Migration `20260901` APPLIED. Post-pipeline Fable review caught a CRITICAL (approve() blind to clawbacks = commission on bad debt) — fixed pre-merge                                                                                                              |
| #422        | Payment terms model: `Invoice.paymentTermsLabel` (label/due-date can never disagree — the INVARIANT), `Customer.defaultPaymentTerms`, `Supplier.defaultTerms`, `VendorBill.termsLabel`, deposit v1 (`depositPercent`/`depositDueDate`, derived amount via `roundMoney`, status/AR-aging untouched), narrow `PATCH /invoices/:id/terms`. Migration `20260902` APPLIED |
| #423        | Geocode on customer CREATE; `Supplier.lat/lng` + autocomplete; mobile `AddressAutocompleteInput`; **bonus: repaired the pre-existing broken mobile New-customer flow**. Migration `20260903` APPLIED                                                                                                                                                                 |
| #425        | Test-only: un-fused the commission/entitlements mock providers (the 2026-08-23 incident — see below)                                                                                                                                                                                                                                                                 |

**Prod backups** (validated, in gitignored `backups/`): pre-`0901`, pre-`0902`, pre-`0903` dumps.

> ⚠️ **Incident record (2026-08-23), lessons binding:** (1) `npm run verify | tail && echo MARKER`
> eats npm's exit code — NEVER gate on a marker after a pipe; capture the exit directly.
> (2) Keep-both conflict unions must respect object-literal boundaries — two provider hunks fused
> into one object gave duplicate `provide:` keys and JS last-key-wins silently dropped a DI mock
> (207 test failures, prod unaffected, fixed as #425). (3) Prod smoke green ≠ suite green.
> (4) After merging a schema-bearing branch into a worktree: `npx prisma generate` or tsc lies.

## 🔴 Owner queue

1. ~~Flag enforcement switch-on~~ **DONE 2026-08-23** — see the Enforcement section above.
2. ~~NSF-fee commission question~~ **SHIPPED #428 (2026-08-24)**.
3. ~~PR-D — sales agents UI~~ **SHIPPED #429 (2026-08-24)** — enable the addon per tenant (demo first).
4. **Client-2 data repairs** — scripts built (#427); exact command sequence in the repairs
   section above. Client sign-off + fresh backup before any `--execute`.
5. **Standing pre-batch items**: 600 product images (client review gate), returns §2.1 decision,
   costing + pack-size prod repairs (reports await sign-off), `test-tenant` identity question,
   layout audit batches L2–L6 (findings doc is machine-local under `docs/audit/`).

## Repo & tooling state

- **Heavy-files policy (owner, 2026-08-23)**: no images/videos/office binaries in git — evicted
  `docs/RouteFlow-v1.0.0-Documentation.{docx,pdf}` + `docs/screenshots/` (7.1MB, 54 files) to the
  machine-local, gitignored `local-assets/` (copies preserved at
  `C:\ClaudeCode\routeflow\local-assets\docs\`). History still carries the blobs; a
  `git filter-repo` rewrite is a separate owner decision. Mobile app icons stay (build assets).
- **dev-pipeline skill** gained `workdir` (worktree isolation baked into every agent prompt),
  `packages[].dependsOn` (no more fake file-overlap ordering), tiered `verifyCommands`
  (`perRound`/`final`), per-package `model`, and prettier-on-touched-files. A **Fable adversarial
  pass on money-critical diffs is a standing close-out step** — it caught #421's CRITICAL after
  3 Opus lenses + refuters passed clean.
- **Migration slots used**: `0831` MSRP · `0901` agents · `0902` terms · `0903` geocode. Next free:
  `20260908000000_*` (20260904/20260905/20260907 applied). One migration-bearing PR in
  prod-apply flight at a time; apply BEFORE merge.
- Worktrees/branches from the batch are pruned (or being pruned) — work in your OWN worktree off
  master, never `git add -A` in the shared checkout.

## Session mechanics (unchanged, still true)

Ship flow per CLAUDE.md (public window minimal, private flip is a `finally`, wait for `BUILDING`).
Local stack, prod DB access, e2e fixtures, RN-web driving, slow commits (240s), policy anchors:
see CLAUDE.md and the memory index — this file no longer duplicates them.
