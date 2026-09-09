# Wave 2026-09-09 bookkeeping follow-up — finishing commands

Prep done in `docs/wave-2026-09-09-bookkeeping` (Option B) wrote analysis sections (Summary /
Root cause / Fix approach and UX / Test plan) for the rows below via `note --section`, but could
not `prove`/`discharge` them because the PR numbers/shas were still placeholders. Run these once
the three PRs are open (fill in real numbers/shas), from a worktree on the merged tree, as ONE
Bash command each in the `cd "<worktree>" && BUGS_ROOT="<worktree>/.claude/campaign" node
scripts/campaign/bugs.mjs …` shape (see CLAUDE.md — never bare `sync`, only `sync --check`).

## Train 1 — fix/train1-driver-teardown (681 / 8de65863) — batch F19

```
node scripts/campaign/bugs.mjs prove B111 --pr 681 --proof "REG-B111 relaunch reconciliation against existing artifact ids produces no duplicate append"
node scripts/campaign/bugs.mjs prove B136 --pr 681 --proof "REG-B136 podStore persists and reconciles against existing artifact ids on relaunch"
node scripts/campaign/bugs.mjs prove B137 --pr 681 --proof "REG-B137 offline-queue-identity: a queued action stamped for user A is never replayed for user B"
node scripts/campaign/bugs.mjs prove B140 --pr 681 --proof "REG-B140 session-teardown: sign-out clears every user-scoped store; tenant slug survives"
node scripts/campaign/bugs.mjs prove B150 --pr 681 --proof "REG-B150 session-teardown: sign-out from the operator realm stops background location tracking"
node scripts/campaign/bugs.mjs discharge F19 --evidence "681 (8de65863) merged; deploy green"
```

Note: B143 is bookkeeping-only for this batch (already fixed via F30/R6 queue-drain) — no
prove/discharge action needed here, confirm it shows proven/closed already when F19 is discharged.

## Train 2 — fix/train2-operator-gaps (682 / 7d8141e0) — batch F20

```
node scripts/campaign/bugs.mjs prove B04 --pr 682 --proof "REG-B04-A/B push preference gates registration and send path"
node scripts/campaign/bugs.mjs prove B142 --pr 682 --proof "REG-B142-A/B/C/D archived-product guard at interactive edges only"
node scripts/campaign/bugs.mjs discharge F20 --evidence "682 (7d8141e0) merged; deploy green"
```

Note: B151 was already proven in the prep step (`prove B151 --pr 555 --proof "REG-B151"`,
2026-09-09) — it was NOT discharged, since F20's other rows (B04/B142) weren't proven yet.
Discharge F20 only after B04 and B142 are both proven above; the discharge covers B151 too.

## Pins — test/reconcile-pins (683 / f9f36075)

Batch F33 (B35, B123, B124, B125, B203) and batch F02 (B126, B127) — each row's Test plan
section already names its pin test title/file (written in this prep step); run:

```
node scripts/campaign/bugs.mjs prove B35  --pr 683 --proof "REG-B35"
node scripts/campaign/bugs.mjs prove B123 --pr 683 --proof "REG-B123"
node scripts/campaign/bugs.mjs prove B124 --pr 683 --proof "REG-B124"
node scripts/campaign/bugs.mjs prove B125 --pr 683 --proof "REG-B125"
node scripts/campaign/bugs.mjs prove B203 --pr 683 --proof "REG-B203"
node scripts/campaign/bugs.mjs discharge F33 --evidence "683 (f9f36075) merged; deploy green"

node scripts/campaign/bugs.mjs prove B126 --pr 683 --proof "REG-B126"
node scripts/campaign/bugs.mjs prove B127 --pr 683 --proof "REG-B127"
node scripts/campaign/bugs.mjs discharge F02 --evidence "683 (f9f36075) merged; deploy green"
```

(Discharge F33/F02 only if every OTHER row already in those batches is also proven — check
`bugs.mjs show F33` / `show F02` first; if either batch has additional un-proven rows outside
this wave, prove these seven only and leave the batch discharge to whoever closes the rest.)

## B282 — filed this session, unbatched

New row `B282` — "Interactive invoice/estimate create still accepts a new line for an archived
product" (medium, `apps/api/src/invoices/invoices.service.ts`
`apps/api/src/estimates/estimates.service.ts`) — found by the train 2 review: train 2 guarded
`updateOrderItems` and order create, but the interactive invoice/estimate create paths were left
out by ruling (batch paths must keep billing). It has NO batch yet — run `@tech-lead` to batch it
(money-touching carve-out: plan only, don't fix unattended) before it's actionable via
`next`/`status`/`deps`.

## Verification note

There was no open PR touching `.claude/campaign/` at prep time (checked via
`gh pr list --state open --json number,files --jq '...'`), so B282 was filed directly rather than
deferred to FINISH.md.
