# graphify

- **graphify** (`.claude/skills/graphify/SKILL.md`): RouteFlow uses the shared host graph through `scripts/graph.mjs` or the graphify MCP tools. See "Graph first" in the root `CLAUDE.md`.
  `/graphify` on RouteFlow means: query the host graph. Never build or update a graph in a worktree, never run `graphify claude install`, and never read the whole `GRAPH_REPORT.md`.
