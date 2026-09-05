# RESUME — buyer ⇄ seller portal switcher (feat/portal-switcher)

- **runId:** `wf_7d8e3ca2-82c`
- **scriptPath (staged engine):** `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v4.js` (byte-identical to `~/.claude/skills/dev-pipeline/pipeline.js` at launch, 285,680 bytes)
- **Transcript dir:** `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\9cb04519-2599-47a4-8973-10f322e5f381\subagents\workflows\wf_7d8e3ca2-82c`
- **Launched:** 2026-09-04 (`startedAt` 2026-09-04T23:28:00Z) from session `9cb04519` (Fable 5.1)
- **Branch / tree:** `feat/portal-switcher` @ `ee2519be` (planning artifacts committed on top of `origin/master` `a5be8626`), worktree `C:\ClaudeCode\routeflow\.claude\worktrees\rf-portal` (own `node_modules` via `npm ci`, Husky shim present)
- **Scale:** major · ui: true · loop: dev-pipeline (feature mode)

Resume: `Workflow({ scriptPath, resumeFromRunId: "wf_7d8e3ca2-82c", args: <the exact object in this session's Workflow launch record> })`.
On resume trust the run's own `phaseReport`, never WIP diffs in the tree.

## Args (summary — the byte-exact object is in the launch record; build-plan.md "Pipeline args" is the template)

- planPath/discoveryPath/specPath/uxSpecPath/testPlanPath → `.claude/pipeline/2026-09-04-portal-switcher/*.md`; designSystemPath `.claude/pipeline/design-system.md`; lessonsPath `.claude/lessons/LESSONS.md`
- workdir `C:/ClaudeCode/routeflow/.claude/worktrees/rf-portal`; formatCommand `npx prettier --write apps/web --log-level warn`
- testPackages: `TP1` routing (`lib/portal-routing.test.ts`, high) · `TP2` presence cookies + `PortalSwitchLink` (`lib/presence-cookies.test.ts`, `components/PortalSwitchLink.test.tsx`) · `TP3` sign-in pages (`app/(auth)/login/portal-switch.test.tsx`, `app/buyer/login/portal-switch.test.tsx`, plus T11/T12 pins + mock extension in the existing `app/(auth)/login/page.test.tsx`)
- redGate: `cd apps/web && npx jest --ci lib/portal-routing.test lib/presence-cookies.test components/PortalSwitchLink.test login/portal-switch.test` — expect fail
- packages: `WP1` routing core (high) → `WP2` hook + component, `WP7` Playwright additions → `WP3` dashboard menu + i18n, `WP4` buyer sidebar, `WP5` operator login (high), `WP6` buyer login/register copy → `WP8` code map (low)
- verify: perRound `tsc --noEmit` + `next lint` (apps/web); final `npx jest --ci`, `NEXT_IGNORE_INCORRECT_LOCKFILE=1 npx next build`, `npx playwright test --list --reporter=list`
- uiVerify: `http://localhost:3002`, `cd apps/web && npx next dev -p 3002`, flows = test-plan §8 rows 1–9, desktop only, checks console-errors / a11y / design-system
- mutationProbe: `portal-routing.ts` ×3 (T1, T9, T5) · `presence-cookies.ts` (T26) · `PortalSwitchLink.tsx` (T13) · `(auth)/login/page.tsx` (T10)

## 2026-09-05 01:52Z — engine STOPPED after the red-gate remediation round; finishing on the LIGHT LOOP

Owner ruling (01:45Z): the full engine was too slow on this machine (I/O-bound: another session's
40-min `npm ci` in `rf-imp-04`, its Docker stack on 3000/3001, 13 Jest workers, Defender scanning
fresh `node_modules`). Phases that ran: Baseline (jest --ci and next build BROKEN at baseline —
one pre-existing failing suite; `ReactCurrentDispatcher` react-18/19 drift), Author tests (TP1–TP3),
Red gate + Opus audit (not properly red: T11/T12 pins pass; new-module tests undefined), ONE
remediation round (rewrote the five test files, extended page.test.tsx, and pre-wrote WP7's three
e2e specs). Remediated red gate: **5 suites / 48 tests / 48 failed / 0 passed** (structurally red).
Light loop from here: one Sonnet builder (WP1–WP6, WP8; WP7 review-only) → Opus refute-first
review ∥ Sonnet browser drive on :3002 → Fable fix ruling → Opus re-check; mutation probe cut to
the sanitizer (T9) and the guard (T1). Jest always `--maxWorkers=4`, one command at a time.
Do NOT resume `wf_7d8e3ca2-82c` — its journal is the record for the ledger/RUN-LOG entry.

## Environment notes

- Docker `routeflow` stack is UP on 3000/3001 but serves the `rf-imp-04` worktree — never reuse those ports; UI verify runs on 3002 with no API (failed calls to `:3000` are baseline noise).
- Every Playwright invocation carries `--reporter=list` (the config's JSON reporter writes `.campaign/runs/web-e2e.json`).
- Pre-commit (lint-staged/prettier) is slow on this machine (minutes); `npm ci` took 38 min.

## Close-out checklist (S8)

1. Coverage matrix R1–R14 → T1–T28; quote red-gate (structural/behavioral), final-gate, mutation-probe and UI-verify results from `phaseReport`.
2. `result.json` → `node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append <result.json> --run portal-switcher --started 2026-09-04T23:28:00Z --ended <now>`; ≤10-line entry in `~/.claude/skills/dev-pipeline/references/RUN-LOG.md`.
3. Fable rulings on `remainingFindings` / `fixPlanning.deferred` → post-run fix round if any.
4. Gates on the finished tree (worktree): `cd apps/web && npx jest --ci`; `npm run verify` (pre-push runs it anyway); `npm run local:e2e` is optional (needs a rebuilt local stack — the running one belongs to rf-imp-04).
5. Commit on `feat/portal-switcher` (`feat(web): …`), push, open the PR (do NOT merge — ship is the owner's call via the rebuild routine: watchdog → public → CI → squash-merge → private → post-deploy-check; post-deploy E2E CC-16…CC-21 + T27/T28 are the wiring proof).
6. Set Status IMPLEMENTED on the five artifacts; memory note; follow-up ticket for mobile-web (same dual-role gap, out of scope).

## Close-out (2026-09-05)

Light loop finished — builder gates green (tsc 0, lint 0, jest 7 suites/54 tests); Opus review
verdict SHIP with 7 minor/nit findings (F1 footer copy, F2 Suspense blank-shell, F3 request.url
convention, F4 _rsc echo accepted, F5 wiring coverage declared, F6 comment, F7 fileCount); Fable
ruled fix F1/F2/F3/F6/F7, accept F4/F5; fixes applied and re-checked HELD; browser sweep on :3002
9/9 flows PASS, zero hydration warnings, 4 screenshots under local-assets/ui-verify/portal-switcher/;
full web jest 23/24 suites, the one failure is the pre-existing buyer/portal/page.test.tsx
cold-start timeout (fixed in a separate test(web) commit); mutation probe 2/2 caught (sanitizer:
3 T9 rows red; guard: T1/T2 red), restore verified by sha256
53f7f18cd1bb94a82088ac241aebb97af6c163befe4615cf3ed3654e2481ea6c, backup deleted.
