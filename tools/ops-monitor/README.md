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
npm run ops:monitor -- --views # also write the generated views (WORK-REGISTER.md, board JSON) to git
node tools/ops-monitor/server.mjs --once   # one collection pass, one-line summary, exit
npm run ops:test               # node tools/ops-monitor/test/run-all.mjs
```

Views are off by default (never in cloud). Exactly one machine, the PC monitor, runs with
`--views` as the single writer; every other monitor stays read-only. `rf views` stays manual.

The `--views` monitor also runs the register sync (register rows → events): first pass after 60 s,
then every 5 min. It waits up to 45 s for the specs lock (the collector holds it for each 30-second
pull), and logs every pass that appends nothing, with the reason (busy, pull failed, generated mode,
0 changes), once per change (a busy streak logs at its first pass, then every 6th). When a dry
register sync (read-only, so the cloud runs it too) still finds changes to append and the register's
last commit is more than 15 min old, every monitor raises the `items-stale` alarm and shows a banner:
"Work items are behind the register: N changes from … ago have not reached the board".

The monitor is an always-on process on the PC (owner approved; no scheduled task). Start it in a
terminal tab and leave it. It needs `git`, `gh` (authenticated) and, optionally, `railway`.

## The CLI

`node tools/ops-monitor/bin/rf.mjs <command>` (alias it as `rf`). See [LANE-HOWTO.md](LANE-HOWTO.md)
for the lane version; `rf --help` for every flag.

| Command                                                       | Does                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rf next [--lane L] [--claim]`                                | top unblocked, unclaimed item for the lane (assigned to it, or unassigned in its areas), by priority → train → ETA → id                                                                                                           |
| `rf claim <id> [--branch B] [--steal]` / `rf release <id>`    | one owner per card; a claim held by another lane is refused unless `--steal`                                                                                                                                                      |
| `rf status <id> <status>`                                     | idea · planned · spec · building · review · ready · shipping · live · verified · parked · dropped                                                                                                                                 |
| `rf block <id> --by X [--unblocker L]` / `rf unblock <id>`    | blocked flag                                                                                                                                                                                                                      |
| `rf item new …` / `rf item edit <id> …` / `rf item show <id>` | items with parent/children, train, area, type                                                                                                                                                                                     |
| `rf item new/edit … --blocked-by ID,ID`                       | items that must land first: `rf next` holds the item, and once every blocker is live, verified or dropped with no claimant, `rf sync` prints `FREE TO START` and the monitor raises `blocker-cleared`; `--blocked-by -` clears it |
| `rf event link <id> --pr N`                                   | prints the item's title; refuses an unknown item, or a PR whose title shares no word with the item's, unless `--force`. A PR title `gh` cannot read warns and links                                                               |
| `rf event <kind> …`                                           | any event kind: ruling, owner-decision, note, link, push, pr, …                                                                                                                                                                   |
| `rf ls [filters] [--json]`                                    | list items                                                                                                                                                                                                                        |
| `rf backfill [--dry]`                                         | one-time import of the register, PLAN trains, owner queue and the board state                                                                                                                                                     |
| `rf views [--dry]`                                            | regenerate WORK-REGISTER.md, the DASHBOARD marker sections and `local-assets/board/out/*.json`                                                                                                                                    |
| `rf whoami [--machine M]` / `rf doctor`                       | identity and health                                                                                                                                                                                                               |

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

## Client names never leave the machine

The names and slugs of live tenants must not appear in any git repo, the page, the brief, the
generated views or `last-snapshot.json`. They are listed in `<opsHome>/client-names.json` (a JSON
array of strings, or `{ "names": [...] }`; machine-local, outside both repos, filled in by the
lead). Online the same array comes from the `CLIENT_NAMES_JSON` secret variable, and the cloud
service refuses to start (exit 1) when the list is empty. `lib/mask.mjs` replaces each name
(case-insensitive, whole word, longest first) with "a live business": the server masks every
snapshot string before it is broadcast, served or saved (reloading the file when it changes,
checked at most every 60 s), and `rf brief`, the session hook and the views writer use the same
list. The specs `ops/config.json` no longer takes a `clientNames` list.

A file that exists but does not parse (or holds no list) is an error, never an empty list: the cloud
service, `--lan` and `--views` (which writes to git) refuse to start (exit 1, the message names
`client-names.json`, never its contents); plain localhost starts and warns once; the brief hook and
`rf brief` print only "ops brief disabled: client-names.json unreadable". A file that breaks after a
good load keeps the last good list. Names are masked from the collector inputs _before_ the
snapshot is built (and again after), and each text is masked before it is cut or clipped, so a
name is never left as a fragment; incident ids are date + index only (`INC-1015a`), never a file
slug.

- `.claude/hooks/ops-status.mjs` (Stop + SessionStart): writes `<opsHome>/status/<session>.json`
  (lane/title, worktree, branch, head, open PR, last assistant message first 300 chars; home dirs
  become `~`, token/key-like strings and env values are redacted, client names masked; atomic, fail
  open, 2 s budget, prunes files older than 7 days). On SessionStart it prints one line per other
  status file on the machine (the lane brief only with `RF_STATUS_BRIEF=1`). `rf status-sync` (the
  2-min timer in `--views` mode, waiting up to 45 s for the specs lock) pulls the clone, then turns
  THIS machine's changed files (< 24 h old) into `heartbeat` events in its own `events/<machine>/`
  file, in one lock hold; a failed pull appends nothing. A change of branch / PR / head / lane /
  title emits at once; message-only activity emits one keep-alive per session per 10 min; at most
  20 events per run. `rf brief --refresh` appends locally without pushing. Heartbeats feed lane activity (so `lane-silent` sees them) and never touch items; the
  snapshot's `machines` list (3 days) drives the "Machines and lanes" panel.
