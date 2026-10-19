# Ops monitor

A live, local board of every RouteFlow bug, feature, spec, release, work item and sub-item, with
a map of the product areas and what is being done in each. Owner decision
`D-2026-10-19-live-ops-monitor` (routeflow-specs). Code lives here; **all data lives in the
private routeflow-specs repo**.

Why it will not drift like the four boards before it: nothing in it is a snapshot someone has to
remember to refresh.

| Fact                                                         | Where it comes from                                             | Who types it                 |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------- |
| PRs, branches, CI checks, merges, repo visibility            | GitHub (`gh api graphql`, `git for-each-ref`) every 60-120 s    | nobody                       |
| Deploys                                                      | `railway status --json` (read-only), when the CLI is present    | nobody                       |
| Bugs                                                         | the registry `.claude/campaign/bugs/B*.md` on `origin/master`   | nobody (the registry script) |
| Product areas                                                | the file tree of `origin/master`                                | nobody                       |
| Items, claims, status, blocks, rulings, owner answers, notes | events in routeflow-specs `events/<machine>/<YYYY-MM-DD>.jsonl` | a lane, once, with `rf`      |
| Pushes and PR actions                                        | events written by the post-push hook                            | nobody                       |

The reconciler compares the two halves and raises **drift alarms** within a minute: an item still
"building" whose PR merged, a PR or branch with no item, two lanes on one card, a lane silent for
30+ min while holding a card, an item past its ETA, a stale source, a bad event line. Every panel
shows how fresh its sources are.

## Run

```bash
npm run ops:monitor            # http://127.0.0.1:4317 (localhost only)
npm run ops:monitor -- --lan   # also on the LAN (read-only; the page shows private work titles)
node tools/ops-monitor/server.mjs --once   # one collection pass, one-line summary, exit
npm run ops:test               # node --test tools/ops-monitor/test/
```

The monitor is an always-on process on the PC (owner approved; no scheduled task). Start it in a
terminal tab and leave it. It needs `git`, `gh` (authenticated) and, optionally, `railway`.

## The CLI

`node tools/ops-monitor/bin/rf.mjs <command>` (alias it as `rf`). See [LANE-HOWTO.md](LANE-HOWTO.md)
for the lane version; `rf --help` for every flag.

| Command                                                       | Does                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `rf next [--lane L] [--claim]`                                | top unblocked, unclaimed item for the lane (assigned to it, or unassigned in its areas), by priority → train → ETA → id |
| `rf claim <id> [--branch B] [--steal]` / `rf release <id>`    | one owner per card; a claim held by another lane is refused unless `--steal`                                            |
| `rf status <id> <status>`                                     | idea · planned · spec · building · review · ready · shipping · live · verified · parked · dropped                       |
| `rf block <id> --by X [--unblocker L]` / `rf unblock <id>`    | blocked flag                                                                                                            |
| `rf item new …` / `rf item edit <id> …` / `rf item show <id>` | items with parent/children, train, area, type                                                                           |
| `rf event <kind> …`                                           | any event kind: ruling, owner-decision, note, link, push, pr, …                                                         |
| `rf ls [filters] [--json]`                                    | list items                                                                                                              |
| `rf backfill [--dry]`                                         | one-time import of the register, PLAN trains, owner queue and the board state                                           |
| `rf views [--dry]`                                            | regenerate WORK-REGISTER.md, the DASHBOARD marker sections and `local-assets/board/out/*.json`                          |
| `rf whoami [--machine M]` / `rf doctor`                       | identity and health                                                                                                     |

Every event is validated against `lib/schema.mjs` (strict keys) and against the current state
(unknown ids are refused). Ids: register rows keep their numbers and new items continue from the
highest; bugs are `B###`; trains `R1`…; prefixed ids like `K11-16` are allowed.

## Data layout (routeflow-specs)

```
events/<machine>/<YYYY-MM-DD>.jsonl   append-only, one file per machine per UTC day (no cross-machine conflicts)
ops/config.json                       lanes (id, title, machine, areas), hostname → machine, thresholds
ops/state/backfill.json               the backfill record (register hash at import)
register/WORK-REGISTER.md             GENERATED from items + events (refuses to overwrite hand edits)
DASHBOARD.md                          sections between <!-- ops:<name>:begin/end --> markers are generated
```

The tool reads and writes routeflow-specs through its **own clone** (`~/.routeflow/ops/routeflow-specs`,
override `RF_SPECS_DIR`), under a lock, so it never touches a human's checkout. Writes are
`commit -- <paths>` + push with `pull --rebase` retry; an `item.new` id that collides after the
rebase is re-allocated before it is pushed.

Env: `RF_LANE`, `RF_MACHINE`, `RF_ACTOR`, `RF_OPS_HOME` (default `~/.routeflow/ops`), `RF_SPECS_DIR`,
`RF_SPECS_REMOTE`, `RF_BOARD_DIR`, `RF_OPS_GATE=off` (disables the Stop gate).

## Hooks (`.claude/settings.json`)

- `.claude/hooks/ops-post-push.mjs` (PostToolUse, Bash): a successful `git push` to
  najathakram/routeflow or a `gh pr create|ready|merge|close` records its own event (detached; never
  slows or fails the tool call).
- `.claude/hooks/ops-stop.mjs` (Stop): refuses to end a turn after a push or PR whose event is
  missing or whose branch is not linked to an item, or after a merge with no status event; prints
  the exact `rf` command. Fails open on its own errors, when the ops clone is missing (CI, cloud),
  and after three identical blocks.

## Layout

```
bin/rf.mjs            CLI
lib/schema.mjs        event + item schema (strict)       lib/config.mjs   paths, identity, lanes
lib/ids.mjs           ids, ETA parsing                    lib/areas.mjs    file → area → domain
lib/fold.mjs          events → state                      lib/next.mjs     rf next ranking
lib/store.mjs         clone, lock, read/append/push       lib/collector.mjs  GitHub, git, registry, Railway
lib/reconcile.mjs     drift alarms                        lib/snapshot.mjs   the one object the page renders
lib/backfill.mjs      one-time import                     lib/views.mjs      generated markdown + board JSON
lib/turn-actions.mjs  hook bookkeeping                    server.mjs + public/  the page (http + SSE, vanilla JS)
```

Zero dependencies (Node built-ins only). Security-sensitive registry bugs are masked to "Security
hardening item (details machine-local)" everywhere. No client names belong in this directory.
