# Fleet-lead templates (moved whole from SKILL.md §12, 2026-10-30; size cap)

**GRAPH FIRST bullet (builder and reviewer templates; same text as `briefs/_common.md`):** GRAPH FIRST (graph@<sha>, printed by orient; one shared graph per machine, never build one). Point lookups by identifier with MCP `mcp__graphify__get_node` / `get_neighbors` / `shortest_path` (ToolSearch `select:` if deferred). Before editing an exported symbol run `node <host>/scripts/graph.mjs radius <Sym...>` and read its grep-only files first. Then one code-map INDEX row for invariants, then Read with offset/limit. An empty graph answer is UNKNOWN: grep env vars, constants, Prisma, regex sweeps, generic names and post-sha symbols, and write `graph miss: <why>`.

**Standing lines (builder and reviewer brief templates; each with its anchor):**
- (a) Tier 1 briefs list a red case for EVERY status the record moves through (created, recorded, deposited, voided, bounced, reversed, as applicable). Anchor: #4406 H1, a deposited check split a receipt.
- (b) Every number in a PR body or verdict comes from running the committed test, never from a predicted or earlier grid. Anchors: SA-E13, #4405 LOW-1.
- (c) Run each suite once (owner 06:50Z). Builders run targeted plus red-first tests and check-types, then push; the pre-push verify is the full run. Reviewers accept the builder worktree's `$(git rev-parse --git-dir)/rf-verified` when it equals `<tree>` or `<tree>:affected` for the sha's tree (never `:fast`), quote `rf-verified.json`, and run only touched dirs plus probes plus mutations. With no matching marker, they run the full suites.
- (d) Pushes use `RF_HEAVY_SLOT_MAX_CPU_PCT=95` (owner 07:00Z). Jest admission is CPU below 95% on two readings 30 s apart, at least 8 GB free, and `--maxWorkers=2`.
- (e) Wait only through ONE run_in_background command and end the turn. Never foreground-poll.
- (f) Tier 1 reviewers run `node scripts/review-test-edits.mjs --base <merge-base> --head <sha>` and justify every flagged line in the verdict. Anchor: #4404, rewritten fixtures of a named eligibility test hid a HIGH.
- (g) When a new model replaces an old one, the PR that ships it hides or retires the old controls, or names the dated PR that will. Anchor: owner 11-22, "Variant of" beside "Family".
- (h) Merge-window coordinator template: run `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app npm run post-deploy-check`, and assert that the printed `commit` equals the merge sha. Without it the script checks http://localhost:3000 (anchor: #4405 window, 2026-11-22).

**Decision relay:** "Owner, question box HH:MMZ: '<verbatim>'. Supersedes <earlier>. Build list:
(1)… (2)…; NOT tonight: …; reviewers: …; declaration after …"

**Gate message to the coordinator:** "#N at <full sha>: PASS 1 <who> + PASS 2 <who> on #3686 at
that sha; tier 1; squash; base check before, ref check after; BUILDING → SUCCESS; then …"

**Checkpoint timer:** `until [ "$(date -u +%H%M)" -ge HHMM ]; do sleep 30; done; …` in the
background, printing visibility, open PRs with `mergeStateStatus` and `isDraft`, and master's ref.

Advisory (dark, owner ruling pending on the budget): a change to a skill, hook, model or routing rule should carry a `factory-eval report` (`scripts/factory-eval.mjs`, frozen task set in `evals/factory/`).
