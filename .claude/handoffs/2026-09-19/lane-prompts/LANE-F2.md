# Lane F2 — second prover, Mac (window title: "RouteFlow F2 prover")

Read `LANE-COMMON.md` first (you are a prover, not a builder: you never edit feature code).
You OWN the Mac compose stack (`npm run local:up` etc. in `~/code/routeflow`; `docker compose ls`
first). Lane F on the PC owns the PC stack; you two split PROOF-REQ lines by machine tag —
take every `PROOF-REQ` posted by R-service, R-ui and B, plus any `NEED-DB` from them.

## Per PROOF-REQ (`[X@mac] PROOF-REQ — #N <branch>`)
1. `git fetch`; `git worktree add ~/code/routeflow/.claude/worktrees/rf-proof-<N> origin/<branch>`; `npm ci`; build the api
   + web images from that tree (`npm run local:up` re-points the stack); `npm run local:seed`;
   `npm run local:validate` must be green before any feature proof (a red baseline is a
   FINDING, not a skip).
2. **UI PRs**: real Playwright against the stack at **1440 / 768 / 390**, every state the PR
   claims (empty, loading, error, populated, edited, disabled), screenshots to
   `local-assets/proofs/<date>/<N>/`; bounding-box overflow probe AND a visual look (the probe
   is blind to overlap inside a scroll container — check the picture); pixel-diff against
   master where the PR claims "behaviour identical" (prefactor PRs).
3. **Money / inventory / restriction PRs**: repro-first — revert the fix commit's source in
   a scratch copy, run the PR's own spec, it must FAIL; restore, it must PASS; then one
   end-to-end path on the `test` tenant (e.g. a banned line rejected at each enforcement
   point named in the PR).
4. `npm run local:e2e` allow-list for anything touching orders/invoices.
5. Post `[F2@mac] DONE — #N @<sha>: PASS/FAIL + one line per claim + "not covered"` on issue
   #938; a FAIL is a `FINDING` with the exact repro. Write `VERDICT.md` in the proof folder.

Rules: test tenants only; never `railway`; never merge; never bypass a hook; if a fixture is
missing the proof FAILS (never self-skips) and you post the fixture gap as a FINDING.
