# HANDOFF — current state & what to pick up next

**Written:** 2026-08-19 (evening) · **Branch:** `master`, clean · **Visibility:** private · **Open PRs:** none

Everything through **PR #364 is SHIPPED + LIVE** (post-deploy check green). New today:
**#362** (D1 boxed-substitution money fixes — the 2 critical silent overcharges + tier
price on substitution, api+web+mobile, adversarially verified), **#363** (CP-07 spec
concat artifact + order-builder e2e draft leak; the 43 stale e2e drafts were also
deleted from prod), **#364** (docs). Earlier: the full 2026-08-17 mobile UX batch
#351–#361, incl. 2-hourly R2 dumps. Note: the `ebe30eb6` Railway deploys show FAILED —
that snapshot raced the private flip; its delta was e2e/docs only, and the LIVE build
`71f44020` carries all runtime code (verified). Nothing to repair; the next apps/\*\*
push will confirm the GitHub App still clones private fine (fallback: `railway up`).

---

## 1. ▶ NEXT UP — the owner drives all of these from the next session

The owner will decide who implements what (self, Claude, or an external dev). Nothing
here is blocked — this is the complete pick-up list.

1. **UX EXPANSION BATCH (owner-approved 2026-08-19) — ▶ IN PROGRESS: PR-A is BUILT.**
   Full self-contained plan at
   [`docs/plans/ux-expansion-batch-2026-08-19.md`](docs/plans/ux-expansion-batch-2026-08-19.md)
   (recon anchors, locked decisions, edge cases, 3 migrations). Owner-locked sequencing:
   **PR-A** (mobile send never dead-ends + inventory search full toolset + cross-links)
   → **PR-B** order-search-by-product + per-buyer price history → **PR-C** stock-count
   mode (single counter, multi-ready; migration) → **PR-D** generic→variant split (one
   mechanism, two entry points) → **PR-E** FIFO payment allocation AP+AR, on-account
   credit, bulk mark-paid (migration) → **PR-F** AI supplier-statement reconciliation,
   one review screen (migration).
   **PR-A status (2026-08-19 night session):** all five items built on
   `fix/a4-driver-diff-a5-buyer-token` — A4 driver-diff routing + A5 buyer token key
   (see §1.2/§1.3), **A1** mobile Send sheet gains always-visible Open PDF + "Mark as
   sent" rows, **A2** inventory search scrolls-and-highlights the row with the full
   action set (Adjust · Set cost · Movements · Open product) and `SetCostModal` is
   extracted to a shared component now reachable from the product page, **A3** the three
   cross-links (web movement→product/supplier, web customer order rows→order, mobile
   "View orders" `customerId` scoping with a dismissible chip). **PR-B is the next
   build**; its reader must query through `Invoice` with `REAL_INVOICE_STATUSES` +
   `items: { some: { productId } }`, never `invoiceItem.findMany` (nested-created lines
   can carry `tenantId = null`) — mirror `analytics.service.ts getProductDemand`.
2. ~~NEW client-facing bug: buyer-portal login broken for a new user~~ — **ROOT CAUSE
   FOUND + FIXED (2026-08-19 night session, A5).** NOT the tenant cookie: the web buyer
   portal's password login/register write only the namespaced `rf:buyer:accessToken`
   key while 7 call sites (auth context ×4, invite-accept, ConnectSellerModal,
   `useBuyerNotifications`) still read the legacy `"buyerAccessToken"` literal — which
   ONLY the Google OAuth callback backfills. So a password login (e.g. the buyer's
   second computer) never fetched the seller list → "no connection with the seller",
   nothing selectable → dashboard unreachable; invite-accept was a silent no-op. Seller
   association is server-derived (`buyerAccountId` → `CustomerLink`) and was never
   broken. Fix: canonical `getBuyerAccessToken()` (namespaced-first, legacy fallback),
   all readers migrated, admin impersonation writes the namespaced key, dashboard/
   shelf/templates queries gated on an active seller, e2e BY-14 pins "password login
   fires the authorized /buyer/sellers fetch". Worth telling the affected buyer to
   simply log in again once deployed — no data was lost.
3. ~~CRITICAL: driver edits wipe orders~~ — **FIXED (2026-08-19 night session, A4) +
   spec-pinned.** Diff-shaped payloads (`replaceAll:false` or entries with
   `id`/`action`/`substituteProductId`) from a DRIVER now route through the operator
   merge branch (price fields stripped — fresh adds at catalog price, qty edits keep
   the stored price incl. operator overrides); diff-shaped CUSTOMER payloads 400
   instead of wiping; legacy id-less driver full-lists still replace. 7 new specs in
   `orders.service.spec.ts` ("driver diff routing (A4)").
4. **Owner questions the batch needs answered** (plan §Open questions): (a) the exact
   screen/steps where mobile invoice-send blocked you (screenshot ideal); (b) should a
   committed stock count also export CSV/PDF; (c) do supplier statements arrive as
   PDFs or on paper (camera path priority); (d) do drivers collect lump-sum customer
   payments in the field (mobile AR parity sooner)?
5. **Deep-dive bug backlog remainder (B7–B14)** from
   `project_deep_dive_findings_2026-08-17` — regulated-tax drop on price adjustment,
   estimate/recurring/returns races, STANDARD-cost clobber, DRAFT-payment trap, 2
   security items (uploads cross-tenant prefixes, driver price), ActionTile double-tap,
   finance-list debounce. Small PRs, independent of the batch, unassigned.
6. **Wave 5 / Wave 6** of the mobile-first UX program (tasks #23/#24) and in-app pack
   size (#45) — see §4.
7. **New chip suggestion from the drafts-cleanup session:** harden the e2e suite's auth
   setup — full-suite runs >1h expire the operator storage state and mass-fail late
   projects on the login page (pre-existing, not a regression).

**2026-08-17/18 incident context every future session should know:** production Postgres
had NO VOLUME and was wiped by a Railway platform incident; restored from the 02:02 UTC
R2 dump (Sunday 01:40→20:00 UTC trading lost, Railway support ticket = owner). Volume +
`PGDATA` subdir now attached; Railway volume backups Daily/Weekly/Monthly (Pro) +
2-hourly R2 dumps. **Read memory `project_prod_data_loss_2026-08-17` before ANY prod DB
work.**

**Owner actions still open:** enable **Authenticated SMTP** on the M365 mailbox (the
test-send now says this itself — owner deferred 2026-08-19, "SMTP can wait"); Railway
billing auto-top-up; healthchecks.io cadence to 2-hourly; an uptime monitor on
`/api/v1/health`.
**DONE 2026-08-19:** MWI supplier renamed + alias backfill complete — 511/511 groups
migrated (441 MWI), verified in prod. Both 2026-08-19 task chips are RESOLVED (CP-07 =
spec artifact, fixed on its branch; e2e drafts leak fixed + 43 rows deleted).

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
