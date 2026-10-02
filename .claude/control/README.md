# .claude/control

Per-repo state for the control system (`apps/control`). `.lane` is a per-machine file and is
gitignored. See `apps/control/README.md`.

## Rule text (full)

### Control system (lanes, tasks, events)

Fleet state lives on the orphan branch **`ctl/state`** (per-lane `events/<lane>.jsonl`, append-
only) and is shown by the private control dashboard (Railway service `apps/control`; locally
`npm run control`). Lanes never edit it by hand and never put it in a PR: `npm run ctl --
start|done|block|bug|propose|set-next …` appends one line and pushes it (no CI, no hooks, no
deploy). Start every session with `npm run ctl -- next --lane <lane>` (≤ 30 lines) instead of
reading the registers, and paste the block `npm run ctl -- pr-body <task>` prints into every PR
body (`Task:`/`Lane:` trailers are how PRs are attributed with zero tokens). Master's registers
(`.claude/roadmap/*`, `.claude/campaign/*`, code map, lessons) keep Bookkeeping Option B
unchanged; PR/CI/deploy state is inferred from GitHub and Railway, never typed.

The state repo is configured, never guessed: run `npm run ctl -- origin set <state repo URL>` once
per machine before any other verb works (with none set, `next` prints one line and the rest exit
2). The state never lives in `najathakram/routeflow`: that repo goes public during CI windows, so
`ctl` refuses it in every spelling. Use the separate private state repo.
