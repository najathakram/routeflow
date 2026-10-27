# Mac lane (Opus 5.5): product area — MASTER WORK LIST (updated 2026-10-14 evening)

**Read this first in the next session.** Every open item for the product area is below, with an ID.
Nothing here is done until it carries a sha + proof path. When you finish an item, mark it
`DONE <full sha> <proof path>`; never delete a line. A new defect found in passing gets a new ID
here before the session ends; it is never only mentioned in chat.

Standing rules: CLAUDE.md canonical deploy flow; never force-push / --no-verify / SKIP_VERIFY /
HUSKY=0; never touch hooks, never `npx husky`, never plain `npm ci`, never `git stash`; test
tenants only; no client names in git; never lose a feature (removals only owner-approved); prod DB
only via the lead with per-run owner approval; tool refusal → report, never work around; pushes
serial; delete `apps/web/.next` before any push from a tree that ran a capture build. Weekly usage
95% (lead, 2026-10-14): wind-down ladder. #3471 and #3472 are PARKED for the next window; start nothing new; B1–B7 held.

**Next step for the next session:** wait for the lead's window. In it, #3471 rides the S3 window. Rebase #3472
(`feat/product-batch-a`, `~/code/rf-wt-batch-a1`, HEAD `8e816a9190fdf68d80884231e7c98746b82c7167`; S3 ALREADY MERGED IN 2026-10-14) — no rebase needed unless master moves; then
S3 tip the lead sends, re-run the gates, then CI → merge → the bookkeeping PRs (P0-BK, A-BK).

## 0. Status board (one line each)

| ID | Item | State | Next action |
|---|---|---|---|
| P0 | Buyer cart qty/box split (row 531) — PR #3471 | MERGED 2026-10-15 as `b11da7eb9213f20362a75a90153ce9d44b7b92b4` (lead) | P0-BK bookkeeping PR (check whether the lead already opened it) |
| P0-BK | Bookkeeping follow-up for #3471 | Not started | After merge (§1) |
| A | Product-page Batch A (one PR) | MERGED 2026-10-15 as `c6f82d523cda7ea35646c3c8ffa777b163b913e8` (lead) | A-BK bookkeeping PR (check whether the lead already opened it) |
| A-FIX D1–D5 | Capture defects in Batch A | DONE: D1+D4 2b17b6e39, D3+D5 5d1bcd3c1; gates tsc 0, web jest 546/6367, ratchet 16/16; one combined re-shoot PASS `local-assets/proofs/2026-10-14-batch-a/fix/NOTES.md`; D2 → FU-7. | §2.2 |
| A-J3 | J3 arrow-pair question | Checked: two pairs, different jobs, both kept; asked the lead (OWN-5) | §2.3 |
| B1 | #3466 R1–R3 folds | HELD (merges with B3) | §3 |
| B2 | Regulated attrs at read time | PAUSED, uncommitted in `~/code/rf-wt-r466` | §3 |
| B3 | Frozen displayName on documents | Not started | §3 |
| B4–B7 | One PR | Not started | §3 |
| AUD-B…F | Audit Batches B–F | Not started; lead schedules | §4 |
| OWN-1…5 | Owner decisions open | Waiting | §5 |
| FU-1…6 | Follow-ups (copy/cosmetic/edge) | Not started | §6 |
| ENV | Audit stack teardown | DONE 2026-10-15: stack torn down; owner ran the worktree cleanup (22 merged worktrees + branches removed, incl. rf-wt-r479 = ENV-1); disk 0.2 GB → 32 GB free | §7 |

## 1. P0 row 531 — PR #3471 (https://github.com/najathakram/routeflow/pull/3471)
- Tree `~/code/rf-wt-cartqty`, branch `fix/p0-buyer-cart-qty-split`, HEAD `96dc925598aeb6b30fc9d0fce6d4e801a4516d55` (on origin; PR bound to the Mac session). No CI yet.
- Rulings: `local-assets/handoff/2026-10-14-row531-buyer-cart-p0-ruling.md`; folds: `local-assets/handoff/2026-10-14-row531-review-folds.md`; PR body `/private/tmp/claude-501/cartqty-proofs/pr-body.md`; captures `local-assets/proofs/2026-10-14-p0-531/` (+ `v2/`).
- **P0-1** Lead's public window: CI green → squash-merge → wait both Railway deploys SUCCESS → flip private → post-deploy-check. (Lead owns the window.)
- **P0-BK** Bookkeeping follow-up PR right after merge, citing the merged sha: code-map entries (buyer-cart-line.ts, CartLineUnit/CartRowQty, qty-split-consistency.ts, buyer-qty-split.ts, census script) + lessons: (a) "a record with dependent fields is re-derived from one source on every mutation, never spread"; (b) "a capture build's `.next/types` breaks web check-types — delete `.next` before push"; (c) "BSD sed has no `\b`; use perl for word-boundary renames".
- PR body must state: qty wins on hydration (banner on corrected lines); repack keeps Case count for a Case line, pieces for an Each line; boxed→unboxed lines become pieces; S4 template reorder warn-only; mobile reorder after repack now 400s "Pack sizes changed…"; census script owner-run, read-only, upper bound.

## 2. Batch A — product page (lead's order: one PR, keep on e6aec7cd7, rebase on the S3 tip when the lead sends it)
- Tree `~/code/rf-wt-batch-a1`, branch `feat/product-batch-a`, NOT pushed. Commits on e6aec7cd7: de6e1be10 P-14 · a378949ca P-17 toast · b1af08e92 P-01..P-04/P-17/J3/J7 · 9475480d5 J3 revert · f94c80897 P-15 · 1fdc66871 J8/J9/J10 · 9ff923fff J9 fix (+ fix-pass commits — read `git log` for them).
- Gates before the fix-pass: web tsc 0; web jest 546 suites / 6361 tests; size ratchet 16/16; J9 test red 3/3 on master's card. Logs `/private/tmp/claude-501/batch-a-proofs/`.
- Captures: `local-assets/proofs/2026-10-14-batch-a/` (68 PNGs + NOTES.md) — every item passed.

### 2.1 Remaining steps (in order)
1. **A-FIX** finish D1–D5 (§2.2) — ALL fixes first, then ONE combined re-shoot at 1440/768/390 into `local-assets/proofs/2026-10-14-batch-a/fix/` (owner instruction).
2. **A-SIGN** Opus apple-ux/apple-design sign-off on the combined re-shoot — PASS per item, written to that folder's NOTES.md.
3. **A-PUSH** `rm -rf apps/web/.next`, push serially, read the full push log, confirm with `git ls-remote`.
4. **A-PR** open ONE PR. Body must name: the app-wide ConfirmDialog change (danger default now opens focused on Cancel, ~35 callers); the J3 revert (§2.3); the Deactivate capture substitution (Legacy Chips already inactive → Rich Snack Bar used); `Bookkeeping-Follow-Up: pending` trailer on HEAD.
5. **A-SHA** send the lead the full sha from same-turn command output (not in the same batch as the commit).
6. **A-REBASE** when the lead sends the S3 tip: rebase; expect `page.tsx` conflicts with #3468/#3467/#3465; re-run gates; re-push (never force-push without the lead — ask).
7. **A-BK** bookkeeping follow-up after merge (code map for ProductEditActions.tsx, ProductHeaderLine.tsx, ConfirmDialog `warning` variant, ProductStockCostCard, ProductInsightsExport).

### 2.2 Capture defects (fix-pass; mark each DONE with sha)
- **D1** 390: secondary header actions wrap raggedly (Edit alone left, others right) — `rich-view-390-s1.png`.
- **D2** Family page two "Never sold" cards — **PRE-EXISTING on master** (DemandCard.tsx + SalesHistoryCard.tsx, untouched by this branch; Opus lead checked `git diff e6aec7cd7..HEAD`). Moved to **FU-7**, not dropped.
- **D3** 1440: "On hand (not yet split to variants)" label and value wrap side by side — `rich-view-1440-s1.png`. Worse at 390: "split to417 pcs" collision (from our J9 commit). Spec: row gap-3, qualifier becomes a block caption "Not yet split to variants" under "On hand", value shrink-0 nowrap right.
- **D4** 768: hero image cover-crop looks cut off — `rich-view-768-top.png`. Also at 390. Spec: object-contain below lg, lg+ keeps cover + focal point.
- **D5** Sticky edit bar (`ProductEditActions.tsx` StickyEditBar) lacks a `prefers-reduced-transparency` solid fallback.

### 2.3 A-J3 — arrow pair (OPEN, do not lose)
**Finding (fix re-shoot 2026-10-14, rich-view-768-top.png):** the image card has two arrow pairs — large round carousel prev/next on the photo (navigate), and small ‹ › under the thumbnails (Move left/right = reorder). They do different jobs; the reorder pair is the only reorder control, so it stays. Ask the owner (OWN-5): remove nothing, or relabel the reorder pair (e.g. "Move earlier/later")? Do not remove either without the ruling.
Owner approved J3 as "remove the **second** image arrow pair". The builder removed the Move left/right reorder arrows; I reverted (9475480d5) because those are the only reorder control. **Check:** is there a genuine second/duplicate arrow pair (e.g. carousel prev/next vs reorder)? If yes, remove only the duplicate (owner-approved). If no, report to the lead that J3 is a no-op / relabel question for the owner. Either way record the outcome here and in the PR body.

## 3. Bug PRs (wind-down: each needs the lead's go)
- **B1 #3466** at `29f54481a8979678c970beac6d22bf81287beb7a`: HELD, merges only with B3. SA PASS with REQUIRED R1–R3 to fold: census call counts + write-block count; `name:`-only writers + raw SQL; prefix-only → coded 400. Rulings `local-assets/handoff/2026-10-14-row527-rulings.md`.
- **B2** regulated attributes resolved at read time: PAUSED. 16 uncommitted paths in `~/code/rf-wt-r466` (branch `fix/b2-variant-regulated-read-time`). Do NOT stash; on resume commit WIP through hooks.
- **B3** frozen displayName on documents: not started.
- **B4–B7** one PR: B4 mobile-only (send parentProductId/variantName null on clear; base on #3467); B5 staff search; B6 family stock status; B7 required non-empty name.
- Then B1 + B2 + B3 go to the SA together (SA reviews via the lead only; no SA live now).
- Other open PRs: #3455 (510) FINAL PASS `91876c65b1006705fa98b7de6fb610cddcf834f9` — waits L8 + owner migration sitting, then the L8 swap (delete jurisdiction.ts). #3465 PASS `038e8e66f4142d12aabc25f3763a90877375e017`. #3463 FINAL PASS `67b84bb12204e10a5e9c9ac082e3230962136e41`.

## 4. Audit Batches B–F (plan: `local-assets/apple-ux/2026-10-14-product-page-audit/PLAN.md` §3, rulings §7)
Owner page: https://claude.ai/artifact/Wzmbr3BFARQkdMYkJmev2P. Each batch = own PR, captures 1440/768/390, apple-ux sign-off, `verify` + `local:validate` (+ `local:e2e` for B/E).
- **AUD-B** Targets and feel (web+ui): P-16, P-21, P-11, P-13, P-06; + P-12 (approved); J4, J5.
- **AUD-C** Craft and copy (web): P-05, P-22, P-23, P-24, P-25, P-26, P-27, P-28. (Check overlap with D3/P-23 and the sales-card move P-22 vs J10.)
- **AUD-D** Restrictions copy (web): P-07, P-08, P-09, P-31; J2; J12/J13 copy. **After #3465 merges.**
- **AUD-E** Family and variants (web): P-10 (+P-10e On hand column), P-18, P-20, P-19 (approved); J6. **After B1**, preview after **B3**, P-20 after the Unlink fix (M2), limits copy after **B2**.
- **AUD-F** Mobile parity: P-29, P-30; J1. **Not approved:** Deactivate on mobile detail — do not build.
- **Later (owner):** J11, J14.

## 5. Owner decisions open (ask via the lead)
- **OWN-1** P-29 photo × behind a Photos "Edit" tap.
- **OWN-2** P-31 restricted-search hint wording.
- **OWN-3** P0 row label "2 Cases (24 ea)" (plural vs SA's "2 Case").
- **OWN-4** Cart badge / "Subtotal (N items)" counts pieces — keep?
- **OWN-5** J3 outcome if §2.3 finds no duplicate pair.

## 6. Follow-ups (not in any open PR — each needs a home before it's dropped)
- **FU-1** Copy: "per each" caption beside a box price (shop tile + cart row).
- **FU-2** Summary counts pieces (copy).
- **FU-3** Cosmetic: P0 banner OK link wraps at 390; cart FAB covers a card corner.
- **FU-4** Edge: dashboard Add on a stale-pack line of a now-unboxed product merges as +12 pieces (banner shows; money consistent).
- **FU-5** Favourites Case/Each toggle never captured (only favourite is unboxed) — capture when a boxed favourite exists in `test`.
- **FU-6** Bugs (a)–(g) logged by the lead as row 533 — track there.
- **FU-7** Never-sold product shows two stacked "Never sold" empty states (DemandCard + SalesHistoryCard) — show one. Pre-existing on master; own small web PR (fits AUD-C).

## 7. Environment
- Audit stack TORN DOWN 2026-10-14 (lead order at 95%): stopped API 63420 (:3280, tree rf-wt-r479) and Expo 87698 (:3282); removed container `rf_audit_redis`; dropped DB `rf_audit_prod` on `rf_pr6_pg` (container left running; other lanes own its other DBs). No prune.
- **ENV-1 (not done, owner decides):** remove the audit build outputs listed in STACK.md line 23 (rf-wt-r479 web/api build dirs, /private/tmp/rf479, the API local upload folder). The auto-mode classifier refused the step; per the tool-refusal rule I did not work around it. Disk is fine (50 GB free), so it is low priority.
- `apps/api/dist` remains in rf-wt-cartqty.
- Plugin `intent@intent` (ghaida/intent) installed at user scope.
