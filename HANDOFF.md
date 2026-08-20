# HANDOFF — current state & what to pick up next

**Written:** 2026-08-20 · **Branch:** `master`, clean · **Visibility:** private · **Open PRs:** none

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
