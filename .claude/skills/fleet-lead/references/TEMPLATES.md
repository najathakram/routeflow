# Fleet-lead templates (moved whole from SKILL.md §12, 2026-10-30; size cap)

**GRAPH FIRST bullet (builder and reviewer templates; same text as `briefs/_common.md`):** GRAPH FIRST (graph@<sha>, printed by orient; one shared graph per machine, never build one). Point lookups by identifier with MCP `mcp__graphify__get_node` / `get_neighbors` / `shortest_path` (ToolSearch `select:` if deferred). Before editing an exported symbol run `node <host>/scripts/graph.mjs radius <Sym...>` and read its grep-only files first. Then one code-map INDEX row for invariants, then Read with offset/limit. An empty graph answer is UNKNOWN: grep env vars, constants, Prisma, regex sweeps, generic names and post-sha symbols, and write `graph miss: <why>`.

**Decision relay:** "Owner, question box HH:MMZ: '<verbatim>'. Supersedes <earlier>. Build list:
(1)… (2)…; NOT tonight: …; reviewers: …; declaration after …"

**Gate message to the coordinator:** "#N at <full sha>: PASS 1 <who> + PASS 2 <who> on #3686 at
that sha; tier 1; squash; base check before, ref check after; BUILDING → SUCCESS; then …"

**Checkpoint timer:** `until [ "$(date -u +%H%M)" -ge HHMM ]; do sleep 30; done; …` in the
background, printing visibility, open PRs with `mergeStateStatus` and `isDraft`, and master's ref.

Advisory (dark, owner ruling pending on the budget): a change to a skill, hook, model or routing rule should carry a `factory-eval report` (`scripts/factory-eval.mjs`, frozen task set in `evals/factory/`).
