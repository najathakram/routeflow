# docs-closeout — report (round 5, after verify-web)

Worktree `rf-F27-build`, HEAD `6b1caa66` (docs) on top of code commits `aa47ee9e` + `b47a74a5`.
Bookkeeping only; no source files touched. Rounds r1–r4 (commits `aa072a7f`, `353f18d4`,
`47b3c697`, `0898d190`) already landed everything in this brief that the tree supports; this
round re-verified every claim against HEAD and recorded the one new fact (fix-b70's engine block).

## Verified this round (tool evidence in-session)

- `git diff master --stat -- apps packages`: 8 files; `estimates.service.ts` is +1 line
  (`issueDate` write at `:150`). `grep claimTransition|TERMINAL_ESTIMATE_STATUSES` in
  `estimates.service.ts` → no hits. **B70 is still not fixed on this tree.**
- `phases/12-checkpoint-fix-b70.json`: task `fix-b70` is `blocked` — rc-b70 returned
  `reproduced=false / causeConfirmed=false` (probe never executed; cause confirmed by code reading),
  plus the design finding that `voidEstimate()` writes `DECLINED` (no VOID literal), so a
  `[CONVERTED, DECLINED]` terminal set would also refuse `DECLINED→ACCEPTED` (PIN-B70). Needs a
  Fable ruling before the fix can be written.
- Registry (`BUGS_ROOT` = this worktree's `.claude/campaign`): B16 `already-fixed` PR #621 (r1);
  B394 = the B15-NAV row (minted with `bugs.mjs file` in r1, alias in title, linked to B15);
  B15/B17/B79 carry "Fix approach" notes recording `aa47ee9e`/`b47a74a5` and the exact
  `prove --pr <n>` commands; `sync --check` → 394 records mirror the ledger (rc=0).
- Lessons: `L-117` (:548, B15) and `L-118` (:567, B17/B79) present; L-110/L-111/L-112 archived
  (r1). `node scripts/validate-lessons.mjs --digest` → ✔ 39/40 entries · 39.7/40.0 KB · nextId 119.
- Code map vs HEAD (`git show HEAD:…`): `estimates/page.tsx` `:359 createEstimate.mutate(dto as any`,
  `:345 issueDate` in the DTO, `:922 fmtCalendarDate(est.issueDate ?? est.createdAt)`;
  `[id]/page.tsx` `:220 canConvert`, `:288`/`:446` gated on it, `:526` is the ACCEPTED banner,
  `:122 "Estimate marked as sent"`; neither page imports `lib/format-date-only.ts`. Every row in
  `api.md` `estimates/`, `web.md:638`/`:1344`, `packages.md:35` matches — **no map edit needed**;
  `_meta.json.mappedSha` stays `b47a74a5` (the newest code commit).

## Changed this round

1. **Registry** — `bugs.mjs note B70 …` (→ `.claude/campaign/bugs/B70.md`): the r5 note records
   the engine block, the rc-b70 outcome, the DECLINED-as-void finding, the options needing a
   Fable ruling, and re-confirms `customers.service.ts:1774` is a `customerId` reassignment
   (no fifth mutator row filed). `sync --check` rc=0 after the note.
2. **Lessons** — `_meta.json.updatedAt` bumped + note prefixed ("no new entry — B70 fix still not
   landed"); `nextId` stays 119. No junk entry written.
3. This report.

## Deviations from the brief (all carried over from r1–r4, still true)

- **B15/B17/B79 not closed** — `bugs.mjs prove` requires `--pr <n>`; no PR exists yet.
- **B70 not closed, no `claimTransition`/`TERMINAL_ESTIMATE_STATUSES` map rows, no B70 lesson** —
  fix not landed (blocked). Consequently the B17/B79 lesson is **L-118** (brief said L-119) and
  `nextId` is **119** (brief said 120); one slot is held for the B70 lesson.
- **B15-NAV** is registry id **B394** (`bugs.mjs file` minted it; no alias flag exists). No test on
  this tree carries a `REG-B15-NAV` token (r1 grep).
- **LESSONS-DIGEST.md not produced**: `grep -i digest scripts/validate-lessons.mjs` returns
  nothing — the flag is silently ignored on this tree, so the file cannot be generated here.
  Follow-up for the skill/script owner.
- `node scripts/validate-code-map.mjs` → rc=1 on the 7 pre-existing cap violations (INDEX 695 KB,
  CHANGELOG 524 KB/210 entries, api/web/mobile area files > 100 KB, 92 INDEX rows > 200 B); none
  introduced by F27; the area-file split is the known deferred work.

## Owner surface (not scheduled)

- **F27-DR-B70** — laundered estimates may have minted a second invoice: read-only report first.
  B70 itself is OPEN and blocked on the DECLINED-as-void ruling.
- **F27-DR-B17** — CONVERTED rows with `invoiceId NULL` (not verified here; no DB access).
- **B70 contract changes pending:** missing id → 404; `accept()` refuses voided; void of voided → 400.
- **Residuals:** estimate send-email feature; PATCH estimate; unvalidated `@Query("status")`;
  unvalidated `expiresAt` sink.

## Observations outside my ownership (not touched, reviewer must know)

- **Uncommitted working-tree edits by another process** (`git diff --stat`):
  `estimates.service.spec.ts` (+451), `[id]/page.tsx` (toast copy → "`${estimateNumber} is marked
Sent. No email was sent.`", error title "Failed to mark estimate as sent"), and
  `estimates/page.tsx` — whose diff **removes the `issueDate,` line** from the create DTO. If that
  edit is committed as-is it regresses the B79 web half; the map/lesson claims describe HEAD only.
- `.claude/pipeline/2026-09-13-F27-build/` task dirs and `phases/` are untracked; I commit only my
  own task dir's report.
