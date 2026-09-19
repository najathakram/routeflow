# Lane F — prover, PC (window title: "RouteFlow Lane F prover")

Read `LANE-COMMON.md` first (you are a prover, not a builder: you never edit feature code).
You OWN the PC compose stack (`npm run local:up` etc. in `C:/ClaudeCode/routeflow`;
`docker compose ls` first — fixed container names `routeflow_postgres`/`routeflow_redis`
collide, `down` any stray project by name). F2 on the Mac owns the Mac stack; you take every
`PROOF-REQ` / `NEED-DB` posted by U-units, U-po, S-scan, S-order, and any PC bookkeeping PR
that claims a behaviour change.

## Per PROOF-REQ (`[X@pc] PROOF-REQ — #N <branch>`)
1. `git -C C:/ClaudeCode/routeflow fetch`; `git -C C:/ClaudeCode/routeflow worktree add C:/ClaudeCode/routeflow/.claude/worktrees/rf-proof-<N> origin/<branch>`;
   `npm ci`; build api + web images from that tree (`npm run local:up` re-points the stack);
   `npm run local:seed`; `npm run local:validate` green before any feature proof (a red
   baseline is a FINDING, not a skip). Remove the proof worktree when the PR merges.
2. **UI PRs**: real Playwright against the stack at **1440 / 768 / 390**, every state the PR
   claims (empty, loading, error, populated, edited, disabled), screenshots to
   `local-assets/proofs/<date>/<N>/`; bounding-box overflow probe AND a visual look (the probe
   is blind to overlap inside a scroll container — check the picture; the browser pane's
   sticky-scroll screenshots are unreliable — use real Playwright); pixel-diff against master
   where the PR claims "behaviour identical" (prefactor PRs).
3. **Money / inventory / unit PRs**: repro-first — revert the fix commit's source in a scratch
   copy, run the PR's own spec, it must FAIL; restore, it must PASS; then one end-to-end path
   on the `test` tenant (e.g. a case-unit line priced and stocked in base units; a PO edited
   and re-applied with the ledger reconciled).
4. `npm run local:e2e` allow-list for anything touching orders/invoices.
5. Post `[F@pc] DONE — #N @<sha>: PASS/FAIL + one line per claim + "not covered"` on issue
   #938; a FAIL is a `FINDING` with the exact repro. Write `VERDICT.md` in the proof folder.

Rules: test tenants only; never `railway`; never merge; never bypass a hook; a missing fixture
FAILS the proof (never self-skips) and is posted as a FINDING.
