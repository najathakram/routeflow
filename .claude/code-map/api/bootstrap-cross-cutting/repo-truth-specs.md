# api — Bootstrap & cross-cutting — repo-truth static tripwires & campaign-check specs

> Split from [`../bootstrap-cross-cutting.md`](../bootstrap-cross-cutting.md) (verbatim, lines 454-567 of the pre-split file) on 2026-09-15. See [`../../INDEX.md`](../../INDEX.md).

## Bootstrap & cross-cutting

- **`src/common/docs-truth.spec.ts` + `src/common/no-dead-deps.spec.ts` (wave D, item 11,
  2026-09-03)** — static tripwires living in the API project because the repo has no root test
  runner (CLAUDE.md "DO NOT introduce ... a root-level test runner"). `docs-truth.spec.ts` reads
  `README.md`/`CLAUDE.md` off disk and pins the specific stale claims item 11 fixed: README no
  longer names the dead `najathakram1` remote or the deleted `deploy-staging.yml`, doesn't claim a
  `develop` branch or "main is production-ready", and documents the `deployment_status`-triggered
  E2E flow; CLAUDE.md no longer lists Zustand in the web stack and states the lessons-register
  40,960-byte cap `validate-lessons.mjs` enforces. `no-dead-deps.spec.ts` proves four packages
  removed as verified zero-reference dead weight stay removed, on BOTH halves (manifest no longer
  declares it AND no source file under the app's tree imports it): `zustand` from `apps/web`
  (web state is TanStack Query + context — see [`web`](web.md) `app/providers.tsx`) and
  `@nestjs/axios`/`passport-google-oauth20`/`@types/passport-google-oauth20` from `apps/api`
  (outbound HTTP goes through vendor SDKs; Google OAuth is `google-auth-library`'s `OAuth2Client`
  in `auth/google-oauth.service.ts`, not a Passport `GoogleStrategy`); a reverse guard pins that
  mobile's own zustand (a real, used dependency) and its `react-test-renderer` pin were NOT
  collaterally touched.
- **`jest.repo-truth.config.js` + `src/common/turbo-inputs.spec.ts` (imp-04, PR-4 + wave B′ merge
  follow-up, 2026-09-04)** — cache-safety fix for the two specs above: both read files OUTSIDE
  apps/api (README.md, CLAUDE.md, apps/web's `app`/`components`/`hooks`/`lib` trees + its
  `package.json`, apps/mobile's `package.json`), but apps/api's own `test` task only hashes its
  own `$TURBO_DEFAULT$`, so an edit to any of those could bust no cache and `turbo run test`
  would replay a stale green. `jest.repo-truth.config.js` extends the `package.json` `"jest"`
  config the same way `jest.db.config.js` does (`reporters: ["default"]` — never the campaign
  reporter, which would clobber `.campaign/runs/api.json`) with `testRegex:
"(docs-truth|no-dead-deps|no-single-schema-path|client-page-params|no-react-skew-hacks|next-
version|audit-allowlist-retired)\\.spec\\.ts$"` (the third joined it
  with wave E's schema-folder split; the last four joined it with the Next 15 upgrade,
  2026-09-10, `chore/next-15` #5b3b3c4e — each reads outside apps/api: `apps/web/app` (T3),
  `apps/web/Dockerfile`/`jest.config.js` (T2), `apps/web/package.json` (T1), and
  `security/audit-allowlist.json` (T6)); the main config's `testPathIgnorePatterns` excludes all
  seven by name so `npm test` never double-runs them. New API script `test:repo-truth`; root
  `verify` gained the `test:repo-truth` token on the `turbo run check-types lint test` list. A
  `@routeflow/api#test` workspace-task override was tried first and reverted —
  `packages/pricing/src/package-shape.spec.ts` forbids that exact key — so `turbo.json` instead
  carries a GENERIC `test:repo-truth` task (`dependsOn: ["^build"]`, outside paths as explicit
  `$TURBO_ROOT$/…` `inputs`, `outputs: []`); only apps/api declares the script, so turbo only
  ever executes it there. `turbo-inputs.spec.ts` pins the task's inputs list, the verify/script
  wiring, and the jest-config split (Lesson L-062, tooling — see its chore/next-15 addendum:
  moving a spec IN must add it to the main lane's `testPathIgnorePatterns` in the SAME change).
  **Close-out re-check (2026-09-05):**
  the inputs also carry `scripts/**`, `.github/workflows/**`, `.claude/skills/**`,
  `apps/api/scripts/**`, `apps/api/Dockerfile`, `apps/api/prisma.config.ts`, `package.json` and
  `docker-compose.yml` (no-single-schema-path's reach), and the spec pins ALL sixteen explicit
  inputs plus the lane's exact three specs. **chore/next-15 (2026-09-10, #5b3b3c4e):** four more
  explicit `inputs` (`apps/web/Dockerfile`, `apps/web/jest.config.js`, `apps/web/next.config.mjs`,
  `security/**`) for the four new repo-truth specs' reach; `turbo-inputs.spec.ts` now pins the
  lane's SEVEN specs via a `REPO_TRUTH_SPECS` array and it.each-checks each new spec's exclusion
  from the main lane.
- **`src/common/{next-version,no-react-skew-hacks,client-page-params,audit-allowlist-retired}.spec.ts`
  (2026-09-10, `chore/next-15` #5b3b3c4e, S4 T1/T2/T3/T6)** — the Next 15 upgrade's repo-truth
  lane additions (see above); none import runtime code, all `fs.readFileSync` the tree directly
  (house convention, matches `no-dead-deps.spec.ts`). **`next-version.spec.ts` (T1)** pins
  `apps/web/package.json`'s exact `next`/`eslint-config-next`/`@next/swc-win32-x64-msvc` literals
  (`15.5.25`/`15.5.25`/`^15.5.25`) — clears the two CRITICAL advisories the
  `security/audit-allowlist.json` entries (now retired) were carrying. **`no-react-skew-hacks.spec.ts`
  (T2)** pins that `apps/web/Dockerfile`'s `npm install --force --no-save react@18…` line and
  `jest.config.js`'s single-react `moduleNameMapper` are BOTH gone — a half-reverted skew (one
  hack back, one still removed) breaks every RTL suite, so the pair is asserted together, not as
  two independent facts. **`client-page-params.spec.ts` (T3)** source-scans `apps/web/app` for the
  three old synchronous `params`/`searchParams` prop shapes (destructure / `props.params` / body
  destructure) on Client Components, and for an un-awaited `params:`/`searchParams:` type
  annotation on Server Components; counts by SITE not by file (`customers/[id]/page.tsx` has two).
  **`audit-allowlist-retired.spec.ts` (T6)** pins that `security/audit-allowlist.json` no longer
  carries either retired next.js GHSA id AND that the ci-audit gate now FAILS (not
  ALLOWLISTED-suppresses) a fixture audit reporting one of them — the allowlist itself stays
  available for a future, unrelated advisory (see the `security/audit-allowlist.json` bullet
  above and `ci-audit-script.spec.ts`'s "policy guard" describe update).
- **`src/common/campaign-check-freshness.spec.ts` (2026-09-06, campaign-check report freshness,
  L-083)** — contract spec for `scripts/campaign-check.mjs`'s freshness rule and its new
  `--freshness-only` pre-step (see [`INDEX`](INDEX.md)'s "Bug-register burn-down campaign" row).
  Harness mirrors `ci-freshness-guard-script.spec.ts`'s `runScriptDirect` (`spawnSync` the real
  `.mjs` directly) + `mkdtempSync` fixture pattern: a throwaway `git init` repo with two commits
  (a workspace test file, then a `.claude/campaign/status/F01.jsonl` ledger row) at explicit
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `CAMPAIGN_CHECK_STATUS_DIR` + `--runs-dir` pointed at the
  fixture, env scrubbed of `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`CAMPAIGN_CHECK_TURBO_DRY_RUN`.
  T1–T3/T5 pin the R1 staleness compare (report `generatedAt` vs. the newer of the test-file commit
  or the ledger commit) and R2's exact refusal block (stale-by-name, before any token scan,
  `cd <dir> && npx jest --maxWorkers=2`, the ritual line); T4 is the R3 positive control (no
  affirmative T1 claim ⇒ never checked, green before and after — excluded from the "0 passed on
  red" claim); T6–T9 drive `--freshness-only` (R4) through the `CAMPAIGN_CHECK_TURBO_DRY_RUN` seam
  (R6, `JEST_WORKER_ID`-gated) — HIT refuses, MISS/parse-failure fails OPEN, the seam is ignored
  outside a Jest worker; T10 runs the REAL `scripts/jest-campaign-reporter.cjs` in a child process
  and asserts the new `generatedAt`/`gitHead` stamp (R0) with the four original fields unchanged;
  T11 pins root `package.json`'s `verify` script starting with
  `node scripts/campaign-check.mjs --freshness-only && ` (R5). T12–T14 (R9) pin the reporter's
  `partial`/`partialPatterns` stamp (a scoped run — path/name pattern or `--onlyChanged` — sets
  it, a full run does not) and campaign-check's refusal of a `partial: true` report in both modes
  (full mode: `PARTIAL … regenerate with the full suite`; `--freshness-only`: HIT refuses, MISS
  continues), even when the report is otherwise fresh by time and its token is present — a time
  rule alone would let a scoped run "launder" a stale report as full-suite evidence.
  **Fix-round 1 (2026-09-06, F1/F3/F5):** T15 builds a REAL `git merge --no-ff` fixture (a side
  branch commits the ledger shard, `main` merges it) and pins BOTH campaign-check's refusal
  (naming the MERGE's own time, not the side branch's older one) AND the raw `git log`
  discrepancy itself — `git log -1 --format=%ct -- <path>` (no `--first-parent`) returns the side
  branch's commit because the merge is TREESAME to that (non-first) parent for the path, while
  `--first-parent` returns the merge; `newestCommit` now always passes `--first-parent`. T16 pins
  pathspec scoping (a later commit touching neither the workspace's tests nor the ledger must
  never mark a fresh report stale — bounding by HEAD instead would fail this). T17 pins the
  clock-skew clamp (F3): a commit dated ahead of `Date.now()` clamps to now with one `clock skew`
  note instead of hard-blocking every future report. **T0 is now `Date.now()/1000 - 86400`, not a
  fixed literal** — a hardcoded epoch chosen without regard to wall-clock time can drift into the
  calendar future and get clamped by F3's own guard; only the relative offsets between the 17
  cases matter.
- **`src/common/campaign-check-web-report.spec.ts` (2026-09-08, #686)** — pins that
  `scripts/campaign-check.mjs` treats `apps/web`'s Jest campaign report
  (`.campaign/runs/web.json`, wired via `apps/web/jest.config.js`'s `reporters` block —
  `["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "web" }]`) as a T1 proof
  source on par with api/mobile/pricing. Root cause it guards: REG-B### specs living in
  `apps/web` (e.g. a `lib/api/*.test.tsx` REG-B35 pin) were invisible to the gate — "no test
  titled with REG-B## found in the jest report" on every PR (#683) — because the checker only
  ever read api/mobile reports; `apps/web` never ran the campaign reporter at all. Harness
  mirrors `campaign-check-freshness.spec.ts`'s `runScriptDirect`/`mkdtempSync` fixture pattern.
  See [`INDEX`](INDEX.md)'s "Bug-register burn-down campaign" row and [`web`](web.md)'s Jest
  section for the reporter wiring.
