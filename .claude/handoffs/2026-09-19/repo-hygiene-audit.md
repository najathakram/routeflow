# RouteFlow repo hygiene audit — 2026-09-19 (read-only)

Snapshot ~06:00Z 2026-09-19, fleet live (main checkout mid-fast-forward elsewhere). Every number
below is from a command shown inline; re-run to refresh.

## 1. Worktrees

`git -C C:/ClaudeCode/routeflow worktree list --porcelain` → **73 worktrees**, all present on
disk (`git worktree prune --dry-run` → empty output, nothing to prune structurally).
`git ls-remote --heads origin` → **176 branches** on origin.

Cross-referenced every branch against `gh pr list --state merged --json headRefName --limit 1000`
(821 merged PRs) and `gh pr list --state open` (**only 1 open PR: #936 feat/l1-schema-spine**).
`merge-base --is-ancestor HEAD origin/master` returned NO for almost every merged branch — the
known **squash-merge ancestry trap** (`reference_squash_merge_ancestry_trap.md`): a squash creates
a new commit on master, so the branch's own tip is never its ancestor even though its diff
landed. The gh-PR cross-reference is the reliable signal here, not `--is-ancestor`.

**KEEP (6)** — active today per `BOARD.md`: `routeflow` (main, master) · `rf-lane-1`
(feat/l1-schema-spine, OPEN PR #936, next to land) · `rf-codemap` (docs/code-map-refresh, today) ·
`rf-pr0b-publish-repin` (feat/pr0b-publish-and-repin-report, today) · `rf-docs`
(docs/coord-bookkeeping-2026-09-19, today) · `.claude/worktrees/rf-sweep-390` (detached, Lane F's
shared local-stack worktree — board: "stack warm & kept").

**PRUNE (49) — branch confirmed MERGED via gh PR data.** Split in two, both zero-risk:
- *Clean* (23): rf-B523-fix, rf-B533-buyer-tables, rf-B535-testfix, rf-B536-total-users-staff,
  rf-B556-B557-mrr, rf-B559-mobile-overflow, rf-B562-hide-recompute, rf-B915-ackfix,
  rf-C2C3-detail-audit, rf-email-brand, rf-lineitem-row-extract, rf-registry,
  rf-registry-hygiene, rf-returns-pr1c, rf-special-tier, rf-ack-unmet-requires,
  rf-B525-dead-addons-tab, rf-lock-hotfix, rf-roundmoney, rf-scan-in-create-order,
  sleepy-lumiere-df3b53, wt-B562-fix (PR #934 merged 05:45Z — board's BLOCKED stash concern is
  moot: `git stash list` in that worktree has 11 entries but **git stash is shared repo-wide**,
  none reference this branch), wt-pr871-followup.
- *Merged but "dirty"* (24): magical-dirac-33c8de, rf-B421, rf-B471,
  rf-B519-driver-payments-requires, rf-B544-mrr-comment, rf-contrast-sweep, rf-D5-perm-guards,
  rf-D5-void-reuse, rf-dashboard-tenant-counts-deletedat, rf-F27-build, rf-F39,
  rf-feature-grants-pr1, rf-fg-b-v2, rf-fg-c-v2, rf-fg-d-enable-addon, rf-lane-a, rf-laneC,
  rf-marketing-abc, rf-newsite, rf-outlook-v2, rf-override-gate, rf-phase0d, rf-sidebar,
  site-pr3-merge. Verified every one of these `status --porcelain` diffs is confined to
  `.claude/pipeline/*.json(l)`, `.claude/campaign/bugs*`, or untracked `**/.claude/` dirs —
  session bookkeeping noise, **zero source-code changes** — real evidence, not a guess.
- Plus 2 ephemeral scratch clones with zero unique work: `rt3-feat-l1-schema-spine` (temp
  session dir; its 2 commits are identical to rf-lane-1's tip + an empty "ci: retrigger") and
  `rf-master` (temp session dir, 2026-09-14, clean, matches an old master point).

**SALVAGE (18)** — real work with NO open PR and NOT already merged. *Correction*: an earlier
draft of this table wrongly listed `rf-D5-void-reuse`/`rf-dashboard-tenant-counts-deletedat`
here — both are already merged (PR #913, #911, confirmed via `gh pr list --state merged --search
"head:<branch>"`) and belong in PRUNE's "merged but dirty" list above. Full LAND/FOLD/DROP triage
for all 18, with evidence, is in `local-assets/salvage/2026-09-19/TRIAGE-unmerged-worktrees.md`
(§9) — export a patch before pruning any of these (see §8):
| Worktree | Branch | Unc | Ahead of origin/master | On origin | Note |
|---|---|---|---|---|---|
| rf-migrate | ops/migration-batch-2026-09-17b | 0 | 15 | **no** | 15 commits, local-only, no backup |
| rf-871-fix | DETACHED | 2 | 4 | no | detached + local-only, highest loss risk |
| rf-crm-cloud | feat/crm-phase1 | 4 | 17 | yes | sizable unmerged CRM feature, needs a decision |
| rf-zap | chore/road63-local-dast | 0 | 3 | no | local-only |
| rf-ops24 | fix/ops33-audit-batch1 | 0 | 1 | no | local-only |
| rf-mobile-audit | DETACHED | 1 | 0 | yes | untracked `apps/web/mobile-audit/` — real, not `.claude` |
| rf-site-pr3 | feat/site-redesign-pr4-auth | 0 | 36 | yes | backed up on origin; no open PR — land or close |
| rf-B440 | DETACHED | 3 | 0 | yes | dirty only in `.claude`; detached but == origin/master |
| rf-B451, rf-B504, rf-B522-admin-recipients, rf-B523-file, rf-checks-pr1, rf-deliveries-mobile-sheet, rf-demo-avail, rf-legal-pages, rf-mrr-ledger-drift-report, rf-notify-n3 | various | 1–13 | 1–7 | yes | pushed to origin already (low loss-risk); no PR opened — triage batch |

**Origin branches with no worktree**: 138. Cross-referenced against the 821 merged PRs:
**119 are deletable candidates** (their branch name matches a merged PR's `headRefName`) — safe
to delete on origin with `git push origin --delete <branch>` (OWNER-APPROVAL, see §8). The other
19 have no merged-PR match (open/closed-without-merge/never-PR'd) — check individually with
`gh pr list --search "head:<branch>"` before deleting.

## 2. Main checkout

`git status --porcelain=v1` (C:/ClaudeCode/routeflow): 2 tracked modifications
(`.claude/pipeline/agent-log.jsonl`, `.claude/pipeline/approach-rotation.json` — pipeline
bookkeeping, expected churn) + 12 untracked paths grouped by dir: `.claude/handoffs/` (9 files),
`marketing/` (3 binaries), `.claude/pipeline/2026-09-1{7,8}-session-*/` (2 run dirs).

`git ls-tree -r -l origin/master | sort -k4 -nr | head -15`: only one file over 1 MB —
`docs/design-package/project/RouteFlow Wholesaler Reel.html` (1,670,873 B) — likely a design
export with inline base64 images; candidate for `local-assets/` or stripping images.
`package-lock.json` (1.3 MB) / `apps/api/package-lock.json` (566 KB) are expected lockfile size.

`marketing/RF_logo_nb.png` (460 KB), `marketing/RF_logo_wb.png` (1.1 MB),
`marketing/RouteFlow_Brand_Guide.pdf` (244 KB) are **untracked binaries outside any heavy-files
exception** (`apps/web/public/brand|marketing`, `apps/web/fonts` are the only exempted dirs) —
per CLAUDE.md policy these belong in `local-assets/` (gitignored), not `marketing/` at repo root.

## 3. Giant files (apps/ + packages/, by bytes, source only) — 30-day PR-touch hotspots

| File | Bytes | Lines | Commits/30d |
|---|---:|---:|---:|
| apps/api/src/orders/orders.service.ts | 334,386 | 6,728 | **38** |
| apps/api/src/invoices/invoices.service.ts | 299,179 | 6,412 | 31 |
| apps/api/src/orders/orders.service.spec.ts | 374,801 | 9,511 | 28 |
| apps/api/src/customers/customers.service.ts | 141,952 | 3,307 | 27 |
| apps/api/src/invoices/invoices.service.spec.ts | 389,502 | 9,351 | 27 |
| apps/web/app/(dashboard)/customers/[id]/page.tsx | 184,941 | 4,378 | 22 |
| apps/web/app/(dashboard)/orders/[id]/page.tsx | 162,857 | 3,728 | 21 |
| apps/api/src/customers/customers.service.spec.ts | 137,645 | 3,209 | 20 |
| apps/api/src/routes/routes.service.ts | 137,329 | 3,270 | 16 |
| apps/web/app/(dashboard)/products/[id]/page.tsx | 138,584 | 2,942 | 12 |
| apps/mobile/app/…orders/[id]/edit-items.tsx | 133,183 | 3,315 | 13 |
| apps/mobile/components/NewOrderScreen.tsx | 178,826 | 4,556 | 10 |
| apps/web/app/(dashboard)/inventory/page.tsx | 135,332 | 3,303 | 9 |
| apps/web/app/(marketing)/marketing.css | 220,637 | 9,941 | 8 |
| apps/web/components/ScanInvoiceModal.tsx | 151,890 | 3,134 | 4 |

`orders.service.ts`+spec and `invoices.service.ts`+spec are the four biggest files AND the
busiest (27–38 touches/30d) — every PR near orders/invoices risks a conflict. `customers/[id]/
page.tsx` and `orders/[id]/page.tsx` (the giant page files CLAUDE.md/the board already name for
"prefactor first") are independently confirmed hot (22, 21). No packages/* file made the top 15.

## 4. Prettier drift

`npx prettier --check "apps/**/*.{ts,tsx}" "packages/**/*.{ts,tsx}"` → **5 files**, all `.ts`:
`apps/api/src/bookkeeping/dto/create-expense.dto.ts`, `apps/api/src/common/sentry-exception.filter.ts`
(api: 2); `apps/web/lib/api/batch-import.ts`, `apps/web/lib/api/payment-requests.ts`,
`apps/web/lib/plan-gate.ts` (web: 3). packages/*: 0. Far smaller than the historical "~130 files"
memory note — a scoped `prettier --write` on just these 5 (never a repo-wide `npm run format`,
per `reference_engine_format_step_dirties_worktrees`) closes the gap cheaply.

## 5. Dead code / TODO debt

`npx --no-install knip --version` did not resolve in 60 s without installing → **skipped per
instructions** (would need `npm i -D knip` first, which is a write action outside this audit's
scope).

`git grep -n -E "TODO|FIXME|XXX" origin/master -- apps packages` → 10 raw hits, 6 false positives
(`PAY-XXXX-####`/`PLT-XXXX`/`XX-XXXXXXX` placeholders, package-lock hash substrings). **4 real
TODOs**: `apps/mobile/app/(operator)/(tabs)/warehouse.tsx:296` (blame 2026-04-28, ~5mo old,
"replace with Modal picker"); `apps/api/src/common/invoiced-sales.ts:212` (blame 2026-09-17,
B459); `apps/web/app/(platform-admin)/admin/tenants/[id]/_features/types.ts:4` and
`apps/web/e2e/49-feature-console.spec.ts:327` (both blame 2026-09-17, same "brief C" mock). Very
low TODO debt — not a hotspot.

## 6. Test-suite shape

Spec counts (origin/master): api 400 `*.spec.ts` · web 111 `*.test.tsx` + 49 `e2e/*.spec.ts` ·
mobile 153 `__tests__/*.test.ts` (matches CLAUDE.md's pure-logic convention) · packages 7.

Skip markers (`it.skip(`/`test.skip(`/`describe.skip(`/word-boundary-safe `xit(` — a naive `xit(`
pattern false-matches `exit(` and inflated an early pass to 339; corrected count is **95**),
concentrated almost entirely in Playwright e2e, not Jest: `e2e/04-buyer-portal.spec.ts` (11),
`12-search-back-nav` (9), `21-destructive-guards` (8), `47-lite-plan-gate`/`05-cross-cutting` (6).

**Self-skip-on-missing-fixture, confirmed**: `apps/web/e2e/50-routes-dispatch-mode.spec.ts:39` —
`test.skip(!tenantId, ...not found — seed it first)`. Exactly the "check that can't check" shape
the board already flagged as **B566** (local:seed leaves e2e-routeflow with 0 customers/products,
so specs self-skip green instead of failing) — independently corroborated; likely other specs
share the risk.

## 7. Lockfile / deps

`npm ls --depth=0 2>&1 | grep -iE "invalid|missing|extraneous"` → 1 line:
`@img/sharp-wasm32@0.35.4 extraneous` (benign — unused optional native-binary variant of `sharp`).
Open Dependabot PRs: `gh pr list --author app/dependabot --state open` → **0**.

## 8. Recommendations (ordered by value/cost)

1. **Prune the 49 confirmed-merged worktrees (§1, script in §9)** — reclaims the most disk for
   the least risk; 28 of 73 worktrees carry a full `node_modules` (main alone measured 2.1 GB;
   sizing all 28 timed out mid-audit, budget ~2 GB × 28 ≈ 50–60 GB total). OWNER-APPROVAL.
2. **Salvage the 18 real-unmerged worktrees before any cleanup pass (script + triage in §9)** —
   4 have zero remote backup (rf-migrate, rf-871-fix, rf-zap, rf-ops24); 12 of the 18 turned out
   to be superseded duplicates on inspection, only 3 are real unlanded work worth landing.
3. **Delete the 119 already-merged origin branches with no worktree (§1, script in §9)** —
   OWNER-APPROVAL; the 19 unmatched ones need `gh pr list --search "head:<branch>"` individually
   first, don't bulk-delete those.
4. **`orders.service.ts`/`invoices.service.ts` (+specs) are both largest AND busiest (§3)** —
   highest conflict/review cost in the repo; ratchet target: extract one cohesive slice per
   sprint into its own service, characterization test first, same pattern as PR #933's `LineItemRow`.
5. **Prettier: fix the 5 drifted files directly (§4)**, `npx prettier --write` on just those
   paths — small enough to not need a "quiet window" repo-wide format.
6. **B566 is real and independently confirmed (§6)** — `50-routes-dispatch-mode.spec.ts` and
   likely siblings self-skip instead of failing on a bad seed; the existing board ticket already
   covers the fix (seed customers+boxed product, make the spec fail not skip).
7. **`marketing/*.png|pdf` (§2) should move to `local-assets/`** — outside every heavy-files
   exception dir, will land in git on the next broad `git add`.
8. **knip wasn't runnable read-only (§5)** — a follow-up task should explicitly `npm i -D knip`
   (a write action) rather than folding it into a read-only audit.
9. **`docs/design-package/.../RouteFlow Wholesaler Reel.html` (1.6 MB, §2)** — the only tracked
   file over 1 MB; check for embedded base64 images to strip or externalize.
10. **git stash is shared across every worktree (§1, wt-B562-fix finding)** — 11 entries from
    unrelated branches/sessions piling up on one shared stack; review periodically so a real
    stash isn't lost in the noise.

## 9. Files generated (owner-runnable, WRITE-ONLY — none executed)

All under `local-assets/salvage/2026-09-19/`:

1. **`salvage-zero-backup.sh`** — bash, 6 trees × 4 commands (bundle + 2 patches + commit list).
   rf-migrate, rf-871-fix, rf-D5-void-reuse, rf-dashboard-tenant-counts-deletedat, rf-zap, rf-ops24.
2. **`TRIAGE-unmerged-worktrees.md`** — all 18 SALVAGE trees: last-3-commits, diffstat, a guess,
   a verdict. **LAND 3 · FOLD 1 · DROP 12 · OWNER-DECIDES 2** (rf-migrate, rf-site-pr3, 3 lines
   each). 12 of 18 are duplicate/superseded attempts already shipped under a different branch/PR.
3. **`prune-merged-worktrees.cmd`** — cmd, 49 trees: 23 clean + 24 dirty-only-in-`.claude` (each
   pair commented with its PR#) + 2 detached scratch clones. 6 KEEP trees excluded, named at top.
4. **`delete-merged-origin-branches.sh`** — bash, 119 `git push origin --delete` lines (PR#
   commented) + 19 `# CHECK:` lines for unmatched branches at the bottom (not commands).
