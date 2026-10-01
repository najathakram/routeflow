---
description: Print the session-start orientation brief on demand — newest handoff card, worktree audit, code-map drift, lessons digest, newest RUN-LOG headings, ledger summary. Say "/orient", "orient me", "where did we leave off", "catch me up".
---

Run `~/.claude/hooks/orient.mjs` (Bash: `node ~/.claude/hooks/orient.mjs`; PowerShell:
`node $HOME/.claude/hooks/orient.mjs`) from the current project root and print its output verbatim —
it is already sized to ≤ 1.5 KB, don't summarize or trim it further.

If that script doesn't exist yet in this install, reconstruct the same brief by hand instead of
failing:

1. `git status --short`, `git branch --show-current`, `git log --oneline -3`, `git worktree list`.
2. Newest file under `.claude/handoffs/*.md` (by mtime) — read and quote its `State`/`Next`/`Open for
owner` lines.
3. `.claude/code-map/_meta.json`'s `mappedSha` vs `git rev-parse HEAD` — if they differ, one line:
   `git diff --name-only <mappedSha> HEAD | wc -l` files drifted.
4. `.claude/lessons/_meta.json` — one line: active/archived counts, size vs cap.
5. Newest 3 dated bullets from `.claude/skills/dev-pipeline/references/RUN-LOG.md` — headings only.
6. `node .claude/skills/model-routing/scripts/pipeline-ledger.mjs summary --last 10` — one line:
   runs since the last retro, true-telemetry row count.
7. If step 6 shows ≥ 10 true-telemetry rows since the last retro, say so: "retro due — run /retro".

Keep the whole reply to what a session needs before its first decision — pointers, not prose. Do not
open any file the brief didn't name; that's what the rest of the session is for.

8. **Plane brief (projects that track work in Plane):** if `scripts/campaign/plane-triage.mjs` exists in the
   project, run `node scripts/campaign/plane-triage.mjs --brief` and print its output verbatim (≤ 1.5 KB:
   overdue items, due this week, open rulings, stale started work, BUGS drift, writes used today). Without
   `PLANE_API_KEY` it prints one skip line — never block on it. Read the brief before the first decision; do
   not open Plane items the brief did not name.
   If `scripts/campaign/plane-doctor.mjs` exists, also run `node scripts/campaign/plane-doctor.mjs --offline`
   and print any `FAIL`/`WARN` lines (structural self-check of the Plane harness: knobs, denylist, hooks,
   scripts, scheduled task). A FAIL means the harness is mis-installed on this machine — fix before relying
   on the brief.
