---
description: Start a second session safely — worktree off master, handoff card, RUN-PREFIX brief, registry row. Say "/dispatch <slug> <type>".
---

`<slug>` = 2-4 kebab words. `<type>` = `feat`/`fix`/`chore`/`docs` (default `feat`). Never switch this
checkout, never touch another session's worktree.

1. **Worktree.** `git rev-parse --verify --quiet <type>/<slug>` first — if it prints a sha, STOP and tell
   the owner the branch already exists (name a different slug or reuse it by hand; never delete/reset it
   yourself). Otherwise: `git worktree add .claude/worktrees/<slug> -b <type>/<slug> master`.

2. **Handoff card** at `.claude/handoffs/<YYYY-MM-DD>-<slug>.md`, the format from `~/.claude/commands/
handoff.md` (Task/State/Branch/Run/Decided/Next/Open for owner/Do not/Areas touched), but State is
   fixed to `dispatched — start with /orient`, Next names the brief file from step 3, and Do not includes
   "touch this checkout or any worktree that isn't `<slug>`".

3. **RUN-PREFIX brief** at `.claude/handoffs/<slug>-brief.md` — the same shape this session was launched
   with: a `RUN PREFIX — <slug>, <date>` line; **HARD RULES** (never delete/move/stash/checkout/tidy a
   file it did not create; the exact files/dirs it owns — ask the owner or infer from the dispatching
   task if not given; what's explicitly off-limits); a scratch-only path (`.claude/pipeline/<slug>-scratch`
   unless the owner names one); pointers to any spec files the owner named; a **TASKS** list (numbered,
   one per deliverable) copied or summarized from what the owner asked to dispatch; a report-length cap.

4. **Registry row.** Create `.claude/handoffs/INDEX.md` with header `| slug | branch | worktree | started
| card |` if it doesn't exist yet, then append `| <slug> | <type>/<slug> | .claude/worktrees/<slug> |
<ISO timestamp> | <slug>-brief.md |`.

5. **Print** the launch line for the owner to run in a new terminal: `cd .claude/worktrees/<slug> &&
claude`.

Do not start the new session yourself — dispatch only prepares it.
