# Handoff — Mac mini lane 2 (Sonnet 5.5), 2026-10-12

## State at close
- **SA-779 pre-rollout fixes: LANDED in R5.2.** Branch `fix/get-side-effects-pre1013`, head `e3b8dd574bc5c69c420decd861aed341b135a051`
  (platform callback rejects non-platform state before mint; tenant callback rejects platform state before mint;
  Connect callback status check before `exchangeCode`; PDF pointer written only on change). Opus @high: PASS.
- **Connect copy nit: pushed.** `fix/connect-status-copy` head `22719075f1b69c7f622457ada804026f9994b8d3`
  (read-only / suspended / cancelled copy; shared `SUSPENDED_SENTENCE` / `CANCELLED_SENTENCE` in `packages/types/read-only-copy.ts`).
- **Row 405, PR #3395** `fix/callback-code-exchange` (base master `96fc7351f`; master has moved 2 commits, no overlap): legacy per-tenant Google
  sign-in routes retired (410), `authUrl` dropped from the Google OAuth test answer (row 411 dependency: lead drops `41668d714` from R5.3),
  web `/callback` neutralised (no session from URL tokens), platform callback fallback removed, `/auth/google/callback` code-only,
  `TenantGoogleOAuthService` deleted + structural pin, `SIGN_IN_ROUTE_RETIRED` registered. Opus @high verdicts: PASS on every delta.
  Final head: see the push message to the lead / `git ls-remote origin refs/heads/fix/callback-code-exchange`. Rides R5.3 with the catch-up
  after the owner's test-mode run — **the lead merges, not this lane.**

## Open / not mine to decide
- Bookkeeping follow-up for #3395 + the three fix branches (all carry `Bookkeeping-Follow-Up: pending`): code-map still lists the retired
  `@Get google/:tenantSlug/callback` (`.claude/code-map/api/feature-modules-1.md:9`); lessons entry candidates: (1) a "fix" that revives a dormant path
  must be re-risked as if new (a 404 redirect target had hidden a CSRF-less sign-in), (2) status-specific refusal copy needs a status switch,
  never one sentence for READ_ONLY/SUSPENDED/CANCELLED.
- **SA-779r2** (post-rollout, owned by the SA): registry classes AUTH_SESSION/AUDIT/TELEMETRY, pg-layer write detector, static AST pin,
  census + backfill with owner approval, messaging upsert by (eventKey, channel), `viewedAt` deletion. Review text: `local-assets/release-2026-10-13/sa-779-spec-review.md`.
- Report-only items: tenant `GET /auth/google/callback` accepted platform state before the mirror fix (now rejected); prod `GOOGLE_MOBILE_SCHEME`
  value unverified (repo default `routeflow://`); Connect state is single-use and burned on a refused callback (accepted, user restarts Connect).
- Parked from earlier (unchanged): R6 master-merge verify (`fix/r6-master-merge` local), tenancy chain revive/* heads, units follow-ups
  (`units-followups` @3fb057ffa) — wait for the lead.

## Worktrees
- `/Users/maznahamanullah/code/rf-wt-l2-getfx` — NOW on `feat/sr-b-admin-bulk` (clean, head `69d639bd6ff53a331d43b284990165867896addf`, pushed). Also holds the local
  branches `fix/callback-code-exchange`, `fix/verify-merge-post-confirm`, `fix/get-side-effects-pre1013`, `fix/connect-status-copy`
  (all pushed). Remove the worktree only after those land (`git worktree remove`).
- Disk was 13-16 GB free during the session; Mac mini RAM ok at last check.

## Later in the day (2026-10-12)
- **SA-779r2 spec review: GATE FAIL**, 7 must-fixes, relayed to the SA + lead (`local-assets/release-2026-10-13/sa-779r2-spec-review.md`).
  SA-779 is parked until next week (lead).
- **#3395 final head `981d3c14133591a3c07b719dd1a415fb5bffa082`** (8 commits; adds the `TenantGoogleOAuthService` deletion +
  structural pin `8f4c58d58a2c04644dfd31b4e491e10900c585f0` and `SIGN_IN_ROUTE_RETIRED` registration). Lead merges with R5.3.
- **Row 404, `fix/verify-merge-post-confirm`**, base master `2ceefe60abb5cce108b37f5b89e27e5448a0cbbd`, head
  `602494a0650165d0ab2d3dff67e9ed3d59d24b0c` (3 commits, pushed, no PR opened; rides the next train per the lead):
  GET `verify-merge/:token` is a pure preview, consume is `POST /buyer/auth/verify-merge` `{token}` (throttled, registered as a
  pre-session public buyer write), consume is compare-and-set (`updateMany` where id + token + status PENDING_VERIFICATION, count 0 -> 404),
  web page confirms on click only, `role="status"` live region. Deploy skew accepted by the lead. The GET now has no caller; the lead rows it.
  Opus @high: PASS on the first two commits; the CAS/aria commit was verified by diff + builder tests, no separate Opus pass (lead asked
  for none).
- Worktree `/Users/maznahamanullah/code/rf-wt-l2-getfx` is now on `fix/verify-merge-post-confirm` (clean).

## Branch B (portal limits admin API) — state at wind-down, 2026-10-12 late
Branch `feat/sr-b-admin-bulk`, base master `a6bd2a8a607d70e483339f5ebcb5ed750a732a30`, head `69d639bd6ff53a331d43b284990165867896addf` (pushed, normal hooks,
verify green). 14 commits: types x4 (restrictions-admin.ts + selling-restrictions.ts; zip table), B-core API (bulk create, lift-batch + chips,
readiness advisory), Addendum D (buckets, fix-state-in-place, bulk-state + undo), review fixes (identical-rule date window, blank minimal
address vs real address default + geocode skip, undo matches the row naming ALL ids, contract comment 409/404) and a text-cell guard call.
- Opus @high full-branch review: FAIL on 2 must-fix (both fixed in a739a1ba4 and dd256e58e), SHOULD-FIX 3/5/6 fixed too. NOT re-reviewed after
  the fixes (usage wind-down); the fix commits were verified by red-first tests + the non-DB sweep (69 suites/1208) + DB lane.
- DB lane run on a scratch Postgres (own container `rf_srb_pg` on 127.0.0.1:5441, migrated, dropped): 4 suites / 31 tests green on the final head.
  Recipe: `/private/tmp/claude-501/.../scratchpad/run-srb-db.sh` (docker run postgres:16-alpine, `prisma migrate deploy`, `RUN_DB_SPECS=local npx jest
  --config jest.db.config.js <specs>`). The DB specs for the address/customer routes were not exercised beyond those four.
- Contract sent to C (Mac mini landing lane) at `1230b1780b8c061c7d8ffaa48b9df00d22f17266`; later commits only change server behavior + one comment.
- Classifier denied adding an EXEMPT entry to `text-cell-writer-scan.spec.ts` ("security test removal"); fixed instead by making
  `address-state-writes.ts` call `assertSafeTextCell` (69d639bd6). Do not weaken that scan.

### Open decisions for the Lead / owner (not built)
1. **Customers in NO bucket** (Opus SHOULD-FIX 4): unresolved customers with 2+ addresses and no default, defaults naming different states, or an
   UNKNOWN-typed default among several are INDETERMINATE (legal-ban rules fail closed, checkout 409s) but appear in no bucket, so
   `customersTotal` can be 0 while the card says "Every customer has a state on file". Recommended: an additive `needsDefault` bucket
   (rows with addressId null + "Choose default address" link), counted in `customersTotal`, and the web all-clear requires it to be 0. A contract
   addition: C must code against it.
2. NIT: concurrent bulk-create / minimal-create double submits can duplicate rules / minimal addresses and bulk-state's prior snapshot is
   unversioned; an advisory lock per tenant/customer (`withAdvisoryLock`) would close it.
3. `assertReadyToEnable` in `selling-restrictions.service.ts` has no live caller (Branch A's file): remove there. Subject of `1230b1780` is 75 chars.
4. Undo expired window = 409 (contract comment now says so); C must treat 409/404 from undo as "can't undo".
5. Minimal address stores line1 = city = "" (no `incomplete` column); a blank default is replaced by the next real BILLING address.
6. Mixed-id undo request falls back to "newest row naming any id" (keeps the edited-since test green).

### Next steps if resumed
- Opus delta review of the three review-fix commits (a739a1ba4, dd256e58e, 566ecf8f3) + 69d639bd6, then hand the branch to the lead for A+B+C train.
- Decision 1 above, then a small types + API commit (needsDefault bucket) and a DB run via the recipe above.
- PRs are not opened for Branch B or the fix branches (lead lands them).

