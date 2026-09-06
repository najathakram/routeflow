# Registry guards · Close-out plan (Fable, 2026-09-06) — executed by one Sonnet agent, in this order

Preconditions (Fable does these BEFORE the executor starts): fix-round 1 committed; `origin/master`
(a94f9428) merged into the branch; records re-synced; `self-test`, prettier and `sync --check` green.
Facts verified 2026-09-06 (closeout-prep.md): #616 merged 7281e4d7; #629 merged 420eef71; E2E run
33993841827 = headSha d12203a3, success, 130/0/26, REG-B92 (:217) + REG-B106 web leg (:317) PASSED;
E2E run 34009128893 = headSha 420eef71, success; next free GitHub number #633; B106 already `done`;
B185 on master = `proven`, pr null; F25's other rows all `done`; F13's other rows all `done`.
`campaign-check` matches Jest `fullName`, so a token in a `describe` title covers every `it` inside.

## Step 1 — F32 board issue + board.json (commit A)

- Guard: `gh issue list --search "F32 in:title" --state all --json number,title` must be empty; if an
  F32 issue already exists, use its number and do NOT create another.
- `gh issue create --title "F32 · OCR add-on gate hotfix (observe-first registry, #616)" --label kind:bug --label area:api --body-file <a temp file holding the body below>`

```
Part of #510 (hotfix shard, opened retroactively — the fix already merged as #616).

Campaign batch **F32** — the OCR add-on gate outage: #475 put `@RequireAddon("ocr")` on four live scan routes with no grant/backfill, so every un-granted tenant got 403 for ~5 days and the web toast hid the server message. Fixed by #616 (`7281e4d7`, 2026-09-05): observe-first add-on gate registry (`ocr` dark, reviewBy 2026-10-15), structured 403 (`ADDON_GATE`), scan toast surfaces the server message.
Brief: `.claude/campaign/bugs/B213.md` · Ledger shard: `.claude/campaign/status/F32.jsonl` · Gate: `node scripts/campaign-check.mjs --batch F32`

## Done when

- [x] B213 (T1) — proven by REG-B213/REG-OCR-1 (`apps/api/src/billing/addon.guard.spec.ts`, T1–T8) and REG-OCR-2 (`apps/web/e2e/02-operator.spec.ts`, OP-17g); discharged against #616's deploy.

## Notes

Owner ruling 2026-09-05 (via the lead session): B213 keeps its id and moves into its own hotfix shard instead of being re-filed — `move --tier` (the registry-guards PR) is what makes a triage id's first ledger row possible. Lesson L-071 records the pattern (a new entitlement gate on an existing route ships observe-first or it is an outage).
```

- Add `"F32": <issue number>` after `"F29": 542` in `.claude/campaign/board.json` (keep the JSON shape;
  do not add F30/F31 — out of scope, mention it in the report).

## Step 2 — B213 token + move + prove + discharge (same commit A)

- `apps/api/src/billing/addon.guard.spec.ts`: change the describe title
  `describe("REG-OCR-1 registry-driven observe-first mode"` to
  `describe("REG-OCR-1 / REG-B213 registry-driven observe-first mode"`. Nothing else in that file.
  (campaign-check needs a passing `REG-B213` Jest title for a T1 `done` row.)
- `node scripts/campaign/bugs.mjs move B213 --to F32 --tier T1 --why "owner ruling 2026-09-05: hotfix shard for the OCR gate outage fixed by #616"`
- `node scripts/campaign/bugs.mjs prove B213 --pr 616 --proof "REG-B213 — REG-OCR-1 (apps/api/src/billing/addon.guard.spec.ts, T1-T8: a dark key allows + logs one would-deny warning; enforced, unregistered and mixed key sets still deny with code ADDON_GATE) and REG-OCR-2 (apps/web/e2e/02-operator.spec.ts, OP-17g: the single-scan toast surfaces the server's own message)"`
- `node scripts/campaign/bugs.mjs discharge F32 --evidence "PR #616 merged 7281e4d7 2026-09-05T14:57Z (observe-first add-on gate registry, ocr dark); api + web deployed from it the same day; post-deploy-check green; the OCR run's close-out (2026-09-05) recorded a live probe of the scan routes returning 400 (bad file) instead of 403"`
- `node scripts/campaign/bugs.mjs show B213` → state `done`, batch F32, tier T1, History has the
  batched line (with the why), the proven line and the done line.
- `node scripts/campaign/bugs.mjs sync` (must run before the commit) → `sync --check` clean.
- Commit A: `chore(campaign): open hotfix shard f32 and discharge b213 against #616`
  (no `Bookkeeping-Follow-Up` trailer — this PR carries its own bookkeeping; end the message with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`).

## Step 3 — B92 (F13) and B185 (F25) (commit B)

- Pre-check: `node scripts/campaign/bugs.mjs status F13` / `status F25` and list the rows in
  `proven` / `proven-pending-deploy` — F13 must show ONLY B92, F25 ONLY B185. If any other row is
  ready, STOP and report (do not discharge it).
- `node scripts/campaign/bugs.mjs discharge F13 --evidence "deploy-triggered E2E run 33993841827 (deployment_status, headSha d12203a3, 2026-09-05T21:43Z) after #625's toast-locator fix: 130 passed / 0 failed / 26 skipped" --evidence-B92 "E2E run 33993841827 job E2E (Playwright): apps/web/e2e/30-recurring-standing.spec.ts:217 REG-B92 (the recurring-template edit page persists a schedule and notes change through the validated PATCH) PASSED (3.0s); the REG-B106 web leg at :317 passed in the same run"`
- `node scripts/campaign/bugs.mjs prove B185 --pr 629 --proof "REG-B185 mobile seam tests (apps/mobile/__tests__/location-payload.test.ts: iOS -1 heading/speed sentinels map to null, accuracy passes through, over-bound accuracy omitted) and DTO tests (apps/api/src/drivers/dto/post-location.dto.spec.ts: accuracy accepted, negative rejected, Decimal(8,2) bound)"`
  (expect the WARNING about overwriting the existing proof — the master row was written with pr null).
- `node scripts/campaign/bugs.mjs discharge F25 --evidence "PR #629 merged 420eef71 2026-09-06T03:27Z; api deploy 509c89b5 SUCCESS; deploy-triggered E2E run 34009128893 (deployment_status, headSha 420eef71) 130 passed / 0 failed / 26 skipped; REG-B185 jest (api DTO + mobile seam) green in the same verify"`
- `sync`; `sync --check` clean; commit B:
  `chore(campaign): discharge b92 and b185 after their deploy-triggered e2e runs`.

## Step 4 — lesson L-080 + code map (commit C)

- `.claude/lessons/LESSONS.md` is at 40/40 after the master merge. Archive rule: the OLDEST active
  entry whose **Guard** names an automated artifact (a spec, hook, script or CI check — not judgment,
  none, or a runbook line). Compute it on the merged file (L-039 is already archived on master; the
  candidate is probably L-044). Move that entry VERBATIM into `ARCHIVE.md` under its category heading
  with a one-line dated note ("archived 2026-09-06 for headroom — guard automated"), then append
  `lesson-L-080.md`'s entry (this directory) under the `process` category.
- `.claude/lessons/_meta.json`: nextId 81, activeCount 40, archivedCount +1, updatedAt now, note = one
  sentence (branch, L-080 added, which id archived and why).
- `node scripts/validate-lessons.mjs` → exit 0.
- `.claude/code-map/CHANGELOG.md`: one dated bullet at the top for this branch (sync --check + move
  --tier + the review-round fixes; F5's `roundSha` correction).
- `.claude/code-map/_meta.json`: `mappedSha` = `git rev-parse --short HEAD` at that moment (the head
  containing all mapped code), `generatedAt` now, `notes` = the same bullet (replace, never accumulate).
- Commit C: `docs(lessons,code-map): L-080 derived-file check guard; map the registry guards`.

## Step 5 — final gate (report, do not commit)

`node scripts/campaign/bugs.mjs self-test` · `npx prettier --check "scripts/campaign/*.mjs"` ·
`node scripts/campaign/bugs.mjs sync --check` · `node scripts/campaign-check.mjs --batch F32`, then
`--batch F13`, then `--batch F25` (report the output verbatim — a missing `.campaign/runs` hit for
REG-B213 / REG-B185 is expected until the api and mobile suites re-run on this tree; say so, do not
run them) · `git status --porcelain` empty · `git log --oneline origin/master..HEAD`.

Fable then writes result.json, the cost-ledger row and the RUN-LOG entry, and says "ready to push".
