# Code map changelog

Session-by-session history of code-map updates — **one dated bullet per session note,
newest first**. This file replaces the old habit of prepending each session's note into
`_meta.json` `"notes"` (which had grown to ~90K chars and made the file unreadable).

**Convention for new sessions:** add your note as a new bullet at the **top** of the list
below, and set `_meta.json` `"notes"` to that same note plus the pointer to this file —
never accumulate history in `"notes"`.

- **2026-09-13 — B323 tenant-scoping sweep fix, re-homed into the split map
  (`fix/B323-tenant-sweep` merge of `origin/master` 2e5602ae for PR #722)** — `sweepAllPendingOrders`
  now groups pending orders by `["customerId","tenantId"]` (not `customerId` alone), skips a
  null-tenantId group with a `logger.warn`, and wraps each group's `mergeAllPendingForCustomer`
  call in `this.tenantCtx.run(g.tenantId, ...)` — the cron/boot entry point has no ambient ALS
  scope, so `forTenant()` used to fall through unscoped and merged rows landed with
  `tenantId: null`. Row added to `api/feature-modules-2.md` (orders). Lesson L-124 appended to
  `LESSONS.md` (cap raised to 48/49,152 to match master #717; L-123 stays reserved for the W1
  billing PR).
- **2026-09-13 — F39 wallet/invoice lost-update batch, re-homed into the split map
  (`fix/F39-wallet` merge of `origin/master`)** — B310 (`customers.service.ts
applyAdvancePaymentToInvoice` wraps its locked body in a customer-keyed `withAdvisoryLock` +
  `FOR UPDATE` on the target invoice — wallet double-spend), B311 (`invoices.service.ts
recordStandalonePayment`'s buyer/online overpay guard now takes a single id-sorted `FOR UPDATE`
  over every allocation's invoice before the loop), B314 (`revertInvoiceToDraft` /
  `revertLinkedInvoicesForOrderEdit` exclude VOID payments from the revert-block count), B315
  (`credit-notes.service.ts settleOrderCreditsInTx`'s SHRINK pass restores an excess-applied
  ADVANCE via one atomic `LEAST(...)` UPDATE — no read-modify-write), B312
  (`bookkeeping.service.ts recordPayment` refuses a VOID/WRITTEN_OFF invoice), B313
  (`components/CustomerRecordPaymentModal.tsx` gains `clampAllocationInput`, mirroring mobile's
  existing clamp). api.md: rows added to `api/feature-modules-1.md` (customers), `-3.md`
  (invoices, credit-notes), `-6.md` (bookkeeping); web.md: `web/routes-1.md` (customers page).
  Lesson content re-numbered L-118→**L-122** on merge (master had already spent L-118/L-119 on
  the F38 batch); L-120/L-121 stay reserved for the W1 billing PR.
- **2026-09-13 — #712 bookkeeping (`docs/712-bookkeeping`, master `bc36a0dd`)** — B389/F12-003:
  mobile's web-export runner swaps `nginx:alpine` (root) for `nginxinc/nginx-unprivileged:alpine`,
  ends on `USER nginx`, moves the listen port 80→8080 (`PORT` default 8080); new tripwire spec
  `apps/mobile/__tests__/dockerfile-nonroot.test.ts` asserts the runner stage, last `USER`
  directive, `EXPOSE 8080`, and `${PORT:-8080}` on the Dockerfile's text. api/infra-hardening-sec-2.md
  F12-003 bullet extended; mobile.md gains one bullet (`Dockerfile` + `railway.toml`). No
  transferable lesson (L-113 class, Dockerfile-only).
- **2026-09-13 — F38 driver at-door money / offline close-out / run linkage (`docs/710-bookkeeping`,
  Option-B follow-up for PR #710 = master `14048230`)** — B305 (driver at-door amount due is now
  the order's open DRAFT invoice(s), never `Order.total` or a raw line sum — `RUN_STOP_INCLUDE`
  exported + projects subtotal/tax/total/discountAmount/shippingFee/customer.isTaxExempt/open
  drafts, `RUN_LINE_ITEMS_SELECT` +`categoryTaxAmount`; mobile `run-money.ts` gains
  `orderAmountDue`/`stopAmountDue`/`deliveredCategoryTax`/`reconciledAmountDue`; round-4 seam fix
  `df635fdb` added `shortPickCategoryTax` so the short-pick door quote's subtotal and category-tax
  halves derive from ONE line set, fenced by a source-pin test on `payment.tsx`); B306 (a
  RUN-tagged over-collection `AdvancePayment` is now reversible — new
  `invoices.service.ts#reverseRunAdvancesInTx`, called by `voidPayment` and by
  `routes.service.ts#reopenStop`; `getRunCashCollections`/`enrichRunsWithCollectedPayments`
  exclude `:REVERSED` references); B307/B308 (an offline-queued mutation now reads as success —
  new `lib/offline-errors.ts#classifyMutationError`, `returns-logic.ts#summarizeSubmissions` gains
  a `queued` bucket, wired into `payment.tsx`/`NewOrderScreen.tsx`/`return/index.tsx`); B309 (a
  DRIVER may only link an order to a stop on their own in-progress run via `orders.service.ts
create()`'s DRIVER branch; the CUSTOMER branch now refuses any run linkage outright). api.md:
  3 rows (`routes/`, `invoices/`, `orders/`); mobile.md: 2 rows (`(driver)/` run-money +
  offline-errors); web.md/packages.md untouched (no diff). Registry rows B305–B309 closed; lesson
  candidate (two halves of one money figure must derive from ONE line set — a cross-file seam is
  invisible to per-file review) queued for the lessons register.
- **2026-09-13 — #704 bookkeeping (`docs/704-bookkeeping`, Option-B follow-up for #704 = master `2d353752`)** — registry tooling from the `security-registry-tags` run: `scripts/campaign/bugs.mjs` gains `--tag` on `file`/`move` and the `already-fixed` ledger state (one transition with pr+evidence, replay refused); `scripts/campaign/plane-sync.mjs` maps tags → Plane labels (R8: lazy read-only resolution, `labels: []` clears on removal, key omitted only when nothing resolves, sorted-tag join in the hash) with self-test T8; `.claude/skills/bug-registry/SKILL.md` gets a `## Security findings` section; `docs/audit/security-findings-index.md` gets a Registry column; `docs/security/security-testing-program.md` §7 points at the registry. Registry rows filed: F48 (B355–B360) + F49 (B361–B393, `already-fixed`). INDEX.md rows "Bug catalogue + agent fix carve-out" and "Plane BUGS mirror" extended; the api.md section is still deferred (api.md is over the 1,024 KiB pre-commit cap until the area-file split on `chore/workflow-redesign` lands); web.md/mobile.md/packages.md untouched (no diff). Same PR: true-telemetry ledger row ($31.12), RUN-LOG entry, B349 owner-ruling note (HKDF from `JWT_SECRET`), lesson L-117 (L-110/L-111 archived). R10's `CONTEXT.md` one-liner is deferred to the `chore/workflow-redesign` landing (the file is not on master).
- **2026-09-12 — vendored house pipelines + DI-scope boot guard (`chore/vendor-house-skills`)** — `.claude/skills/{dev-pipeline,bug-pipeline,model-routing,lessons-learned}`, code-map refs and `.claude/commands` copied repo-relative (engine + machinery byte-identical, `.prettierignore`), `scripts/validate-code-map.mjs` vendored (unwired: INDEX 682 KB > 20 KB cap), `common/app-module-compile.spec.ts` compiles the real AppModule graph (red on the W16 CrmModule shape), `test/__mocks__/invoice-template.js` + moduleNameMapper. INDEX +2 rows; api.md entry deferred (1,182 KiB > 1,024 KiB pre-commit cap) until the area-file split lands.
- **2026-09-12 — #703 hotfix bookkeeping (`docs/703-crm-di-bookkeeping`, master `e96c405b`)** — `crm/crm.module.ts` imports `BillingModule` (the #702 module shipped without it: `AddonGuard` → `AddonService` unresolvable at InstanceLoader, prod API 502 for 26 min in window 16; boundary-mocked specs, lint and tsc were green). New repo-truth spec `common/addon-guard-module-import.spec.ts` fails the build for any `AddonGuard` controller whose registering module lacks the import (red 1/12 on the pre-fix tree, green after). api.md: one row. Lessons: L-115 appended (testing), L-041 archived for headroom.
- **2026-09-11** — (branch `fix/train4-order-idempotency-key`, train 4 Run B, **B215**; map + lesson land
  IN-PR per the 2026-09-10 owner ruling, base `70d15a87`) — **the staff-merge replay store is now a
  per-request key ROW, and a replay re-runs the convergent post-fold tail.** The old store was the single
  first-key-wins `Order.idempotencyKey` column, so a later merge wave's key was silently dropped and its
  retry folded the cart AGAIN (the fold writes ABSOLUTE totals ⇒ the order inflated). NEW model
  **`OrderIdempotencyKey`** in `prisma/schema/sales.prisma` (migration `20260911000000_order_idempotency_key_table`,
  additive: `@@unique([tenantId, key])`, `@@index([orderId])`, `responseHash`, order FK `onDelete: Cascade`,
  `Order.mergeIdempotencyKeys` back-relation) — mapped `sales` in `split-prisma-schema.mjs`'s `MODEL_DOMAIN`,
  added to `apps/api/scripts/apply-rls.js`'s `TENANT_TABLES` (the step that actually arms RLS in prod, missed in
  the first pass) and to the parked `prisma/deferred-rls/20260909000000_rls` arrays. NEW pure module
  **`apps/api/src/orders/merge-idempotency.ts`**: `mergeRequestHash({customerId, items?, appliedCreditNotes?})`
  (sha256 over canonical JSON; BOTH lists stable-serialized then SORTED, so neither's wire order can turn an
  honest retry into a cart mismatch) and the error-code const `IDEMPOTENCY_KEY_CONFLICT`.
  `orders.service.ts`: `recordMergeIdempotencyKey(tx, orderId, {key, responseHash})` writes the row inside the
  FOLD's own transaction (P2002 ⇒ 409 aborting the fold); `updateOrderItems`'s 4th arg
  `opts?: { idempotency? }` is passed only when a key exists; `findOrderIdByIdempotencyKey(key, customerId,
requestHash?)`'s lookup order is now **key table (this customer) → this customer's Order column → tenant-wide
  key-table refusal** — the column read MUST precede the tenant-wide check, or a legitimate replay of the
  caller's own key 409s whenever any other customer holds a key row; both 409s carry
  `{code: IDEMPOTENCY_KEY_CONFLICT, reason: "CART_MISMATCH"|"HELD_BY_OTHER_ORDER", orderId, message}`. The
  post-fold tail was extracted to private **`reconcileOrderAfterEdit(orderId, customerId, appliedCreditNotes,
{postDeliveryEdit, skipInPlaceResync})`** (invoice resync / draft reconcile + the Serializable credit
  sync+settle) with public **`replayMergeReconcile(orderId, customerId, appliedCreditNotes)`** called from the
  controller's merge branch on its `replayed: true` path, still inside the customer advisory lock — the status
  event and `appendOrderRevision` stay fold-only (append-only, not convergent), and a replay passes
  `skipInPlaceResync: true` because the pre-edit cumulative `invoicedQty` the partial-billing guard needs is gone
  by then. `create()` and its P2002 recovery both route through private `findReplayCandidateByKey(key)` (table
  first, column fallback), so a keyed merge that fell through to `create()` replays instead of minting a
  duplicate. `POST_DELIVERY_EDIT_STATUSES` is now one module const read by both callers.
  **Schema-spec collateral:** `schema-folder.spec.ts`'s model-count pin 125 → 126 and its **case (h) RETIRED** —
  it asserted the folder still block-identical (207 blocks) to the retired single `schema.prisma` at `e39bf9db`,
  a one-time split-time proof that no block count can satisfy once the folder legitimately gains models (208 vs
  207), and it `it.skip`ped itself on a depth-1 CI clone anyway; the standing lossless guard is
  `apps/api/scripts/schema-drift.mjs` (`npm run local:drift` / the CI db-migrations replay). `CLAUDE.md`,
  `no-single-schema-path.spec.ts`, `split-prisma-schema.mjs`'s header and `docs/IMPROVEMENTS.md` say so too.
  **Mobile (`mobile.md`):** `NewOrderScreen.tsx` rotates the cart-session submit key on a REAL customer switch
  (a `keyCustomerIdRef` stamped in `onChangeCustomer`, compared in `onPick` — re-picking the same customer keeps
  its key) and its submit `onError` gained an `IDEMPOTENCY_KEY_CONFLICT` branch offering "Open order" (navigate
  by the body's `orderId`, reset the key, retire the bound draft) instead of wedging on a bare message;
  `lib/order-submit-key.ts`'s doc comment lists the switch as reset condition (3).
  **Tests:** `orders/orders.merge-idempotency.spec.ts` (REG-B215 T1-T17 + pins P1-P5, incl. T2b reconcile-on-replay
  - no-revision, T11b credit-set order-insensitivity, T16 `create()`'s key-table replay, T17 the lookup order)
    and the DB lane `orders/order-idempotency-key.db.spec.ts` (D1-D4, PD1-PD3 against real Postgres; D3 = the
    pre-fold refusal, D4 = the in-tx P2002 rollback). Lesson **L-104** appended (domain), **L-099** archived for
    headroom. api.md/mobile.md updated; web.md/packages.md untouched (no diff there).
- **2026-09-11** — (WP3, DECIDE-29/OPS-23 Google sign-in monitor, small dev-pipeline run) —
  INDEX.md gains a "Where to find" row for the new `scripts/lib/google-signin-check.mjs`
  (`checkGoogleSignIn`/`checkApexDns`) + its self-test, the `scripts/post-deploy-check.mjs`/
  `scripts/smoke.mjs` Google-door sections, `scripts/google-signin-monitor.mjs`, and
  `.github/workflows/google-signin-monitor.yml`; new runbook
  `docs/runbooks/mandatory-dependencies.md` (Google OAuth client + apex DNS, break-glass, no
  secrets/uuids/client ids). api.md/web.md/mobile.md/packages.md untouched (no diff there). Round-1 Opus corrections are in the row too: `decodeAuthError` (URL-first classification off the base64url `authError` param — the ~800 KB error page has no marker in the 64 KB body window), a POSITIVE-signal requirement for `ok` (else `unexpected_page`), the Google/Apex sections HOISTED above post-deploy-check's login gate (now 2/3; Login..Divergence 4-7), and `finalPage` (origin+pathname) as the only form a caller may log.
- **2026-09-12** — (branch `feat/plane-harness-learning`, in-PR bookkeeping, WP3 of
  `.claude/pipeline/2026-09-12-plane-learning/`) — new `scripts/campaign/plane-doctor.mjs`
  (`npm run plane:doctor` / `-- --offline`): one-shot harness health check, one
  `PASS`/`WARN`/`FAIL <name>: <detail>` line per check (knobs, denylist, `--help` on all six
  plane-\*.mjs tools, `.claude/settings.json` SessionStart+Stop hooks, `package.json` `plane:*`
  scripts + `verify` wiring, `.gitignore` coverage, the skill file's size cap, Gate 5's
  `--max-writes`/never-`--allow-branch` argv shape, the machine-local scheduled-task file
  WARN-only, `local-assets/plane/ops/` WARN-only; online: `projects/` identifiers, the
  `runs.jsonl`-vs-`.claude/campaign/status` "landing without sync" WARN, and an on-master-only
  `plane-sync --check` drift WARN), exits 1 iff any FAIL, never a write, `--json` shape, one
  `appendRun()` telemetry line per run (skipped for `--help`). New INDEX.md row (**Plane
  learning — doctor**) alongside the existing Plane harness v2 rows. Coverage: new
  `scripts/campaign/plane-doctor.self-test.mjs` — spawns a byte-for-byte copy of
  plane-doctor.mjs + plane-client.mjs dropped into a scaffolded temp repo (its own
  `package.json`+`.claude` marker, `--help`-only stub tools) since this file's offline checks
  resolve every path via `repoRoot()`, never an env override; covers the T3 oracles (all-PASS
  fixture, SessionStart-hook-missing FAIL, scheduled-task-absent WARN, 5-project online PASS
  within the 3-GET budget, landing-without-sync WARN via a real `git init` + old `runs.jsonl`
  line + a newer status commit, no-key WARN-skip, `--json` shape, telemetry shape, and the
  Gate-5 comment-vs-code `--allow-branch` distinction), all green. plane-retro.mjs (WP4) and
  the `package.json`/`verify` wiring (WP5) are owned by sibling work packages in the same PR —
  until they land, this repo's own `plane-doctor.mjs --offline` correctly FAILs on `help`
  (`plane-retro.mjs (missing)`) and `package` (`missing scripts: plane:doctor, plane:retro`),
  which is expected mid-PR, not a defect in this file.

- **2026-09-10** — (branch `chore/next-15` #5b3b3c4e = master, Option-B follow-up) —
  `apps/web` upgraded Next 14.2.35 → 15.5.25 (React 18 → 19.2.0, eslint 8 → 9); clears the two
  CRITICAL npm-audit advisories the owner had allowlisted through 2026-09-30
  (`security/audit-allowlist.json` now `entries: []`). Sixteen `[id]`-style dynamic Client
  Component pages converted `{ params }` to `useParams()`; `customers/[id]/page.tsx`'s Suspense
  wrapper reads it once and passes `id` down to `CustomerDetailPageInner` as a plain prop;
  `finance/expenses/page.tsx` (a Server Component redirect stub) now `await`s its `searchParams`
  Promise. Removed: the React-18-pin Dockerfile hack (`npm install --force --no-save
react@18.3.1…`) and its `jest.config.js` `moduleNameMapper` twin — one repo-wide React 19 now.
  `apps/web/.eslintrc.json` deleted (Next 15's `next lint` discovers the pre-existing flat
  `eslint.config.mjs` first; that file drops `next/typescript` from its `compat.extends()` — it
  was never actually linted with that ruleset under Next 14, and adding it now surfaces ~360
  new errors, a separate piece of work). `apps/web/tsconfig.json` `target` pinned to `ES2017`.
  `@next/eslint-plugin-next`'s `no-html-link-for-pages` became App-Router-aware in v15 (v14 only
  matched `pages/` routes); three pre-existing, deliberate plain `<a>` cross-context navigations
  (login → buyer portal, inventory's restock modal → vendor-bills, buyer-invite → buyer portal)
  are newly flagged and silenced with an inline `eslint-disable-next-line` plus a comment — not
  converted to `<Link>`, since two of the three deliberately force a full-page reload to
  re-bootstrap the buyer auth context.
  Four new `apps/api/src/common` repo-truth specs (`next-version`, `no-react-skew-hacks`,
  `client-page-params`, `audit-allowlist-retired`) joined the repo-truth lane
  (`jest.repo-truth.config.js` testRegex, `apps/api/package.json`'s main-lane
  `testPathIgnorePatterns`, `turbo.json` `test:repo-truth` inputs, `turbo-inputs.spec.ts`'s
  `REPO_TRUTH_SPECS` array) — new API script `smoke:pdf` (manual, real-render PDF smoke against
  compiled templates) is NOT part of that lane (no map-tracked automated wiring; run by hand).
  `docs/testing/lockfile-edges.md`'s "Unsatisfied peer ranges" count: 2 → 0. `web.md`, `api.md`
  updated (see their bullets above); `mobile.md`/`packages.md` untouched (confirmed no
  apps/mobile/packages diff). Lessons: L-103 appended (tooling, compose `-p`/container-name
  trap); L-083 and L-062 amended in place (turbo-cache-replay pre-push trap; repo-truth
  main-lane-exclusion simultaneity) rather than adding two more new entries — see
  `.claude/lessons/`'s own follow-up. L-102 archived for headroom (the only entry in the active
  40 cited nowhere outside `.claude/lessons/**`/`.claude/code-map/CHANGELOG.md` — every other
  active entry is cited from a code-map area file, `HANDOFF.md`, `tools/bugflow/docs/**`, or
  real source, disqualifying it under the standing rule; see `archive.md`'s grep evidence).

- **2026-09-09** — (branch `docs/686-campaign-web-report-bookkeeping`, Option-B follow-up for
  #686/`ff581ce4` + #685/`0c1bc2d6` = master) — `scripts/campaign-check.mjs` now reads
  `apps/web`'s Jest campaign report (`.campaign/runs/web.json`, wired via
  `apps/web/jest.config.js`'s `reporters` block, `{ artifact: "web" }`), closing the gap where
  REG-B### pins living in apps/web were invisible to the gate ("no test titled with REG-B##
  found", #683). Guard: `apps/api/src/common/campaign-check-web-report.spec.ts`. `INDEX.md`'s
  "Bug-register burn-down campaign" row, `api.md` (new spec bullet), and `web.md`'s Jest section
  updated. #685 is a Dependabot minor-and-patch group bump (17 bumps) with no map impact.
  Lessons: L-102 appended (tooling); L-092 archived for headroom (oldest untouched no-guard
  entry, grep-confirmed no citations outside the register/pipeline/code-map bookkeeping files).
- **2026-09-09** — (branch `docs/wave-2026-09-09-bookkeeping`, Option-B FINISHING for the merged
  wave: train 1 `fix/train1-driver-teardown` #681/`8de65863`, train 2
  `fix/train2-operator-gaps` #682/`7d8141e0`, `test/reconcile-pins` #683/`f9f36075` = master —
  mapped at `f9f36075`). Replaces the prior PREP session's placeholder design note (below) now
  that the code exists on master; `mobile.md`/`api.md` gained real dated sections in place of
  that note. **Train 1 (mobile driver session teardown + POD persistence, B111/B136/B137/B140/
  B150, batch F19), landed in `mobile.md`:** `lib/session-teardown.ts` `teardownUserSession
(options?: {reason?, userId?})` — called by `useAuthStore.logout()` BEFORE `apiLogout()` and by
  the session-expired path; resolves the outgoing user id first, stops background location for
  both realms unconditionally (B150), cancels + clears the shared `lib/query-client.ts`
  `queryClient` (B140), resets all 7 user-scoped stores, then deletes the two persisted blobs
  (`POD_STORE_NAME`/`RUN_SETTLEMENT_STORE_NAME`) via new `lib/user-scoped-storage.ts`
  `clearUserScopedStorage` (a late `persist` write can otherwise resurrect the cleared capture in
  the anon bucket); the offline queue and tenant store are deliberately untouched. New
  `lib/session-hydrate.ts` `rehydrateUserScopedStores()` is the sign-in counterpart (both stores
  now `skipHydration: true`, keyed by user id). New `lib/pod-reconcile.ts`
  `pendingPodArtifacts`/`artifactIdsFromPodPhotoUrls` (pure) fix the duplicate-append (B111/B136).
  New `lib/queue-identity.ts` stamps every `offlineQueue` entry with `{userId, tenantId}`; drain
  skips an entry stamped for a different user, filing it under `failedActions` with reason
  `different-user` (B137). **Train 2 (B04 push toggle, B142 archived SKUs, batch F20), landed in
  `mobile.md`/`api.md`:** new `lib/notification-prefs.ts` `getPushEnabled`/`setPushEnabled` via
  `/users/me/preferences`'s `pushEnabled` key (same shape as `locale`); the operator settings push
  switch binds to it; `ProductPickerSheet.tsx` gains an opt-in `activeOnly` prop (`isActive: true`
  only when set) used by the order-item add path, unfiltered elsewhere. `api.md`:
  `notifications.service.ts`'s new `isPushEnabled(userId)` gate skips `registerToken`'s upsert and
  `sendToUser`'s delivery for a disabled user (server-authoritative, REG-B04-C/D);
  `orders.service.ts`'s `create()` and `updateOrderItems()` both reject a NEW archived-product
  line (`create()` exempts the driver change-request draft path via `options.allowArchived`);
  `recurring-invoices.service.ts`'s `buildArchivedItemsNote` deliberately never blocks generation
  — appends a note instead (billing must never pause on a catalog flag). **Registry:** F19
  (B111/B136/B137/B140/B150) proved + discharged on #681 (siblings B01/B02 and already-done B143
  untouched); F20 (B04/B142, plus B151 already proven via #555) proved + discharged on #682
  (siblings B32/B23/B94/B95/B172 untouched); F33 (B35/B123/B124/B125/B203) proved + discharged on
  #683 — batch now 6/6 done incl. already-done B204; F02 (B126/B127, `already-fixed`) proved +
  discharged on #683 — batch now 9/9 done. B282 (filed by the PREP session, unbatched — interactive
  invoice/estimate create still accepts a new archived line, money-touching carve-out) is
  unaffected by this wave, still awaiting `@tech-lead` batching. `bugs.mjs sync --check` and
  `node scripts/validate-lessons.mjs` both green after the above.

- **2026-09-09** — (branch `docs/wave-2026-09-09-bookkeeping`, Option-B PREP for three code PRs
  not yet opened: train 1 `fix/train1-driver-teardown` [`681`/`8de65863`], train 2
  `fix/train2-operator-gaps` [`682`/`7d8141e0`], `test/reconcile-pins` [`683`/`f9f36075`] —
  mapped at `1dca1242`, unchanged; none of the files below exist on this sha yet). **Train 1
  (mobile driver session teardown + POD persistence, B111/B136/B137/B140/B150, batch F19) design,
  entered into `mobile.md` ahead of the PR so the map is ready the moment it merges:** new
  `lib/session-teardown.ts` `teardownUserSession({reason})` — called by `useAuthStore.logout()`
  BEFORE `apiLogout()` and by the session-expired path; stops background location (both realms,
  idempotent), marks the offline queue's owner (no flush), `queryClient.clear()` via a new
  `lib/query-client.ts` exported accessor (`_layout.tsx` imports it instead of holding the
  module-scope client), and resets `podStore`/`runSettlementStore`/`mileageStore`/`routeStore`/
  `delivery-plan-store`/`listUiStore`/`productPickerStore` (each gains `reset()`); tenant store
  untouched by design (shared-tablet branded login survives sign-out). New `lib/session-hydrate.ts`
  is the sign-IN-side counterpart (reconciles `podStore`/`runSettlementStore` against a stop's
  existing `podPhotoUrls`/artifact ids on relaunch — B111/B136 fix). New `lib/pod-reconcile.ts`
  holds that reconciliation as a pure function (no duplicate artifact append for an id already on
  the stop). `store/offlineQueue.ts` gains per-entry `{userId, tenantId}` stamping; drain skips
  entries stamped for a different user, moving them to `failedActions` with reason
  `different-user` (B137). Operator home's sign-out routes through the same
  `teardownUserSession()` (B150 asymmetry fix). **Train 2 (B04 push toggle, B142 archived SKUs,
  batch F20) design, entered into `mobile.md`/`api.md`:** new `lib/notification-prefs.ts`
  (get/set `pushEnabled` via `/users/me/preferences`, same shape as `locale`); the operator
  settings push switch (`(operator)/settings/index.tsx`) binds to it instead of local state;
  `lib/auth.ts` login registration gated by the preference; toggle-off deregisters the device
  token. `ProductPickerSheet.tsx` gains `isActive: true` on its query (web parity, B142) while
  stock-count/PO-receive/variant-parent callers keep the unfiltered query. `api.md`:
  `notifications.service.ts` send path gains an `isPushEnabled`-style filter (skip tokens whose
  user has `pushEnabled === false`), `registerPushToken` no-ops when disabled;
  `orders.service.ts` `updateOrderItems`'s `addProductIds` hook (already NEW-lines-only) gains an
  archived-product guard (`BadRequestException`), mirrored at staff/buyer order create and
  interactive invoice/estimate create — batch paths (recurring generation, estimate→invoice
  convert, templates apply) deliberately ALLOW and append a warning note instead (billing must
  never pause on a catalog flag) — recurring's own cron note in `api.md` gets a cross-reference.
  Registry: B111/B136/B137/B140/B150 (F19) and B04/B142 (F20) got their analysis sections
  written this prep step (no batch discharge yet — PRs are placeholders); B151 (F20) proved on
  `#555`/`REG-B151`; B35/B123/B124/B125/B203 (F33) and B126/B127 (F02) got pin-title notes for
  `test/reconcile-pins`; B282 filed unbatched (interactive invoice/estimate create still accepts
  a new line for an archived product — train 2 review finding, money-touching carve-out). Lessons:
  L-101 added (domain, sign-out teardown contract); L-094 archived (only clean entry by the
  standing repo-wide-grep rule — see `.claude/lessons/_meta.json`). Finishing commands (real
  PR numbers, `prove`/`discharge`, and the mobile.md/api.md signature-level entries once these
  files actually exist) are in `.claude/pipeline/2026-09-09-wave-followup/FINISH.md`. **The
  bullets above describe the PLANNED shape of files that do not exist on `1dca1242` — treat them
  as a design note, not a signature index, until the next session confirms the merged code and
  replaces this bullet's mobile.md/api.md references with real entries at the real sha (DONE —
  see the bullet above).**

- **2026-09-09** — (branch `docs/numbering-group-a-bookkeeping`, Option-B bookkeeping follow-up for PR 678, mapped at `1dca1242`) — **Numbering siblings Group A mapped: B267/B268/B269 fixed, B277 pinned.** `api.md` gains a new bullet right after the B100/F16b primitive entry documenting: `numbering.service.ts`'s `YearScopedDocType` widened with a literal `CREDIT_NOTE` branch (no data-driven map, per `fix-round-2b.md` finding (2)); `credit-notes.service.ts create()` reserves `reserveNext("CREDIT_NOTE", {year, tenantId})` STANDALONE ahead of its SERIALIZABLE tx (an in-tx reservation there aborts under concurrency, P2034, rather than waiting); `invoices.service.ts` gains a shared `nextPaymentNumber(tenantId)` helper closing the `PAY-####`-vs-`PAY-<tenantShort>-####` cross-tenant collision at the batch-allocation/settlement site (`payment-requests.service.ts writeSettlement`) that could permanently stall a Stripe redelivery; `import.service.ts` fallback (source-numberless) rows now reserve through the same service instead of a from-1 local counter, and the "existing invoice → update it" branch is scoped to source-numbered rows only (B268 was worse than filed: it silently overwrote a live invoice's status/dueDate/paidAt, not a swallowed P2002); `estimates.service.ts create()` gains the P2002→409 pin matching its siblings (B277, refuted as a live repro, zero-risk consistency fix). Group B (B270 vendor bills/B271 purchase orders/B272 commission statements) stays deferred — needs a `DocumentNumberType` enum migration + owner ack. New DB-lane specs: `credit-note-numbering.db.spec.ts`, `payment-numbering.db.spec.ts`(+`-pins`), `import-numbering.db.spec.ts`(+`-pins`). **Registry:** B267/B268/B269/B277 moved into new batch **F31** (T1×3 + T2 B277), all six analysis sections filled from `cause-ruling.md`/`cause-refutation.md`/`bug-test-plan.md`; this same follow-up ran `prove B267/B268/B269 --pr 678` and `discharge F31` (3 rows → done). B277 was held out of the batch discharge on purpose: it is a refuted-as-repro pin that must never carry a `REG-` token (L-100), and `bugs.mjs prove` hard-requires the literal `REG-<id>` substring in `--proof`, so it cannot express a token-less claim — closed by hand instead as `state: refuted` with a non-empty `evidence` field, matching campaign-check's `EVIDENCE_ONLY_STATES` contract (`already-fixed`/`refuted`/`regressed`), which needs no test search. **B281** filed unbatched (low, money-sensitive, auto-classified) for the sibling finding from the same final pass: a later upload whose own source `Invoice Number` collides with a fallback-minted `INV-<year>-####` still overwrites that unrelated invoice. Lessons: **L-100** appended (domain — mint every document number through `NumberingService.reserveNext` with `tenantId` explicit, reserved standalone before any rollback-capable transaction, P2002→409 + bounded serialization retry that reuses the reserved number); **L-092** (2026-09-08, testing, `#657`, oldest untouched `no in-repo guard`-class entry after L-038's prior archival) archived for headroom, grep-confirmed clean of citations outside `.claude/lessons/**`/`code-map/CHANGELOG.md`. Register back to 40/40, 39.6/40.0 KB, archived 56, nextId 101. `node scripts/validate-lessons.mjs` exit 0. **Separately, an 11-row registry reconciliation** (evidence: an independent sweep of previously-filed Highs/Crits against master) folded into the same follow-up: **B126/B127** were already `already-fixed`/`closed: yes` in F02 (PR #506, `cc8c7d46`) — confirmed, no action needed. **B138** (F14, T2) was stale at `proven-pending-deploy` — its server-side fix shipped live in `#598` (`24421170`) and its companion jest (`REG-B138` in `auth.controller.cookie.spec.ts`) already passes; re-proved with `--pr 598`, then hand-patched to `done`/`closed: yes` (mirroring `discharge`'s own write shape — `state`, `dischargeEvidence`, `evidence`, record front matter, History line) rather than running `bugs.mjs discharge F14`, which would have forced sibling **B155** (still legitimately `proven-pending-deploy`, out of this reconciliation's scope, its own e2e leg also quarantined) past the T2 per-row evidence rule. **B35/B123/B124/B125/B203/B204** were unbatched (`uncampaigned`) — moved into a new batch **F33** (T1, `--why "reconciled: fixed on master before the registry existed"`). Only **B204** had a live `REG-B204` pin (`apps/mobile/__tests__/secure-key.test.ts`, PR #565/`4046e669`) — proved and discharged to `done`. The other five had no REG-tokened test the sweep could cite (`prove` refuses a proof without the literal token, and fabricating one was ruled out): each got a `note "pin proposed: …"` describing the concrete assertion the sweep found missing, and stayed `queued` in F33, listed as proven-less in the follow-up PR body. **B40**: `note`d `PARTIAL: #481 929a3740 scoped DSO/routes/drivers/dead-stock; margin-alerts deliberately unscoped (documented)` and left open (unbatched, no move). **B143** (F19, T1, queued): `git log --oneline -S "queue-drain" -- apps/mobile` found the file's introducing commit `5219e620` (`#555`, "F30" scan-loss hardening); `apps/mobile/__tests__/offline-queue-failed.test.ts` already carries `REG-B143` titles — proved with `--pr 555` and discharged in F19 (only B143 moved; siblings B01/B02/B111/B136/B137/B140/B150 stayed `queued`, untouched, since none of them were `proven`). `bugs.mjs sync --check` (281 records mirror the ledger) and `node scripts/validate-lessons.mjs` both green after all of the above.
- **2026-09-08** — (branch `docs/675-b263-bookkeeping`, Option-B bookkeeping follow-up for PR #675, mapped at `f52005f3`) — **B263 option B mapped: price edit inside the scan flow over a paused camera.** `mobile.md`'s "Barcode scanner" table row gains `active?: boolean` (default `true`, forwarded to `<ScanCamera active={active && !paused}>`) on both `BarcodeScanner.tsx`/`.web.tsx`, plus `feedback.action` now rendered as a pressable pill (previously dead — `onAmbiguous`/`onCreate` in `lib/scan-ladder.ts` could never fire). New dated section (`### 2026-09-08 — B263 option B`) documents NEW `lib/price-override.ts` (pure: `applyPriceOverride(item, {unitPrice, reason})` rounds via `roundMoney` + recomputes `lineTotal` via `computeLineSubtotal`, fixing a pre-existing unrounded-write gap on the list-branch modal too; `needsMarginAck(item, newPrice, floorPrice)` is the shared margin-floor decision helper) and `app/(operator)/(tabs)/orders/[id]/edit-items.tsx`'s `ProductPicker` gaining `canEditPrice`/`marginFloor`/`onScanSessionStart` props plus `pickerPriceEditItem` state: the SAME `PriceOverrideModal` now mounts inside the picker branch too, over the camera paused (not torn down) via the new `active` prop — scan → Edit price → Apply → scan next is now 2 taps / 0 remounts (was 5 taps / 2 camera lifecycles). A round-3 light-loop fix (after the engine's main pass) made the picker strip's margin-floor label derive from the same `computeMarginFraction`/`classifyMargin` calls `DraftItemCard` uses instead of a hardcoded literal, so the two surfaces cannot disagree on wording. New Tests bullet: `price-override.test.ts` (REG-B263-A), `edit-items-scan-price.test.ts` (REG-B263-B, REG-B263-H, `PIN-B263-D4`), `barcode-scanner-active.test.ts` (REG-B263-C). **Registry:** `move B263 --to F30 --tier T1` (B246's batch), analysis sections (Summary/What this feature is for/Root cause/User impact/Fix approach and UX/Test plan) filled from `cause-ruling.md` §1-2 and `bug-test-plan.md`, `prove`/`discharge` on #675 (master `f52005f3`) — done; B246's row gets a history note that the option-B twin landed. Sibling money-math gap found in review: `needsMarginAck` rounds to the nearest cent while the list/picker labels classify by the exact fraction, disagreeing by up to half a cent at the boundary — filed unbatched as **B280** (low; `bugs.mjs file`'s auto-classifier only scans title+location and neither string tripped the money regex, so `sensitive`/`sensitiveFor` were hand-set to `true`/`money` in the record frontmatter and `bugs.mjs index` resync'd `bugs.jsonl` from it). Lesson **L-099** appended (domain — a sheet that must return to a live surface mounts OVER it with a pause prop, never swaps the surface out; a secondary surface repeating a classification derives it from the same helper the primary uses). Register was 40/40 (at cap): no "next headroom" candidate was pre-flagged in `_meta.json.note` or the last 3 commits touching it, so a fresh oldest-first sweep ran — **L-010/L-025/L-027/L-034/L-035** (the oldest `none — judgment`-class entries) are each cited outside `.claude/lessons/**`/`.claude/pipeline/**`/`code-map/CHANGELOG.md`/`code-map/_meta.json` (`HANDOFF.md`; mobile test/source files + `code-map/mobile.md`; `tools/bugflow/docs/MIGRATION.md`; `scripts/campaign-check.mjs`+`scripts/jest-campaign-reporter.cjs`; `.claude/campaign/bugs/B34.md`, respectively) and stay active — archived **L-038** (2026-09-01, tooling, bot-authored lockfile regeneration) instead, grep-confirmed clean, its guard already `none — validate-lock passes either way` (no dedicated automated check). Back to 40/40 with L-099 added, 39.4/40.0 KB, archived 55, nextId 100. `node scripts/validate-lessons.mjs` exit 0.
- **2026-09-08** — (branch `docs/673-signin-menu-bookkeeping`, Option-B bookkeeping follow-up for PR #673, mapped at `c138289c`) — **Sign-in menu focus-ring hotfix mapped.** `web.md`'s `components/site-header.tsx` bullet documents the Sign-in `DropdownMenu.Item asChild` anchors (`role="menuitem"`, icon + label + `ArrowUpRight` glyph): the `.signin-menu [role="menuitem"]` rule in `marketing.css` is now `display: flex; align-items: center; width: 100%; white-space: nowrap` with its own `:focus-visible` ring (`outline` + `outline-offset`) and `> * { outline: none }` on its children — was `inline`, so the ring painted once per line box (icon/label/arrow) and the arrow wrapped; resting colour unified `#6b81a0` → `#202124`. The `marketing-port.static.test.ts` bullet notes the 3 new R-MKT signin-menu CSS-rule-parser assertions (suite 59/59). Registry: B279 filed unbatched (ui-ux, medium) — `bugs.mjs prove`/`discharge` both require a `--batch` ledger shard by design (confirmed from source), so an unbatched row cannot reach `done`; full root-cause/fix/test-plan evidence written via `note` instead of a fabricated state. Lessons: L-098 appended (domain — a focusable element with more than one child is a flex/grid/block container with `white-space: nowrap`, the focus ring lives on the element never its children, pin with a CSS-rule test not a source-text grep); L-051 (2026-09-02, process, the pre-flagged headroom candidate from the #671 follow-up's own `_meta.json` note) archived, grep-confirmed clean. Register back to 40/40.

**Older entries (archived 216, 2026-09-13 split):** [`CHANGELOG-ARCHIVE.md`](CHANGELOG-ARCHIVE.md) — full verbatim history back to the changelog's creation. `git log -- .claude/code-map` for anything older still.
