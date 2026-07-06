# RouteFlow project skills

These skills are **checked into the repo** (`.claude/skills/`), so Claude Code auto-discovers
them for **any profile** opened in this working directory — there is nothing to "install." Invoke
one with `/<name>` or let it auto-load on the trigger keywords in its `description`.

| Skill            | Use it for                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **rebuild**      | The deploy routine — EVERY rebuild/deploy/merge/push-to-Railway. 3 mandatory steps: `npm run verify` → public → merge PR → CI → private → `post-deploy-check`. |
| **db-migration** | Any Prisma schema change, migration, or seed. Additive-only; prod migrations applied via the public proxy / `railway run` with approval.                       |
| **smoke-check**  | Pre-push / post-deploy verification: typecheck + lint + unit, the authenticated API smoke probe, and/or the Playwright e2e suite.                              |
| **regression**   | The autonomous regression pipeline (what runs, when, how it's wired): CI e2e, nightly, post-deploy webhook.                                                    |
| **debug-deploy** | Railway deploy failures, health-check down, container/startup errors, rollback.                                                                                |
| **new-feature**  | Introduce a feature/endpoint/screen the RouteFlow way (API → web → mobile mirroring).                                                                          |
| **test-gen**     | Write/add/improve tests (Jest for api/mobile, Playwright for web).                                                                                             |
| **code-map**     | Consult/maintain the signature-level map in `.claude/code-map/` instead of re-reading the repo; update it surgically after every change.                       |

## What does NOT travel with the repo (a different profile must re-establish)

- **Memory** — per-profile at `~/.claude/projects/<slug>/memory/`. The session handoff prompt must
  carry the full state inline; do not rely on auto-loaded memory.
- **MCP servers / plugins** — per-profile. The RouteFlow work needs none of them for core dev;
  adversarial review used the built-in **Workflow** tool (not the pr-review plugin). Browser
  verification used the `claude-in-chrome` MCP (optional; only for live authed-UI checks).
- **The routine docs themselves are committed**: project `CLAUDE.md`, `CLAUDE_SESSION_PREAMBLE.md`,
  `.claude/code-map/`, `docs/design-package/` — all in-repo, so any profile has them.
