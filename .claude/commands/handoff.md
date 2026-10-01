---
description: Write a ≤ 2 KB handoff card for this session so the next one (or a resumed one) starts cold without re-reading history. Run before /compact, /clear, or ending a long session.
---

Write a handoff card at `.claude/handoffs/<YYYY-MM-DD>-<slug>.md` in the current project (create the
directory if missing; `<slug>` = the task in 2–4 kebab words; if a card for this task exists today,
overwrite it). Hard cap 2 KB — pointers, not prose. Gather the facts with commands, never from memory:

1. `git status --short`, `git branch --show-current`, `git log --oneline -3`, `git worktree list`,
   and, if it exists, `node scripts/worktree-audit.mjs`.
2. If a pipeline run is live or paused: the newest `.claude/pipeline/*/RESUME.md` and the newest
   `.claude/pipeline/*/phases/*.json` (checkpoint), read only their first 40 lines.

Card format (all sections required, one line each unless stated):

```
# Handoff — <date> · <slug>
- Task: <one sentence — what was asked>
- State: <done | in progress at <step> | blocked on <what>>
- Branch/tree: <branch> @ <sha> · uncommitted: <N files or none> · worktrees: <list or none>
- Run: <run dir + runId + last checkpoint phase, or none>
- Decided: <up to 3 bullets — decisions taken this session, with the reason>
- Next: <up to 3 bullets — the exact next actions, with commands or file paths>
- Open for owner: <questions only the owner can answer, or none>
- Do not: <anything the next session must not redo or touch>
- Areas touched: <`.claude/code-map` area names the touched files belong to, or `none — no code map`>
```

Redact secrets from every section (tokens, keys, connection strings, credentials) — cite artifacts by
path, never restate their content: point at the file, don't paste it. The **Areas touched** line is what
a PreCompact pass pins as a fact a generic summary would otherwise drop.

Then print the card's path and its byte size. Do not edit CLAUDE.md. Do not commit unless the user
asked for a commit in this session.
