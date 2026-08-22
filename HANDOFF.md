# HANDOFF — current state & what to pick up next

**Written:** 2026-08-22 · **Branch:** `feat/msrp-on-invoices` (worktree `.claude/worktrees/msrp`) · **Visibility:** private (CI runs private — no flips) · **Open PRs:** [#407](https://github.com/najathakram/routeflow/pull/407) (parallel session, SMTP)

## 🚧 IN FLIGHT — MSRP · Sales Agents · feature gating · quick wins (2026-08-21/22)

Approved plan: `~/.claude/plans/imagine-you-are-a-breezy-ripple.md` (4 features, 4 PRs).
Owner decisions locked: commissions **accrue on invoice issue, become payable as the invoice
is paid** (pro-rata, no commission on bad debt) · agents are **records-only v1** (no login) ·
commission base = **subtotal after discounts, excluding tax + shipping** · MSRP is **per piece**.
Feature gating answer: **no per-tenant branches** — one trunk, entitlement flags
(`flag.msrp`, `flag.sales_agents`) default OFF, per-tenant variation as `SystemConfig` JSON.

**Sequence:** PR-A quick wins → **PR-B MSRP** → PR-C agents engine → PR-D agents UI.

### ▶ RESUME HERE (if the session switched)

1. **PR-A [#408](https://github.com/najathakram/routeflow/pull/408) is DONE** — merged,
   deployed, prod migration applied, post-deploy check green. Nothing left. **Do NOT
   re-apply its migration.**
2. **PR-B (MSRP) is the active task.** Work in the worktree
   **`.claude/worktrees/msrp`** on branch **`feat/msrp-on-invoices`** (branched off merged
   master `de557140`, has its own `node_modules` from `npm ci`). The full work-package plan
   is committed at **`.claude/pipeline/plans/2026-08-22-msrp-on-invoices.md`** — hand that
   path to the implementers; the summary below is the short version.
3. **Do not work in the main checkout** (`C:\ClaudeCode\routeflow`): a parallel session owns
   it, is on `fix/smtp-provider-instructions` for PR #407, and has uncommitted HANDOFF edits
   there. Leave it alone.

> ⚠️ **MULTI-SESSION TANGLE HAPPENED HERE — read before committing anything.** A peer session
> switched the MAIN CHECKOUT onto `fix/smtp-provider-instructions` mid-turn, so two of my
> commits landed on THEIR branch, and their `git add -A` swept MY uncommitted code-map edits
> into THEIR pushed commit `3a35722b`. Resolved: their branch ref was reset to exactly what
> they had pushed (`3a35722b`, matches remote), my commits were cherry-picked onto
> `feat/zelle-tier-quickwins`, their stray plan file was removed from my commit, and my
> code-map entries were re-applied to my branch. **Consequence to know:** `3a35722b` (their
> PR) still contains code-map text describing `payment-methods.ts`, a file that only exists
> in #408 — so whichever of the two PRs merges second will hit a small markdown conflict in
> `code-map/{web,api}.md` + `_meta.json`. Resolve by keeping both sets of entries.
> **Discipline: work in your own `git worktree`, never `git add -A` in the shared checkout.**

**PR-A `feat/zelle-tier-quickwins` → [#408](https://github.com/najathakram/routeflow/pull/408) — ✅ SHIPPED AND LIVE (merged `de557140`, 2026-08-22).**
Plan: `.claude/pipeline/plans/2026-08-21-zelle-tier-quickwins.md`.

| Step                        | State                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`            | ✅ 18/18 tasks · 2562 api + 1175 mobile tests · lint 0 errors                                                                                                          |
| CI (private repo)           | ✅ Lint · Type Check · Test · Security Audit (E2E skipped on PRs by design)                                                                                            |
| Pre-migration prod backup   | ✅ `backups/pre-zelle-migration-2026-08-22.sql` (11 MB, **validated**: 117 CREATE TABLE = 117 COPY = 117 `\.`, dump-complete marker present)                           |
| **Prod migration**          | ✅ `20260830000000_payment_method_zelle` applied BEFORE the merge — verified live: prod enum reads `CASH, CHECK, ACH, OTHER, CREDIT_NOTE, ADVANCE, CREDIT_CARD, ZELLE` |
| Merge → Railway deploy      | ✅ squash-merged `de557140`; api + web both **SUCCESS**                                                                                                                |
| `npm run post-deploy-check` | ✅ **all checks OK** — health, login, orders/invoices/customers/products/drivers money fields, invoice math, order↔invoice reconciliation                              |

> The deploy ordering worked exactly as intended: schema first, app second, so the new image
> never met a missing value. No visibility flips were needed (CI runs on the private repo).

| Item                                                                                                                         | State                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PaymentMethod` enum + `ZELLE` (schema.prisma:133)                                                                           | ✅                                                                                    |
| Migration `20260830000000_payment_method_zelle` (hand-written; `ADD VALUE IF NOT EXISTS`, no txn block)                      | ✅ **verified: full 14-migration chain replayed clean on a fresh DB, enum confirmed** |
| `packages/types` PaymentMethod backfilled to all 8 values (was a stale 4)                                                    | ✅                                                                                    |
| `apps/{web,mobile}/lib/payment-methods.ts` — THE source for method lists (SELECTABLE\_\* pickers vs ALL\_\* display/filters) | ✅ new                                                                                |
| Repointed every hand-rolled method list (~22 surfaces, more than the 14 first scoped)                                        | ✅                                                                                    |
| Customer price-tier discoverability fix                                                                                      | ✅ **proven in-app: tier 1→3 persisted, header badge followed, restored to 1**        |

**Review caught 8 surfaces the initial inventory missed** (3 Opus lenses, 20 findings, 0
refuted, all fixed): vendor-bill payment modal, advance-payment modals (web + mobile),
mobile payments filter, driver at-door screen, payment-receipt labels, invoice-detail badge
colours, `paymentMethodPill` (Zelle showed as "Other"), and the edit-payment seed whitelist
(a ZELLE payment reopened as "OTHER"). Plus two gaps that PREDATE Zelle: web
`finance/reports` + `bookkeeping/[transactionId]` never offered CREDIT_CARD, and mobile
`record-payment.tsx` offered only CASH/CHECK/ACH.

Two fixes made by hand after the pipeline (it had deferred to the plan's "no API changes"):

- `import.service.ts` folded a source method of `"zelle"` into ACH — now maps to ZELLE.
- `customers/[id]/page.tsx` gated tier/credit edits on `role === "OPERATOR"`, hiding them
  from **TENANT_ADMIN** — which `ROLE_SATISFIES` already authorizes server-side. **This is
  the likeliest reason the tier looked missing**: a tenant admin saw read-only text.

**Gate:** `check-types` clean (forced, uncached) · lint 0 errors · **2562 api + 1175 mobile
tests pass** · prettier clean. (2562 not 2568 — the extra 6 were the peer's
`email-smtp-verify.spec.ts`, correctly no longer on this branch.)

### PR-B (MSRP) — ready to start, everything needed is here

Branch `feat/msrp-on-invoices` exists in worktree `.claude/worktrees/msrp`. **Full
work-package plan (5 WPs, exact code for the resolver and the migration SQL):
`.claude/pipeline/plans/2026-08-22-msrp-on-invoices.md`.** The summary below duplicates its
key decisions so this file stands alone.

**Verified facts (already checked against the code — do not re-research):**

- **No MSRP field exists anywhere.** Greenfield.
- `CustomerPrice` stores a **tier number, not a price** (`@@unique([customerId, productId])`,
  CRUD at `/customers/:id/prices` → `customers.service.ts` `getCustomerPrices` ~L949 /
  `upsertCustomerPrice` ~L974).
- **Every `pricingTier` reader is already null-safe** (`?? default`) — `orders.service.ts`
  ~L1526/~L1630/~L3941, `estimates.service.ts`, `buyer-catalog.service.ts` ×3,
  `buyer-dashboard.service.ts` ×4. That is what makes the column safe to make nullable.
- Invoice lines are built by `invoices.service.ts` `buildInvoiceItemData` (~L539); its four
  callers: `createSplitInvoices` ~L742, `reconcileOrderDraftInvoice` ~L956,
  `rebuildSiblingDrafts` ~L1234, `createPartialFromOrder` ~L1904. Also `create()` ~L145,
  `update()` DRAFT path (~L2384), `duplicate()` ~L3145, NSF line ~L4190 (productless).
- `recurring-invoices.service.ts` **delegates to `InvoicesService.create()`** → hooking
  `create()` covers recurring for free.
- `estimates.service.ts convertToInvoice` (~L214, items ~L252-261) writes `InvoiceItem`
  **directly** — a separate write site that is easy to miss.
- Render surfaces (all 4 money columns today): web `invoices/[id]/page.tsx` ~L2172-2309
  (branches on `priceType`), buyer portal `buyer/portal/[seller]/invoices/[id]/page.tsx`
  ~L214-243, PDF template `invoice-pdf-template.tsx` (`InvoicePdfData` ~L8-88, row ~L476-511),
  email `email.service.ts buildInvoiceEmail` ~L815-825 fed by `sendEmail` map ~L2687-2692.
- PDF uses `@react-pdf/renderer`, and `invoice-pdf.service.ts` loads items via `include` —
  **so it needs NO change, and must NOT be changed**: it has to print the line snapshot, never
  the live product.

**Design decisions (locked):**

- Schema: `Product.msrp Decimal?`, `CustomerPrice.msrp Decimal?` **+ `pricingTier Int` →
  `Int?`** (a row may now be msrp-only), `InvoiceItem.msrp Decimal?`. One hand-written
  migration `20260831000000_add_msrp_pricing`.
- **MSRP is display-only and must never touch money math.** Per PIECE, rendered `MSRP $X.XX/pc`.
  Null renders blank, never `$0.00` (0/negative/NaN all normalize to null).
- **Snapshot on the invoice line at creation**, never re-read live — an issued invoice must not
  change when the product's MSRP is later edited. `duplicate()` copies verbatim.
- Resolver `apps/api/src/common/msrp.ts`: `resolveMsrp({customerMsrp, segmentMsrp, productMsrp})`
  — customer → **segment (present in the signature from day one, nothing populates it in v1)**
  → product. That stub is what makes future per-state MSRP one new table + one lookup inside
  `loadMsrpMap`, with no data migration and no call-site churn. Plus `wholesalePerPiece`,
  `isMsrpBelowWholesale` (warn, never block), and batch `loadMsrpMap(db, customerId, ids)`.
  **Server-only — no 3-way mirror**, because MSRP never prices a cart (contrast `pricing.ts`).
- One orchestrator `applyMsrpSnapshots(db, customerId, itemsData)` in `invoices.service.ts`
  that no-ops unless `EntitlementsService.hasFlag(tenantId, "flag.msrp")`.
- Flag gating: `flag.msrp` + `MSRP` AddonSku in `plan-catalog.constants.ts`, published by a new
  `publish-plan-catalog-v9.ts` (clone v8), `AVAILABLE_ADDONS` entry so the existing audited
  admin enable/disable works. **Gate inside the service** when `dto.msrp !== undefined` — do
  NOT decorate the shared product/customer routes or un-flagged tenants get 403s on ordinary
  edits. Only the new `POST /products/msrp/bulk` carries `@RequirePlanFlag`.
- UI reads key off `item.msrp != null`, not the flag, so historical invoices still render if
  the addon is later removed.

**Watch out for:** the nullable `pricingTier` is the riskiest edit — add a spec proving a
`{pricingTier: null, msrp: 5}` row still prices at the customer's default tier.

> ⚠️ **LOCAL DEV DB IS ~6 MONTHS STALE (pre-existing, NOT caused by this work — needs a
> decision).** `routeflow_dev`'s newest applied migration is `20260330000000_add_vendor_bill_items`;
> it predates the #349 baselining, so `migrate deploy` tries to replay `0_init` and dies on
> `type "UserRole" already exists`. Consequence: **orders and invoice pages 500 locally**
> (`column OrderItem.promoFreeUnits does not exist`, same for `InvoiceItem`) — that is this
> drift, not a regression. It also had an orphaned FAILED record for
> `20260330100000_add_costing_method`, a migration deleted from the repo in `63376fe7`, now
> marked rolled-back locally.
>
> - **To verify a migration safely today:** replay against a throwaway DB —
>   `CREATE DATABASE <scratch>` in the `routeflow_postgres` container → `migrate deploy` →
>   drop. That is what CI does and it leaves the working dev DB alone.
> - **To actually fix local dev** (recommended, but DESTRUCTIVE to local data so it needs an
>   explicit go-ahead): drop and recreate `routeflow_dev`, `migrate deploy`, then reseed the
>   `e2e-routeflow` tenant. Until then the invoice/order surfaces can't be exercised locally.

> **Prisma 7 does not auto-load `.env`** when `prisma.config.ts` is present — every prisma CLI
> call needs `DATABASE_URL` exported explicitly, else "datasource.url property is required".
> `prisma migrate dev` also HANGS in a non-interactive shell (it prompts); write the migration
> SQL by hand and use `migrate deploy`.

## ✅ THE UX EXPANSION BATCH IS COMPLETE — all six PRs shipped and live

| PR               | What                                                                                                                                                                   | Migration |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **#367 PR-A**    | 2 live client bugs (**A4** driver edits wiped orders, **A5** buyer password login never reached its sellers) + mobile send no-dead-end, inventory reach, 3 cross-links | —         |
| **#369 PR-B**    | orders-by-product filter + per-buyer sales history (api/web/mobile)                                                                                                    | —         |
| **#371 PR-C**    | durable stock-count sessions (review, history, amend)                                                                                                                  | **#1**    |
| **#373 backlog** | B4–B14: 2 security holes, 2 money bugs, 3 duplicate-document races, 3 UX                                                                                               | —         |
| **#374 PR-D**    | generic → variant stock assignment, one mechanism two entry points                                                                                                     | —         |
| **#375 PR-E**    | supplier payment allocation, on-account credit, bulk mark-paid                                                                                                         | **#2**    |
| **#376 PR-F**    | AI supplier-statement reconciliation, one review screen                                                                                                                | **#3**    |

All three migrations are **applied to production**, each with a fresh validated `pg_dump` first and each proven by CI against a fresh Postgres beforehand. Every PR: `npm run verify` green, post-deploy smoke green, new routes verified registered in prod.

**B5 from the deep-dive list was already fixed in #352** — excluded deliberately, do not "re-fix" it.

> ### 🚨 The deploy problem is SOLVED — and it was never permissions
>
> The Railway GitHub App has **All repositories** access and always did (verified in the GitHub UI, 2026-08-20). The real cause, read from the Railway dashboard **Details** panel (the CLI hides it — `railway logs --build` only prints `scheduling build`): **a GitHub visibility change briefly makes the repo inaccessible.** A clone inside that window gets `repository not found`; a `git push` gets `403 Your repository is disabled` while the repo page looks perfectly normal. Our script flipped private in the same breath as the merge, landing inside Railway's ~2s snapshot.
>
> **Fix, now in CLAUDE.md: merge → wait until the deploy reaches `BUILDING` → then flip private.** Four consecutive clean GitHub deploys followed.
>
> Two traps learned the hard way: **`INITIALIZING` IS the snapshot window** — flipping there fails identically (proven on #376; recovered with `railway up`). And **`gh repo edit` can fail with a network error and silently leave the repo PUBLIC** (hit on #374) — always read visibility back in a retry loop.

> **Migration ordering CHANGED.** Now that GitHub deploys actually work, merging deploys the app immediately — so a migration must be applied to prod **BEFORE** the merge, not after. (The old merge-then-migrate order only looked safe because the deploy was failing.) Sequence: CI proves the migration → validated backup → apply to prod → merge → deploy into a ready schema.

> **`pg_dump` is NOT installed locally** but IS inside the Railway postgres container. Take the pre-migration backup with `railway ssh --service postgres` running `pg_dump --no-password --format=plain --no-acl --no-owner` against `$POSTGRES_USER` / `$POSTGRES_DB`, redirected to `backups/<file>.sql`. Then VALIDATE it — expect ~112 `CREATE TABLE`, a matching `COPY` count, and the "dump complete" marker. A truncated dump is worse than none.

> **CI now gates migrations.** It previously ran only `prisma db push`, which never exercises the migration files at all — the exact gap that lets a broken migration reach production. It now replays the whole history against a fresh Postgres first. If that step fails, do not touch prod.

---

## 1. ▶ NEXT UP — what actually remains

The batch and the deep-dive backlog are done. What is left is either an owner decision or
genuinely new work. Nothing below is blocked on code.

### 1.1 Owner decisions — these are yours, and were deliberately left alone

1. **Returns §2.1 — "restore to the original credit note" would re-bill the customer.**
   Still open, still not implemented, and still the right call to leave open. See §2.1 for
   the worked example. Today's mint-a-new-note behaviour loses no money; it just produces a
   second note to track.
2. **Two prod data repairs awaiting sign-off** (§2.2) — costing (14 duplicate received bills,
   ~$12,829 phantom stock, plus 13 products' case-vs-piece cost) and pack size (812 products).
   Both scripts are dry-run by default and **neither has been run**. They write to live client
   data, which the policy reserves for an explicit request.
3. **What `test-tenant` actually is** — 788 active products and 316 pack-size candidates under
   a tenant whose name says "test" but whose data looks real. It matches no approved test
   pattern, so it is currently excluded from everything. Confirm before any bulk write.
4. **Tell the affected buyer to log in again.** The A5 fix is live; their seller link was
   always intact server-side. One fresh login and their dashboard works. Nothing was lost.

### 1.2 Known gaps, recorded rather than silently assumed handled

- **AP has no VOID concept.** `BillPayment` has no `status` column, so a mistaken supplier
  payment cannot be voided the way an AR one can. PR-E deliberately did not invent this.
  A follow-up would need migration #4 plus a void path mirroring `voidPayment`.
- **PR-F's client-side derivations.** The web review screen computes "unmatched local bills",
  the implied-paid candidate set, and its closing-balance warning **client-side** from
  `GET /vendor-bills`, because the API returns matches only. This is safe — the server is the
  authority on what any Apply may pay, and it re-validates every amount against both the
  statement line and the bill's real outstanding balance — but moving those derivations
  server-side would make the review screen cheaper and single-sourced.
- **`applyAdvancePaymentToInvoice` re-implements the invoice status thresholds inline**
  instead of calling `recomputeStatus`. Two hand-maintained copies of one rule. Not touched
  in this batch; worth collapsing before either copy drifts.

### 1.3 Remaining product work (unchanged, unstarted)

Wave 5 / Wave 6 of the mobile-first UX program (tasks #23/#24), in-app pack size (#45 — see
§4.1), and the small residuals in §4.4.

### 1.4 Owner actions still open

Enable **Authenticated SMTP** on the M365 mailbox; Railway billing auto-top-up;
healthchecks.io cadence to 2-hourly; an uptime monitor on `/api/v1/health`.

---

## 2. 🔴 BLOCKED ON THE OWNER — do not proceed without an answer

### 2.1 Returns: "back on the original note" would re-bill the customer

The owner chose _"restore the returned value to the original credit note"_ for partial
returns. **Implemented literally, this takes money from the customer**, so it was
deliberately not built:

> Invoice $100, fully paid by CN-1. Customer returns $30 of goods. Restoring $30 to CN-1
> re-opens a $30 balance on that invoice — returns do **not** reduce the invoice, they
> mint a credit memo — and auto-apply pushes the same $30 straight back onto it.
> Customer nets nothing and is effectively re-billed for goods they returned.

Today's mint-a-new-note behaviour **loses no money**; it just produces a second note.
Options: **(a)** keep minting (status quo, correct, two notes to track) or **(b)**
restore to the original note AND reduce the invoice — a true unwind, but it touches tax,
the regulated ledger and filings. Task #42 carries the worked example.

### 2.2 Two prod data repairs awaiting sign-off (both dry-run only, nothing executed)

| Repair                     | Report                                          | Scope                                                                                                                                                  |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Costing** (2026-08-12)   | `.personal/costing-repair-report-2026-08-12.md` | Void 14 duplicate received vendor bills (9 groups, ~$12,829.27 phantom stock) + fix 13 products' case-vs-piece cost denominations, then recompute AVCO |
| **Pack size** (2026-08-13) | `.personal/pack-size-proposal-2026-08-13.txt`   | Set `unitsPerBox` on **812** high-confidence products on the live tenant (1,131 across all tenants)                                                    |

Both scripts are read-only by default and refuse to write without
`--execute --confirm-tenant=<slug>`. **Neither has been run.**

---

## 3. Decisions already made — do NOT re-litigate

From 2026-08-13: cancel with a live SENT/PAID invoice → warn, then proceed (**shipped in
#341**); restoring to an expired/voided note revives the original, future expiry left
alone (**shipped**); pack-size fix = reviewed backfill **plus** in-app affordances
(backfill report done — §2.2; in-app half is §4.1). Partial-return credit → superseded by
the open §2.1 question.

Standing: mobile is the PRIMARY operator surface; `formatQtySplit` stays "boxes + pcs";
promotions are deliberately staff-invisible server-side (not a parity gap). Plus the
2026-08-17 batch decisions in §1.

---

## 4. Next build work (after the §1 batch)

### 4.1 In-app pack size (task #45) — the other half of decision 4

Only 19 of 1,743 live products have a pack size — every boxed affordance gates on
`unitsPerBox > 1`. Even after the backfill, ~500 rows stay manual (172 nested-count like
"5CT - 12Pack", 161 no-count, plus new products).

- Line-level "sold in a box of N?" affordance in the order/invoice builders that PATCHes
  the product and re-renders the line as boxed.
- Product create/edit: prompt for a pack size when the unit noun reads packaged or the
  name contains "N CT/PK" but `unitsPerBox` is unset.
- Share the name parser with the backfill script (`parsePackSizeDetailed` in
  `apps/api/scripts/propose-pack-sizes.mjs`) as a pure `lib/pack-size.ts` + specs.
  **It must keep refusing to guess** ("…5CT - 12Pack" is 12 packs of 5, not 5).

### 4.2 Wave 5 — catalog & supply (task #23)

All UI-only; every endpoint exists and web already exercises it. Product photo
capture/manage on mobile (hooks written, never wired — smallest win); variant
link/unlink/group; vendor-bill edit/pay/revert/delete on mobile; estimate creation;
merchandising flags.

### 4.3 Wave 6 — visibility (task #24)

Operator change-request inbox (driver-only today, missing APPROVE_NEXT_DELIVERY);
analytics KPIs (mobile has 4 of web's 12); finance reports (5 of ~20, no export);
inventory forecasting; expense OCR.

### 4.4 Small residuals

Web customer-page credit tile (W15) · `ProductSearchInput` suggestion rows show LIST
price (cosmetic) · margin hint on the mobile invoice builder · mobile product
create/edit UI for `priceTier2..5` · 9 products priced at $0.00 and junk unit nouns
(one is literally `"box\nbox"`) surfaced by the pack-size audit.

---

## 5. Owner-facing items to raise (no code)

- **`regUomCase` restatement:** setting a case UoM restates that product's past periods
  when a report/filing is RE-generated. Prepared filings snapshot their rows and never
  change. Say this before they start filing.
- **Wedge-scan fix (#339)** live but the reporting wholesaler hasn't confirmed on their
  handset/scanner. **Camera scanning** on the owner's handset (#323) also unconfirmed.
- **`test-tenant`** holds 788 active products and 316 backfill candidates. Its name
  suggests a test tenant but it does NOT match the approved patterns (`test`,
  `e2e-routeflow`, `qa-*`, `e2e-*`, `ux-audit-*`). Confirm what it is before any bulk
  write touches it.
- **M365 SMTP**: see §1 — the fix is probably enabling Authenticated SMTP on the
  mailbox, not code.

---

## 6. Session mechanics that save real time

- **Ship flow (standing):** `npm run verify` → public → push/PR → CI → squash-merge →
  **private IMMEDIATELY, then read it back** (`gh api repos/najathakram/routeflow --jq .visibility`
  in a retry loop — the flip has TLS-failed silently, leaving the repo public) → watch
  Railway → `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app npm run post-deploy-check`
  (**without that env var it silently checks localhost and passes**).
- **Local stack:** API from `dist` (`node dist/main.js`; `nest start --watch` broken;
  port-3000 zombies common — `Get-NetTCPConnection … | Stop-Process`). Web `next dev`
  :3001 via `preview_start {name:"web"}`. Mobile `CI=1 npx expo start --web` (Metro
  watcher broken here; ~7-10 min first bundle, **no HMR** — restart to pick up edits).
  Swap `apps/mobile/.env` to `localhost:3000` and **restore the LAN IP afterwards**.
- **Prod DB:** `railway run --service postgres node <script>`. That service exposes
  `POSTGRES_USER/PASSWORD/DB` + `RAILWAY_TCP_PROXY_DOMAIN/PORT` — **not** `DATABASE_URL`;
  scripts assemble the URL from parts. A script in the scratchpad can't resolve `pg`;
  use `createRequire` pointed at `apps/api/package.json`.
- **Local e2e fixtures already seeded** (docker DB, tenant `e2e-routeflow`, operator
  `admin`/`Admin@123`): tier-2 customer, a 6-pack with case barcode `4000000000019` /
  piece barcode `2000000000012` / `priceTier2` $16 (list $20), credit note
  `CN-VERIFY-100` at $100 with $50 used.
- **Driving RN-web in a browser:** dispatch the full pointer sequence
  (`pointerdown → mousedown → pointerup → mouseup → click`); bare `.click()` and CDP
  Enter don't reach React handlers. Find pressables by leaf text, then walk up to
  `cursor: pointer`.
- **Commits are slow** (lint-staged): give the Bash call 240s or the hook is killed
  mid-flight and files stay staged — just re-commit.
- **Preserved on purpose:** git stash `stash@{0}` (Material-3 mobile kit WIP — standing
  decision is redo-from-doc). `HANDOFF.md` + `docs/plans/` are tracked (owner decision
  2026-08-17 so any machine can pick up the work). **Never commit `.personal/`
  (live-tenant repair data) or `docs/audit/` (maps of unfixed security findings — the
  repo goes public during CI windows)**; both are gitignored.
- **Policy anchors:** test tenants only (`test`, `e2e-routeflow`, `qa-*`, `e2e-*`,
  `ux-audit-*`); never put a live client's slug/names/numbers in code, docs or the code
  map; money math through `pricing.ts`; code-map update with every change (Stop-hook
  enforced).

### 6.1 Verification layers

Four layers, each closing the previous one's blind spot — full matrix (feature →
layer → command/spec) at `docs/testing/verification-matrix.md`:

1. **Unit specs** — `npm run verify` (Jest, mocked at the Prisma boundary).
2. **Post-deploy check** — `npm run post-deploy-check` (authenticated read-only
   probe of the live API: login, list endpoints, money-format checks).
3. **Feature smoke** — `npm run feature-smoke` (authenticated WRITE-path smoke on
   the `e2e-routeflow` test tenant; provisions `E2E-SMOKE-` fixtures, exercises the
   2026-08-20 batch's write paths, cleans up in `finally`).
4. **Playwright e2e** — `cd apps/web && npx playwright test` (role/UI coverage,
   including the read-only-or-cancel specs for the new UI surfaces).

`npm run regression` chains 1 → 2 → 3. `nightly.yml` runs 2 + 3 + 4 against
production but only fires while the repo is public; while private (the normal
state) it is dormant, and the recurring gates are the post-deploy webhook and
`npm run regression` run locally before every push.
