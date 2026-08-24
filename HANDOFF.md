# HANDOFF — current state & what to pick up next

**Written:** 2026-08-24 (overnight autonomous follow-up run) · **Visibility:** private ·
**CI:** GitHub Actions is DEAD on the free plan while private (billing declined; jobs die in 2s
with 0 steps). **Owner decision 2026-08-23: stay on the free plan — the public-flip routine in
CLAUDE.md is canonical again** (public → push/CI → merge → wait for Railway `BUILDING` → private).
Until a public window, the **pre-push hook running the FULL `npm run verify` is the authoritative
gate** — never `SKIP_VERIFY=1` without an explicit green verify of the exact pushed state.

## 🟡 THREE PRs OPEN — awaiting the owner's merge windows (2026-08-24)

Built, verified, and pushed overnight; **not merged** because this session's auto-mode
classifier blocks `gh pr merge` and `gh repo edit` (visibility flips) — the merge windows are
owner-run. Every PR passed the full pre-push-hook `npm run verify` on its exact pushed state.

| PR | Branch | What | Extra verification |
| --- | --- | --- | --- |
| **#427** | `scripts/receiving-and-entity-repairs` | `repair-receiving-units.mjs` (HIGH-signature box-entered PURCHASE repair + printed `recompute-costs` follow-up) · `repair-escaped-entities.mjs` (pre-#414 stored entities) · drift scan scope widened to ACTIVE/TRIAL/READ_ONLY | scripts-only; `node --check` ✅ |
| **#428** | `fix/commission-nsf-exclusion` | NSF bounce fees excluded from the commission base (owner decision): shared `NSF_FEE_DESCRIPTION_PREFIX`, `InvoiceMoneyState.nsfFees`, `collectionRatio` deliberately conservative | pipeline clean (2765 tests) + **Fable money-pass PASS** |
| **#429** | `feat/sales-agents-ui` | **PR-D** — full sales-agents & commissions UI (pages, customer "agent box", statements w/ stale-409 regenerate, order override, mobile row, e2e 18). One read-only API addition. No migration | major pipeline (60 agents), 1 fix round → 0 findings |

**Merge runbook (per PR, in the order above — no migrations, so no DB step):**

```bash
gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences
```

(CI is not merge-gating and each branch already passed the full hook verify; if you want a CI
record anyway, re-run the PR's workflow from the Actions tab after flipping public.)

```bash
gh pr merge <PR#> --squash --delete-branch
```

```bash
until railway deployment list --service @routeflow/api | sed -n '2p' | grep -qE 'BUILDING|DEPLOYING|SUCCESS'; do sleep 10; done
```

```bash
gh repo edit najathakram/routeflow --visibility private --accept-visibility-change-consequences
```

Then confirm `gh repo view --json visibility` says PRIVATE, watch the deploy to SUCCESS, and
`npm run post-deploy-check`. #427/#428 deploy only the API; #429 deploys API + web + mobile.
Batching all three into ONE public window is fine (merge 427 → 428 → 429, then wait `BUILDING`).

## 🔵 Enforcement is LIVE (2026-08-23)

`PLAN_FLAG_ENFORCEMENT=on` set on the API service by the owner, deploy `9090d918` SUCCESS,
`post-deploy-check` green. The audit script showed ZERO tenants lose anything. Kill switch
removal date stands: 2026-10-01.

## 🔵 Client-data repairs — exact sequence for the owner (after #427 merges + `git pull`)

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

| PR | What |
| --- | --- |
| #416 + #424 | Sale flow honours chosen terms/due-date; −1-day calendar rendering fixed everywhere (UTC-safe `fmtCalendarDate` web + mobile `lib/format-date.ts`; timestamps stay local) |
| #417 | Inventory RECEIVING converts boxes→pieces (Quick Restock + PO receive); silent under-receive clamp → loud reject; on-hand renders `N pcs (X boxes + Y pcs)`; read-only `report-receiving-unit-drift.mjs` stages the client stock repair |
| #418 | Three tier-blind edit paths now honour `Customer.pricingTier` (server `updateOrderItems` operator branch → SPECIAL never MANUAL; web order-edit add-item; web invoice-edit page) |
| #419 | Tenant-configurable tier names (`pricing.tierLabels` SystemConfig; `tierLabel()` triple-mirrored; settings card) |
| #414 | `StripHtml` no longer stores `&amp;`; supplier create refreshes every list (cross-invalidated query keys). Stored-`&amp;` repair still pending (read-only census script exists) |
| #420 | Plan-flag enforcement wired, **INERT** — `PLAN_FLAG_ENFORCEMENT` defaults off; audit script `apps/api/scripts/audit-tenant-entitlements.mjs` written for the owner to run BEFORE ever switching on |
| #421 | Sales agents & commissions ENGINE (PR-C), **ships dark** (`flag.sales_agents` granted by no plan). Migration `20260901` APPLIED. Post-pipeline Fable review caught a CRITICAL (approve() blind to clawbacks = commission on bad debt) — fixed pre-merge |
| #422 | Payment terms model: `Invoice.paymentTermsLabel` (label/due-date can never disagree — the INVARIANT), `Customer.defaultPaymentTerms`, `Supplier.defaultTerms`, `VendorBill.termsLabel`, deposit v1 (`depositPercent`/`depositDueDate`, derived amount via `roundMoney`, status/AR-aging untouched), narrow `PATCH /invoices/:id/terms`. Migration `20260902` APPLIED |
| #423 | Geocode on customer CREATE; `Supplier.lat/lng` + autocomplete; mobile `AddressAutocompleteInput`; **bonus: repaired the pre-existing broken mobile New-customer flow**. Migration `20260903` APPLIED |
| #425 | Test-only: un-fused the commission/entitlements mock providers (the 2026-08-23 incident — see below) |

**Prod backups** (validated, in gitignored `backups/`): pre-`0901`, pre-`0902`, pre-`0903` dumps.

> ⚠️ **Incident record (2026-08-23), lessons binding:** (1) `npm run verify | tail && echo MARKER`
> eats npm's exit code — NEVER gate on a marker after a pipe; capture the exit directly.
> (2) Keep-both conflict unions must respect object-literal boundaries — two provider hunks fused
> into one object gave duplicate `provide:` keys and JS last-key-wins silently dropped a DI mock
> (207 test failures, prod unaffected, fixed as #425). (3) Prod smoke green ≠ suite green.
> (4) After merging a schema-bearing branch into a worktree: `npx prisma generate` or tsc lies.

## 🔴 Owner queue

1. ~~Flag enforcement switch-on~~ **DONE 2026-08-23** — see the Enforcement section above.
2. ~~NSF-fee commission question~~ **DECIDED (exclude) + BUILT** — merge #428.
3. ~~PR-D — sales agents UI~~ **BUILT** — merge #429, then enable the addon per tenant.
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
  `20260904000000_*`. One migration-bearing PR in prod-apply flight at a time; apply BEFORE merge.
- Worktrees/branches from the batch are pruned (or being pruned) — work in your OWN worktree off
  master, never `git add -A` in the shared checkout.

## Session mechanics (unchanged, still true)

Ship flow per CLAUDE.md (public window minimal, private flip is a `finally`, wait for `BUILDING`).
Local stack, prod DB access, e2e fixtures, RN-web driving, slow commits (240s), policy anchors:
see CLAUDE.md and the memory index — this file no longer duplicates them.
