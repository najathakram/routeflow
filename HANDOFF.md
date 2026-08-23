# HANDOFF — current state & what to pick up next

**Written:** 2026-08-22 · **Updated:** 2026-08-23 (ship session: #409 #410 #411 #412 #413 all merged) · **Visibility:** private (CI runs private — no flips) · **Open PRs:** none — [#407](https://github.com/najathakram/routeflow/pull/407), [#408](https://github.com/najathakram/routeflow/pull/408), [#410](https://github.com/najathakram/routeflow/pull/410), [#411](https://github.com/najathakram/routeflow/pull/411) **SHIPPED + LIVE**; docs #409/#412/#413 merged

> **THREE independent workstreams are live in this document.** They do not interact — pick up any
> one without touching the others.
>
> 1. **MSRP · Sales Agents · quick wins** — the PR sequence immediately below. Code and branches.
> 2. **§1b product-image / description pipeline** — no repo code, writes to prod through the public
>    API, waiting on the owner's review of 600 images.
> 3. **🎨 Web layout audit — opener batch L0+L1 SHIPPED as [PR #410](https://github.com/najathakram/routeflow/pull/410) (2026-08-23); remaining batches await the owner's ticks.** Jump to
>    _"✅ AUDIT COMPLETE — operator-dashboard layout"_. **Everything you need is under
>    [`docs/audit/2026-08-22-web-layout/`](docs/audit/2026-08-22-web-layout/) — read
>    `AUDIT-LAYOUT.md` first, it is the approval doc.** 46 findings over 61 screens, 6 of them
>    S0 (content clipped/unreachable at 1024px). **L0 + L1** (27 findings, 27 files, cleared
>    4 of the 6 S0s) is merged and live; for the remaining batches the owner still picks —
>    then run each through `dev-pipeline`, one PR per batch, `style(web):`.
>    [PR #407](https://github.com/najathakram/routeflow/pull/407) (SMTP setup instructions)
>    also SHIPPED (merged `22bc672e`, 2026-08-22). Still open on this workstream: the
>    `routeflow-demo` email blocker (owner-only Google App Password).

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
2. **PR-B (MSRP) [#411](https://github.com/najathakram/routeflow/pull/411) is DONE** —
   merged `7e49b993` (2026-08-23), both Railway services deployed SUCCESS, prod migration
   `20260831000000_add_msrp_pricing` applied and column-verified, **catalog v9 published**
   (MSRP addon SKU live, prior version SUPERSEDED, no tenant re-pinned), post-deploy check
   green. Remaining human steps: enable the `msrp` addon per tenant in platform-admin
   (safe now that v9 is published) and exercise the flow on `routeflow-demo`.
3. **PR-C (sales-agents engine) is NEXT and now UNBLOCKED** — plan at
   **`.claude/pipeline/plans/2026-08-22-sales-agents-engine.md`**, committed `3dc23c5d` on
   local branch `docs/plan-sales-agents-engine` (worktree `.claude/worktrees/pr-c-plan`,
   unpushed). Its anchors are post-PR-B and are now on master; implement via dev-pipeline.
4. **Client-2 feedback batch is IN FLIGHT** — recon complete, all 13 items root-caused and
   verified; the map lives in memory `project_client2_feedback_batch_2026-08-22`
   (doctrine = PR #413, merged 2026-08-23). Reserved migration slots: 0902 terms ·
   0903 supplier-geocode.

> 📌 **The parallel session's HANDOFF sections were rescued into git by this session
> (2026-08-22).** Their §"IN FLIGHT (parallel session)" and §1b were living ONLY as an
> uncommitted working-tree edit in the main checkout, on a branch that had already been
> merged and remote-deleted — one stray `git checkout` there would have destroyed them. They
> are reproduced **verbatim, unedited** below. That session may still hold a newer local copy;
> if both get committed the overlap is a plain markdown conflict — **keep the newer text, and
> never delete a section you did not write.**

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

### PR-B (MSRP) — ✅ SHIPPED + LIVE — [PR #411](https://github.com/najathakram/routeflow/pull/411) merged `7e49b993` (2026-08-23)

Branch `feat/msrp-on-invoices` in worktree `.claude/worktrees/msrp`. **Full work-package
plan (5 WPs, with the exact resolver code and migration SQL):
`.claude/pipeline/plans/2026-08-22-msrp-on-invoices.md`.** The summary below duplicates its
key decisions so this file stands alone.

**Finished 2026-08-22 (this session):** completed the pipeline output, sweep-fixed every
nullable-`pricingTier` caller repo-wide, fixed 8 spec suites' DI (services gained
`EntitlementsService`/`PlanCatalogService` injections), added the required regression specs
(msrp-only row is pricing-inert; `applyMsrpSnapshots` flag-off/flag-on), then ran a 3-lens
Opus review with 2 adversarial refuters per finding (25 agents; 11 findings → 5 confirmed →
all fixed → fix delta re-verified by an independent Opus pass):

1. **Entitlements pinned-version fallback** (`entitlements.service.ts compute()`): an addon
   SKU a tenant's pinned catalog version predates (MSRP ships in v9) now resolves against
   the published catalog — without it, enabling MSRP on ANY grandfathered tenant granted no
   flag while the addon-keyed web gates turned on, 403-ing every product save.
2. **OPERATOR-gated implicit delete** (`customers.service.ts upsertCustomerPrice`): clearing
   both fields deletes the row, and `POST /:id/prices` admits DRIVER — the delete branch now
   requires an OPERATOR-satisfying role, matching the OPERATOR-only DELETE route.
3. **Mobile catalog modal null-tier coercion** (`(operator)/customers/[id]/catalog.tsx`):
   opening an msrp-only override on mobile and saving silently converted it to a Tier-1
   override (repricing to list). Modal is now null-aware with a "Default" chip.

**Gates, all on the final code:** forced typecheck 8/8 workspaces · lint 0 errors ·
**2598 api + 1175 mobile tests green** · full **15-migration chain replayed clean from an
empty scratch DB** in `routeflow_postgres` (3× `msrp numeric(10,2)` + nullable
`pricingTier` verified; scratch dropped; stale `routeflow_dev` untouched). One flaky full-run
had 4 uploads/compress failures under CPU contention — re-run green twice; not MSRP-related.

> **Deploy runbook EXECUTED 2026-08-23 (ship session):** (1) backup
> `backups/pre-msrp-migration-2026-08-22.sql` via `railway ssh` pg_dump, validated
> (11.7MB; 117 CREATE TABLE == 117 COPY == 117 `\.` terminators; "dump complete" marker);
> (2) `20260831000000_add_msrp_pricing` applied via `prod-migrate.mjs` — 3× `msrp` columns
>
> - nullable `pricingTier` verified live; (3) `db:publish:catalog:v9` published — 9 addon
>   SKUs incl. MSRP $0/mo, prior version SUPERSEDED, no tenant re-pinned; (4) merge → both
>   Railway services SUCCESS → post-deploy check green. **Remaining:** (5) enable the `msrp`
>   addon per tenant in platform-admin (safe now that v9 is published), then exercise on
>   `routeflow-demo` — browser exercise was deferred at implementation time (stale local dev
>   DB; preview tools can't target a worktree), covered so far by unit specs + review round.

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

## ✅ LANDED (parallel session, 2026-08-21/22) — SMTP instructions PR + web layout audit

> Separate session, separate branch. Does **not** touch the MSRP / sales-agents work above.
> ⚠️ That session and this one share one checkout; branch switches under a running session are
> the norm here, not a bug. Commit early, and read `git branch --show-current` before trusting
> the working tree.

### ✅ Done — PR #407, MERGED to master as `22bc672e` (2026-08-22)

`fix/smtp-provider-instructions` (head `15c55301`) — **[PR #407](https://github.com/najathakram/routeflow/pull/407)**, shipped and live.

> **Conflict with #408 — already resolved (2026-08-22).** #408 merged to master at 05:34 and #407
> went `CONFLICTING`. **My fault, and worth learning from:** I staged `.claude/code-map/{api,web}.md`
>
> - `_meta.json` by explicit path, believing that was safe — but those shared files already carried
>   the peer session's **uncommitted** edits, so my commit absorbed their work. Explicit-path staging
>   is NOT sufficient protection in a shared checkout; only a worktree is.
>   Resolved in an isolated worktree (merge `origin/master` → keep BOTH sets of entries → push):
>   `adc21b31` + `15c55301`. Only 2 files conflicted (`api.md`, `_meta.json`), **no source code**.
>   Verified after merge: my source changes intact (`isConsumerMicrosoftMailbox` ×2 in
>   `email.service.ts`, the 30-April-2026 copy in `settings/page.tsx`, the new specs) AND the peer's
>   Zelle/`mapPaymentMethod` entries intact. PR is **MERGEABLE** again.

Corrects the SMTP provider setup instructions, which had gone stale against the vendors:

- **Microsoft preset was guaranteed-fail for personal mailboxes.** It advertised "Outlook.com" and
  pointed at `smtp.office365.com`, but Microsoft ended password sign-in for personal
  Outlook.com/Hotmail/Live/MSN on **2026-04-30** (OAuth only). Those users were told to ask an admin
  to enable "Authenticated SMTP" — an errand that can never help them. Preset is now
  **"Microsoft 365 (business)"** and leads with the limitation.
- **Gmail steps described a UI Google removed** — no "select Mail / select device → Generate"
  dropdowns any more (type an app **name** → **Create**), and App Passwords is no longer linked
  from the Security page.
- Added, each verified against vendor docs: tenant **security defaults** must be off or M365 SMTP
  stays blocked; Microsoft disables SMTP basic auth **by default for all tenants end of Dec 2026**
  (removal announced H2 2027) — this preset has a shelf life; Workspace admins must allow app
  passwords; **changing a Google password revokes the app password** (silent future breakage);
  GoDaddy has migrated nearly all Workspace Email to M365; custom preset now states the accepted
  ports (25/465/587/2525).
- API `mapSmtpError` gained an optional `user` arg + `isConsumerMicrosoftMailbox`, since a personal
  and a business Microsoft mailbox are indistinguishable by host — both get typed against
  `smtp.office365.com`.

**Why it is not merged:** merging to master IS the Railway deploy trigger, and the diff touches
`apps/api/**` + `apps/web/**` (both watched). "Land but don't deploy" is not achievable; the green
open PR is that state. Merge when you want it live.

### ⛔ Blocked on the owner — `routeflow-demo` still cannot send email at all

Settings → Email is configured up to the last field: Gmail preset, sender "RouteFlow Demo",
address `najathakram1@gmail.com`. **The Google App Password is the only thing missing**, and it is
owner-only work (creating one changes Google account security settings; Google demanded password
re-verification). Until it is saved, the tenant has **no working email path at all** —
`isEmailConfigured()` is false, so invoice sends 400 with `EMAIL_NOT_CONFIGURED`. There is no Resend
fallback either (`RESEND_API_KEY` is still unset on the Railway API service).

Verified in passing: **`ENCRYPTION_KEY` IS correctly set on prod** — `routeflow-demo` renders a
decrypted `anthropic.apiKey` preview, and that key sits in the same `SECRET_KEYS` allowlist as
`email.smtpPassword`. So the App Password will save and read back; no encryption work needed.

### ✅ AUDIT COMPLETE — operator-dashboard layout · ⛔ AWAITING OWNER BATCH APPROVAL

> **Everything needed to continue is committed under
> [`docs/audit/2026-08-22-web-layout/`](docs/audit/2026-08-22-web-layout/). Start there, not here.**
>
> | File                                                                  | What it is                                                                                                                           |
> | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
> | [`AUDIT-LAYOUT.md`](docs/audit/2026-08-22-web-layout/AUDIT-LAYOUT.md) | **THE APPROVAL DOC** — 46 findings grouped by fix batch, one checkbox each. Owner ticks; you build.                                  |
> | [`PLAN.md`](docs/audit/2026-08-22-web-layout/PLAN.md)                 | The owner-approved plan (phases, batch order, pre-flight gates, diff invariant, risks)                                               |
> | [`RUBRIC.md`](docs/audit/2026-08-22-web-layout/RUBRIC.md)             | The audit standard — categories, severities, the two anti-false-positive rules                                                       |
> | `tools/*.mjs`                                                         | The harness: `build-manifest` → `capture` (probe+screenshot) → `static-scan` → `partition` → `synthesize`. Idempotent and resumable. |
> | `data/probe-all.json`                                                 | 198 runtime measurements — the evidence behind every S0/S1                                                                           |
> | `data/findings.jsonl`                                                 | Raw agent findings (4 shards merged)                                                                                                 |
> | `data/{manifest,static}.json`                                         | 66 capture targets · per-file source scan                                                                                            |
>
> **Screenshots (178 PNGs, 20MB) are NOT stored** — deliberately. Regenerate with
> `node tools/capture.mjs --widths=1440,1280,1024` (~25 min, resumable, skips what exists).
>
> ⚠️ **`docs/audit/` is GITIGNORED** (`.gitignore:90`) — the same convention as the existing
> `gap-analysis-2026-07-13.md` / `deep-dive-2026-08-17.md` reports. So this folder is **local to
> this machine and will NOT survive a fresh clone.** On this machine it is safe (ignored files are
> untouched by branch switches). If the audit needs to travel, either un-ignore this one folder or
> re-run the harness from `tools/` — every artifact except the owner's tick-marks is regenerable.
> The approved plan also has a second copy at `~/.claude/plans/frolicking-soaring-cherny.md`.

**The gate:** owner asked for findings-first approval and has NOT yet picked batches. **Do not start
fixing.** Put `AUDIT-LAYOUT.md` in front of them, get ticks, then run each approved batch through
`dev-pipeline` (owner explicitly asked for it), one PR per batch, `style(web):`.

#### What the audit found — 46 findings over 61 screens (S0:6 · S1:25 · S2:2 · S3:12 · S4:1)

**All six S0s are invisible at 1440 and only appear at 1024.** A 1440-only pass concludes "mostly
fine" — that conclusion would be wrong.

| S0  | Page                                | Defect                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `customers/[id]`                    | tab bar overflows; Documents/Licenses tabs **unreachable** (`main` is `overflow-x-hidden` — it clips, never scrolls)                                                                                                                                                                                                                                                                                                                |
| 2   | `suppliers`                         | table +64px past its host, no scroller → trailing columns clipped                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | `finance/payments`                  | 10-col table clips the **Actions** column                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | `finance/expenses`                  | 11-col table clips Paid/Balance/Status                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | `inventory`                         | toolbar doesn't wrap at 1024; "Quick Restock" cut mid-word                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | **DraftDock overlays page content** | `bottom-24 z-40` at up to `max-h-[70vh]`, but `<main>` reserves only `pb-24` (96px). Hides the City field on Settings→Profile and Total/Balance on `vendor-bills/[id]`. Found independently by **two** agents on disjoint slices, then verified in source ([DraftDock.tsx:132](apps/web/components/DraftDock.tsx:132) vs [layout.tsx:1141](<apps/web/app/(dashboard)/layout.tsx:1141>)). Conditional — only when a draft is docked. |

**The dominant defect is cheap:** 24 files render a second `<h1>` duplicating the topbar's. One tag
change each (`<h1>`→`<h2>`), near-zero risk. That is batch L0.

| Batch  | Scope                                              | Risk                                 |
| ------ | -------------------------------------------------- | ------------------------------------ |
| **L0** | 24 files — duplicate `<h1>`                        | ~zero                                |
| **L1** | 3 files — wrap clipped tables in `overflow-x-auto` | low                                  |
| **L2** | 4 files — page container standardisation           | low                                  |
| **L3** | 1 file — `PageHeader` adoption                     | MEDIUM (DOM nesting; e2e xpath gate) |
| **L4** | 1 file — token conformance                         | **BLOCKED** (see landmine below)     |
| **L6** | 12 files — density/alignment/whitespace            | judgement, last                      |

**Recommended first move:** L0 + L1 together — 27 findings, 27 files, near-zero risk, and it clears
**4 of the 6 S0s**. Good proof of the `dev-pipeline` loop before anything riskier.

#### ⚠️ Corrections — do not re-inherit my earlier wrong numbers

- **Clipped tables are 3, not 16.** The static scan found 16 files missing `overflow-x-auto`; only
  **3 actually clip** at any captured width. The other 13 are latent, NOT defects. An earlier draft
  of this handoff claimed 16 as confirmed breakage — it was wrong.
- **The app measures clean at 1440.** Zero overflow, zero escaping elements. All real damage is at 1024. Always capture the narrow widths.

#### Gaps the next session must close (do not read silence as "clean")

- **10 detail pages never captured** — `products/[id]`, `drivers/[id]`, `routes/[id]`,
  `routes/templates/[id]`, `estimates/[id]`, `returns/[id]`, `finance/payments/[id]`,
  `bookkeeping/[transactionId]`, plus `routes/[id]/dispatch` (resolver harvested an id the
  sub-route rejects → stuck on a spinner). Cause: those lists are **empty in `e2e-routeflow`**, so
  the row-click id resolver has nothing to click.
- **Only 1 `DATA_THIN` flagged, which is suspiciously low** — thin data probably _suppressed_
  density findings rather than surfacing them. Density/whitespace conclusions are weak until re-run.
- **Fix for both:** capture against `routeflow-demo` (852 products, 64 orders). Credentials come
  from the ENVIRONMENT — never a literal, never a CLI arg:
  ```
  AUDIT_TENANT=routeflow-demo AUDIT_USER=... AUDIT_PASSWORD=... node tools/capture.mjs --login
  node tools/capture.mjs --widths=1440,1280,1024      # picks up the saved demo state automatically
  ```

#### Harness gotchas already paid for

- Playwright storage state (`apps/web/e2e/setup/.auth/operator.json`, gitignored) **goes stale in
  ~2 days** — a run that worked minutes ago will die mid-pass with `AUTH STALE`. Refresh:
  `cd apps/web && npx playwright test --project=setup`. (The _customer_ setup flake is pre-existing
  and harmless here.)
- **Pin `localStorage['rf-sidebar-collapsed']='false'`** before every capture — a collapsed rail
  moves content width by 176px and silently poisons every width-based finding. `capture.mjs`
  already does this via `addInitScript`; don't remove it.
- Most list pages navigate by row `onClick`, **not** `<a href>` — id resolution must click
  `tbody tr` and read the resulting URL. Anchor-only resolution fails on 14 of 18 dynamic routes.
- Bash-style `/c/...` paths passed to `node -e` are read as `C:\c\...`. Use `C:/...` in Node args.

#### 🚧 Original in-flight notes (superseded by the above, kept for the drift numbers)

Owner report: layouts have drifted and look messy after many feature batches. Constraints: **no
redesign, no look-and-feel or branding change, no functional change.** Scope: `(dashboard)` +
Settings (**66 capture targets**; buyer portal, platform-admin and marketing are out). Owner chose
**findings-first approval** and fix depth **"structural + in-page tidying"**. Fix batches run
through `dev-pipeline`.

**Key discovery: RouteFlow already has a written design system** — `docs/design-package/project/unified/system-sheet.html`,
`ux-standards.html`, `HANDOFF-CLAUDE-CODE.md`, tokens in `packages/config/tailwind.config.ts`. It
states surfaces differ _only_ by accent and density, "never by being a different app." So this work
is **conformance to an existing spec**, not new design judgement — that is what keeps it inside the
owner's "don't redesign" line.

Measured drift (static scan of 86 dashboard `.tsx`, plus a runtime probe on prod):

| Batch  | Confirmed             | Detail                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | 16 files, **latent**  | raw `<table>` with **no** overflow wrapper. `<main>` is `overflow-x-hidden`, so if one ever exceeds its host the columns are clipped and unreachable rather than scrollable — but the runtime probe at 1440 (1200px content) measured **0 actually clipped**. Treat as a latent risk, NOT a live defect, until the 1280/1024 pass says otherwise. Worst candidates: `finance/reports` (18 tables), `settings`. |
| **L0** | **17 pages measured** | duplicate page-level `<h1>` — confirmed at runtime, not inferred (probe on `/settings` returned `h1s: ["Settings","Settings"]`). Incl. 5 settings screens, `compliance`, `finance/dashboard`, `finance/payments`, `invoices/new`, `routes/create`. Source scan counts 41 `<h1>` tags across 36 files.                                                                                                          |
| **L3** | 26 files              | hand-rolled titles, `PageHeader` never imported (it is used by only 19 files repo-wide)                                                                                                                                                                                                                                                                                                                        |
| **L4** | 96 / 49 / 31          | `rounded-xl` in 32 files · off-token `shadow-sm\|md\|lg` in 28 · `bg-black/N` scrims in 16                                                                                                                                                                                                                                                                                                                     |

> ⚠️ **LANDMINE — do not "just" retoken `Modal.tsx`.** `packages/ui/src/web/Modal.tsx:42` uses
> `rounded-xl`, and **two e2e specs select the dialog by that class string**
> (`e2e/15-stock-count-ui.spec.ts:116`, `e2e/16-variant-split-ui.spec.ts:114`). Changing it to
> `rounded-card` is invisible (12px→10px), passes typecheck and lint, and silently breaks both specs
> across 46 Modal call sites. A test-only re-selector PR must land FIRST.

**Tooling built (scratchpad only, nothing in the repo):** `audit/build-manifest.mjs`,
`audit/capture.mjs` (Playwright probe + screenshot, resumable, kill-safe per page),
`audit/static-scan.mjs`, `audit/RUBRIC.md`.

#### ▶ RESUME HERE

1. Finish the 1440 capture, then widen to 1280/1920 (+1024 for table-heavy pages).
2. Run **4 Sonnet agents max** (hard cap) over the shots+probes using `RUBRIC.md`, each appending to
   its own `findings/shard-N.jsonl` after every page.
3. Synthesise `AUDIT-LAYOUT.md` grouped **by fix batch, not by page**, and put it to the owner.
4. On approval, run each batch through `dev-pipeline`, one PR per batch, `style(web):`.

**Gotchas already paid for:**

- Playwright storage state at `apps/web/e2e/setup/.auth/operator.json` (gitignored) goes stale in
  ~2 days; refresh with `npx playwright test --project=setup` from `apps/web`. It is bound to
  **`e2e-routeflow`**, whose data is thin — good enough for structural findings, but density and
  whitespace judgements need `routeflow-demo` credentials exported as env vars.
- Pin `localStorage['rf-sidebar-collapsed']='false'` before every capture — a collapsed rail moves
  content width by 176px and poisons every width-based finding.
- **Quarantine:** 8-12 in-scope files are being edited by the parallel session
  (`customers/[id]`, `invoices/[id]`, `finance/expenses*`, `finance/payments*`, `finance/reports`,
  `vendor-bills/[id]`, `bookkeeping/[transactionId]`, `ScanInvoiceModal`). Audit them, fix them
  **last**, after that session's PR merges.

### 📌 Also raised, not started

`assertSafeSmtpEndpoint` (api `email.service.ts`) only **string-matches** the hostname, so a domain
name resolving to an internal address bypasses the SSRF guard entirely — the IP-prefix regexes only
fire when a raw IP is typed. Pre-existing; spun out as its own task.

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

## 1b. 📸 PRODUCT IMAGES + DESCRIPTIONS — partially shipped, owner review is the gate

Separate workstream from the PRs above. **No repo code is involved** — the whole pipeline
lives in `.personal/img/` (gitignored) and writes to prod only through the public API.
Full detail: `.personal/img/README.md`; memory `project_product_image_pipeline_2026-08-20`.

**Live in prod now: 941 of 1,826 `affa` products have an image.** 852 uploaded with zero
failures and 62 name corrections applied, both verified read-only against the prod DB.

| what                        | count     | state                                                             |
| --------------------------- | --------- | ----------------------------------------------------------------- |
| Images uploaded             | 852       | ✅ live, verified                                                 |
| Tier A name fixes           | 62        | ✅ live (`corrections-applied.json` keeps old names → reversible) |
| Images awaiting review      | **600**   | ⏸ held out of upload                                              |
| — of those, rejected so far | 4         | 🔄 owner review IN PROGRESS                                       |
| Descriptions ready          | **1,087** | ⏸ none uploaded                                                   |
| Tier B renames              | 25        | ⏸ owner's call                                                    |
| No image findable           | 284       | ✋ not a tooling gap — see README                                 |

**Owner review has started and the flow is proven.** 4 rejections recorded so far, and all
four are real catches the automated gates let through — a glass _bubbler_ matched to
"7 Star", _e-liquid_ matched to a Geek Bar **device**, a rebranded box ("HoneyPacks Gold,
formerly Black Thai"), and a pack-size mismatch. This is exactly why the 600 are
quarantined rather than pushed: the 852 already live were machine-judged only.

### ▶ RESUME HERE

1. **Owner reviews the 600** at
   **https://review-sheet-production.up.railway.app/r/UWT1t0Zn1MeQWCVa**
   (Railway service, autosaving, shareable with anyone — claude.ai refuses to link-share
   this content class, and republishing does not clear it). Then:
   `node .personal/img/review.mjs --apply-rejects` →
   `node .personal/img/upload.mjs --include-review --live`
2. **Descriptions:** `node .personal/img/upload.mjs --descriptions --live`.
   Least reversible of the three writes — fills only EMPTY descriptions, never overwrites
   operator copy, but there is no per-field undo.
3. **Tier B renames:** `node .personal/img/corrections.mjs --live --tier-b` — Smogger
   30K→40K ×14, Fogger Pod 45K→30K ×10, and Geek Next 50K→Geek Bar Pulse X 25K ×1
   (barcode-proven, `810203870351`).

Credentials from the environment only — `RF_USERNAME`/`RF_PASSWORD` (the tenant admin is
sufficient; TENANT*ADMIN satisfies the OPERATOR both write routes require) or
`SUPER_ADMIN*\*`as a fallback. PowerShell:`$env:RF_USERNAME = '…'`.

### ⚠️ Two things that must NOT be applied without a compliance decision

**AGFN "CBN" → "D9"** (3 products) and **ZourZ "250mg" → 100mg** (6). Both are well
evidenced, but they change a **cannabinoid designation / potency** on a tenant whose
regulated categories feed tax filings. That is the owner's call, not an inference from a
product page. Deliberately left out of both correction tiers.

### Traps worth inheriting

- **`railway up` respects `.gitignore`.** The review service source is in
  `.personal/img/review-site/`, which is ignored — deploying from there uploads an EMPTY
  bundle and fails with a railpack "no start command" error. Deploy from a copy outside
  the repo.
- **A rendered page must be verified in a browser, not with curl.** A dead script serves a
  perfectly healthy HTTP 200 with the full payload and an empty grid; that shipped once.
  `review.mjs` now refuses to write the file if the script fails `new Function(script)`.
- **Renames:** invoices snapshot the line label (`InvoiceItem.description`) so history is
  safe, but **orders read the product name live** (`OrderItem.name` is null for catalog
  lines) — so past orders re-render with the new name.
- **API throttle is 100 req/60s** and each product costs TWO requests; the uploaders pace
  at 1,400ms with 429/5xx backoff. Do not speed this up.

### Cold start — a session that knows nothing about this

Everything is **machine-local and outside git** (`.personal/` is gitignored), so this does
not travel with a clone or a fresh worktree. On this machine it is all still there.

Orientation, in order: `.personal/img/README.md` → `node .personal/img/stats.mjs` (prints
live counts) → this section. The two agent briefs (`DEEP-BRIEF.md`, `RETRY-BRIEF.md`) carry
every search technique that worked, including the dead-end brand list.

State files that matter — nothing else needs reading:

| file                       | what it is                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`            | **the source of truth** — every image: status, file path, matched name, confidence, `needsReview`, `uploaded`                    |
| `worklist.json`            | catalog snapshot from prod. **Re-pull after any rename**: `railway run --service postgres node .personal/img/fetch-worklist.mjs` |
| `descriptions.json`        | 1,087 matched descriptions, none uploaded                                                                                        |
| `corrections-applied.json` | old→new names, history array per product (reversible)                                                                            |
| `index*.json`              | ~425K harvested reference products from ~200 sources. Big (150MB+); rebuild with `harvest.mjs` if lost                           |
| `candidates/*.jsonl`       | append-only record of every image URL found. **Never overwrite** — a failed download can only be retried from here               |
| `review-site/`             | the Railway review service source + `.token`                                                                                     |

Every stage is **idempotent and resumable**: uploaders re-check each product server-side
before writing, so interrupting anything and re-running is always safe.

If `stats.mjs` and prod ever disagree, prod wins — re-pull `worklist.json` and re-run
`match.mjs --verify` to re-audit what is staged against the current gates.

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
