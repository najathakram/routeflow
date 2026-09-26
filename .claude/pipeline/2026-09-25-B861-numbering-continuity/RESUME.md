# RESUME — B861 (board #2158)

Session: "Let invoices continue a client's old numbering (B861)". Worktree
`/Users/maznahamanullah/code/routeflow/.claude/worktrees/cool-leakey-1635b0`, branch
`bug/2158-b861-numbering-card-never-reaches-live-invoice-num`, base origin/master 21085bcb.
Started 2026-09-25 (session start ~11:30 local).

## State

- S1 cause-brief.md · S2 cause-refutation.md (Opus, confirmed) · S3 cause-ruling.md (**SA-274**,
  posted on #2158) · S4 bug-test-plan.md · S5 build-plan.md (grounded) · docs-changes.md (after #2154).
- **Engine NOT launched (deviation):** the Mac Lead grants heavy slots per burst with gaps (no
  open-ended slot); the engine cannot pause between bursts. Stages run by hand with the same gates:
  write (no slot) → Burst 1 red on master code + green → Opus review + sibling sweep (light) →
  Burst 2 re-run + revert probes → Burst 3 `npm run verify` + push. Each burst: "HEAVY slot request"
  to "RouteFlow Mac Lead coordination", start + end messages.
- DB lane is the F2 prover's (NEED-DB): `apps/api/src/import/numbering-continuity.db.spec.ts` + T1i
  edit; red at the tests-only sha, green at the fix sha, plus the numbering DB specs for regressions.
- **Merge condition (SA-274 Q4):** prod count via the fleet lead's `railway run`
  (`apps/api/scripts/report-b861-numbering-config.mjs`); routed by the Mac Lead. Count > 0 → owner
  decides. F2 proof run on compose: exit 0, read-only, all zeros (no local rows).
- Never merge from this lane; the Mac Lead coordinates. PR body: `Closes #2158` + Worker line.

## Commit plan

1. `test(api): …` DB spec + T1i edit + report script + pipeline docs.
2. `test(api,web): …` REG unit/controller/web tests (tests-only sha for red evidence).
3. `fix(api,web): …` FIX1 + FIX2, HEAD commit carries `Bookkeeping-Follow-Up: pending`.

## Close-out owed

pre-merge-review skill · closeout.mjs `<runDir>` · RUN-LOG entry · lesson (Option B follow-up) ·
registry flip B861 + file PAYMENT wiring and import-zoho fallback (fresh id allocation, L-201) ·
code-map entries · docs on #2154 · stage-7 wording to the onboarding session.
