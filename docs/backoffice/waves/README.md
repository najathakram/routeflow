# Back-office wave task lists — the source of truth

`waves.json` in this directory is **authoritative** for the back-office programme's task lists.
It lives in the repo, so **any session — local, cloud, or on another machine — can read it**
without a Plane API key, a network call, or a write budget.

## The contract

Same shape as the bug registry: **the file is proof, Plane is a view.**

| Layer | Role |
|---|---|
| `waves.json` | Authoritative task lists, ordering, dependencies, gates. Edit here. |
| `docs/superpowers/plans/2026-09-13-backoffice-waves.md` | The narrative: diagnosis, ordering rule, execution model. Read once, for the *why*. |
| `docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md` | Wave B2's own 15-task implementation plan. Not duplicated here. |
| `.claude/campaign/bugs.jsonl` | The registry rows a wave's `ref` fields point at. Not duplicated here. |
| Plane ROAD items | **Pointers only.** A ROAD item names its wave and links here; it never holds a second copy of the task list. |

**Never hand-edit a wave's tasks in Plane.** A Plane item that disagrees with this file is stale by
definition — fix the file, and let the pointer stand.

## Reading it from a session

```bash
# What should I work on, and is it unblocked?
node -e "const w=require('./docs/backoffice/waves/waves.json');
for(const v of w.waves) console.log(v.id, v.status.padEnd(20), v.title, '| depends:', (v.dependsOn||[]).join(',')||'-');"

# The task list for one wave
node -e "const w=require('./docs/backoffice/waves/waves.json');
const v=w.waves.find(x=>x.id===process.argv[1]);
console.log(v.title+' — '+v.rule); v.tasks.forEach(t=>console.log(' ',t.ref.padEnd(18),(t.sev||'-').padEnd(9),t.status.padEnd(16),t.what));" B1
```

## Field meanings

- **`ref`** — a registry id (`B58`), a Phase 0 task (`P0-T9`), or a neutral tag for unfiled work
  (`TRIAL-1`, `CANCELLED-DEADEND`). Neutral tags become real ids when the minter files them;
  update the `ref` then, don't create a duplicate row.
- **`batch`** — the historical batch the registry row already belongs to (F14, F18, …). Waves
  **re-cut the same rows by domain**; they do not re-file them. Where a wave takes only part of a
  batch, say so in the PR body so the remainder is not assumed done.
- **`status`** — `open` · `in-flight` (with `lane`) · `blocked` · `filed-not-built` ·
  `built-elsewhere` · `reassigned` · `done`.
- **`gate: true`** — a precondition on some other action, not just a backlog item. Read `what` for
  what it gates.
- **`moneyCarveOut: true`** on a wave — Opus refute-first review is mandatory for every PR in it.

## Why this shape

Task lists change constantly; Plane items are expensive to edit, consume a capped daily write
budget, and are invisible to a session without credentials. Keeping the lists in the repo means a
session reads them on demand, edits them in a normal PR, and Plane carries only the stable pointer.
