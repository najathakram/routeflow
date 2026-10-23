# Milestone 4: lead ⇄ monitor sync (owner ask 2026-10-19)

The owner's ask: "How do we ensure the lead is fully aware of the items in the monitor, and that the monitor updates every time we talk to the lead and assign new work, when the lead plans something else, when another session makes or changes a plan, and as things get completed?"

Ruling:
1. **Monitor → session.** A session-start brief, plus a per-prompt "since you last looked" line.
2. **Session → monitor.** Plan changes and assignments are recorded as `rf` events, enforced by the existing Stop gate.
3. Completion is already derived (merges, deploys, pushes) and flagged by drift.

Read build-plan.md (contracts) and fix-round-1.md (the hook rules now in force) first.

## P9a: `rf brief` + lane identity
Files: `tools/ops-monitor/bin/rf.mjs` (new `brief` command; `whoami --lane`), new `tools/ops-monitor/lib/brief.mjs`, new `lib/lanes-local.mjs`, tests `test/brief.test.mjs`.

**Lane identity per checkout:**
- `rf whoami --lane <id>` writes `<opsHome>/lanes.json` `{ "<absolute cwd, normalized, lowercased on win32>": "<lane>" }`.
- `laneForCwd(cwd, env)` resolves `RF_LANE` → the longest `lanes.json` prefix match of cwd → null.
- The CLI's default lane (claim/next/status) uses it when there is no `--lane` and no `RF_LANE`.

**`brief.mjs` (pure).** `renderBrief(state, { lane, now, snapshot?: lastSnapshot|null, config, maxLines = 25 })` → plain text in the owner's words:
- **Hurting now:** open P0 and incident items, by their `problem` line, else the title. Max 5.
- **Shipping next:** the next 2 releases not live: name, what they deliver (first member problem lines), ETA in words, done/total.
- **Waiting on the owner:** open decision / ownerAsk items. Max 5.
- **Lanes:** each lane's claimed items, and one line each.
- **Your queue** (when a lane is known): its now items plus `pickNext`.
- **Drift:** counts by severity, only when a snapshot is available, from `<opsHome>/last-snapshot.json`. The local monitor server writes this file on every broadcast; P9b adds that write in `server.mjs`. Also the freshness line "monitor data as of <age>".

`renderSince(stateBefore, stateNow, { lane })` → one line, or `""` when nothing changed. For example: "Since you last looked: 3 items done (651, 525, 542), 2 new, 1 blocked (544), R2 ETA moved to Oct 20; 4 owner decisions recorded." Status changes are grouped by the done / new / blocked / unblocked / ETA-moved / owner-decision categories.

**CLI:**
- `rf brief [--lane L] [--since <eventId|iso>] [--json]`: reads the local clone, with no network and no lock.
- `--refresh` first does a `tryWithSpecsLock` sync (skipped if busy).

## P9b: hooks (session start brief, prompt digest, plan-change gate)
Files: new `.claude/hooks/ops-brief.mjs`, new `.claude/hooks/ops-post-plan.mjs`, `.claude/hooks/ops-stop.mjs` (extend `evaluateGate`), `.claude/settings.json` (append entries only), `tools/ops-monitor/server.mjs` (write `<opsHome>/last-snapshot.json` on broadcast, atomically via temp+rename, at most once per 30 s), tests `tools/ops-monitor/test/{hooks-sync,brief}.test.mjs`.

**`ops-brief.mjs`**, two modes chosen by the hook payload's `hook_event_name`. Always fail open: exit 0; at most 1.5 s of work; never a network call; print nothing on error.
- **SessionStart:** if the ops clone exists, print `renderBrief` for `laneForCwd(cwd)` (lane-less sessions get the short global part: hurting now, waiting on owner, 8 lines max). Then spawn a detached `rf brief --refresh --quiet` (it syncs the clone for next time) and save the "seen" marker `<opsHome>/seen/<session_id>.json` = `{ lastEventId, ts }`.
- **UserPromptSubmit:** only for sessions whose lane is `lead` OR whose seen-marker exists. Fold now; compute `renderSince` against the marker's position (fold events up to `lastEventId`); print the line if non-empty, prefixed `[ops monitor]`; update the marker.

**`ops-post-plan.mjs`** (PostToolUse, matcher `Write|Edit|MultiEdit|SendMessage`). Records a turn action (same `turn-actions` file as the push hook):
- `{ kind: "plan-change", path }` when a Write/Edit `file_path` is inside a routeflow-specs checkout (the path contains `/rf-specs-handoff/` or `/routeflow-specs/`, or is under `specsDir()`) AND under `decisions/`, `releases/`, `priorities/`, `briefs/`, `register/`, `roadmap/`, `specs/` or `DASHBOARD.md`. Excluded: `events/`, `handoff/`, `log/`, `ops/`.
- `{ kind: "assign", to }` when SendMessage is called from a session whose lane is `lead` and the message matches `/\b(job|task|take|assign|start|build|fix|next|priority|queue|R\d)\b/i`. Lanes reporting to the lead never trigger it.
- Never blocks or prints.

**`ops-stop.mjs`** (`evaluateGate` extension). A `plan-change` or `assign` action needs at least one human event (kind ∉ {push, pr}) with `machine === this machine` and ts ≥ the earliest such action's ts − 1 min. Else missing:
- `why`: "you changed a plan or assigned work (<paths or to>) but recorded nothing on the monitor";
- `fix`: "rf item new …  /  rf item edit <id> --lane <lane> --train R3 --eta …  /  rf event owner-decision --question … --answer …  /  rf event note --text …".
The existing loop guard (3 identical blocks → allow), `RF_OPS_GATE=off` and every fail-open path apply unchanged.

**`settings.json`:**
- SessionStart: `node .claude/hooks/ops-brief.mjs`
- UserPromptSubmit: `node .claude/hooks/ops-brief.mjs`
- PostToolUse matcher `Write|Edit|MultiEdit|SendMessage`: `node .claude/hooks/ops-post-plan.mjs`
Append only; keep everything else.

**Tests:**
- brief text from a fixture state (sections, caps, plain words, no codes for the owner part);
- renderSince categories, and empty when unchanged;
- SessionStart with no clone → exit 0, no output;
- UserPromptSubmit after a new event → the since line;
- a plan-change in decisions/ with no event → gate missing; with a note event → ok;
- a lead SendMessage "take R3 next" → assign action; a lane's SendMessage → none;
- an edit under events/ → no action;
- the brief hook finishes in < 1.5 s on a 1,000-event fixture.

## Lane how-to addition (LANE-HOWTO.md, planner)
The lead runs `rf whoami --lane lead` once in its checkout, and every lane does the same with its own id. The owner's asks, rulings and assignments are recorded with `rf` in the same turn; the Stop gate prints the exact command if one is missing.
