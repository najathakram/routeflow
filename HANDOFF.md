# HANDOFF — current state & what to pick up next

**Written:** 2026-08-17 · **Branch:** `master`, clean · **Visibility:** private · **Open PRs:** none
**Working tree:** clean except the usual untracked personal files (`.personal/`, this file, `docs/audit/`).

Everything through PR #349 is SHIPPED + LIVE (credit-restore landed as #341 on 2026-08-14;
#343–#349 were e2e/db/seed repairs and the web list-search Back fix #346).

---

## 1. ▶ NEXT UP — mobile UX batch (planned + APPROVED 2026-08-17, not started)

**Execute from the approved plan — it is the source of truth:**
[`docs/plans/mobile-ux-batch-2026-08-17.md`](docs/plans/mobile-ux-batch-2026-08-17.md)
(committed copy; original lived at `~\.claude\plans\i-noticed-a-couple-lazy-elephant.md`)

Ten owner-reported items (Zoho screenshots as a _simplicity_ reference — keep RouteFlow's
look/icons). Six PRs, ship **sequentially in this order**, each through the canonical
rebuild routine (`npm run verify` → public → push/CI → squash-merge → private
IMMEDIATELY with read-back → watch deploy → `SMOKE_BASE_URL=… npm run post-deploy-check`),
code-map updated surgically per PR (Stop-hook enforced):

| PR   | Content                                                                                                                                                                                                                                                                          | Notes                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| PR-1 | Two guaranteed-400 fixes: Send tile on pending-mirror invoices; demotions missing required `reason` (ReasonSheet)                                                                                                                                                                | small, ship first      |
| PR-2 | Shared scan ladder (`lib/scan-ladder.ts`) → scan-to-create + ambiguous-pick in edit-items + draft-invoice edit; quiet catalog (`visibleCatalogRows`, browse behind a button)                                                                                                     | mobile only            |
| PR-3 | Parked drafts: mirror web `/drafts` (SaleDraft), 900ms continuous autosave, DraftStrip resume on orders+invoices lists                                                                                                                                                           | backend already exists |
| PR-4 | Post-confirm flow: no auto-open of locked invoice; "Deliver & send invoice" primary; invoice-builder van-sale via `POST /orders/sell` (`deliveredNow`)                                                                                                                           |                        |
| PR-5 | Scanner: match memory on ProductAlias (tenant-safe; fixes live ProductMapping cross-tenant bug), learn-on-confirm-only, "Remembered match" badge, backfill script; boxes/pieces unit toggle (web modal + new mobile LineEditSheet), `roundUnitCost`, web bill-detail prefill bug | api+web+mobile         |
| PR-6 | Products-list search/filter/scroll restore (`list-ui-snapshot` + `listUiStore`); product↔movements links (fix mislinked Warehouse quick-action); WhatsApp share attaches the PDF via share sheet; SMTP diagnostics (requireTLS 587, mapped test-send errors)                     | SMTP last per owner    |

**Locked owner decisions (do NOT re-ask):** WhatsApp = PDF via OS share sheet (wa.me text
= fallback with toast; recipient no longer preselected); van-sale "Delivered today?"
default ON (falls back to plain `POST /invoices` when per-line tax/discount/terms in
use); browse + category chips behind a "Browse catalogue" button; non-divisible pieces
stay pieces + warning (never fractional cases); scan prompt gains `unitLabel` hint
(preselect only, never auto-convert); clearing a remembered match = forget (unlearn).

**Execution facts:** NO Prisma migrations anywhere in the batch (ProductAlias +
InvoiceScan.supplierId already in the baseline). One manual data script after PR-5
deploys: `railway run --service postgres node apps/api/scripts/backfill-product-aliases.mjs`
(dry-run default, `--apply` to write, idempotent). Don't touch driver route/stop flows,
buyer portal, ScanOrderSheet internals, or pricing helpers beyond the additive
`roundUnitCost`. Full per-PR file lists, signatures, Jest specs, and the manual
browser-verification checklist are in the plan file.

**Likely SMTP root cause to tell the owner:** the Microsoft mailbox almost certainly has
"Authenticated SMTP" disabled (M365 default) — admin center → Users → Active users →
select user → Mail → Manage email apps → tick Authenticated SMTP. PR-6 makes the
test-send say this itself; OAuth2/Graph is a deferred follow-up needing owner's Azure
app registration.

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
