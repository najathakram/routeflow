# Accuracy round (owner order 10-19, "the monitor must always be accurate", and the owner's "what did we miss?")

Inputs: the lead's verification of every item on the PC monitor (6 root causes), the lead's bug-registry requirements, the planner's gap review. Runs AFTER fix-round-1 lands (same files). Read build-plan.md, build-plan-m3.md and fix-round-1.md first. Every change gets a test that fails on today's wrong output first.

## Root causes → rulings
1. **False "PR merged but item planned" alarms (6/6 false).** The register cites PRs as background.
   - Ruling: a PR is an item's FIX only when (a) the PR's head branch, title or body names the item (`B1234`, `row 525`, `rows 555/556`, `Closes row 525`, `Fixes B1234`), or (b) a non-register event links it (`rf event link`, `rf claim --branch`, the hook's pr/push events).
   - Register-cited PR numbers are REFS (`item.refPrs`): shown, never alarmed on.
2. **Problems wrong.** The board `state.json` was used as an input, and the status mapping was wrong.
   - Ruling: problems = open (not live/verified/parked/dropped) P0/P1 register items + open/mitigated incidents (`incidents/*.md`). `local-assets/board/state.json` is NEVER an input (it is a generated view).
   - The board-sourced items from the backfill (tags `problem`, `owner-ask`) get dropped by the sync.
   - Owner-facing status words: live/verified → "Fixed", spec → "Being specified", building → "Being built", review → "In review", ready → "Ready to ship", shipping → "Shipping", planned → "Planned", idea → "Idea", parked → "Parked", dropped → "Dropped".
   - Decisions: done → "Answered"; booked → "Booked".
3. **ETA noise (34/34).** Ruling: only a real date or range is an ETA.
   - `parseEta` accepts the WHOLE trimmed string matching `^~?\s*(DATE)(\s*~?\s*HH:MMZ)?(\s*(to|-|–|—)\s*(DATE)(\s*~?\s*HH:MMZ)?)?(\s*\([^)]*\))?$` with DATE = `(\d{4}-)?\d{1,2}-\d{1,2}`. A range uses the END date.
   - Anything else ("unscheduled (slipped past 10-17)", "plan 10-16", "after census", "Phase 3") → null.
   - Free text is shown as is and never alarmed on. The snapshot carries `eta` (raw) + `etaAt` (ISO or null).
4. **Owner queue ~20 already answered.** Ruling: a decision item is answered when any of these holds:
   - its OWNER-QUEUE.md row (matched by the item's `owner-queue` key tag) carries a status word ANSWERED, DONE, STANDING YES or DEFAULT IN EFFECT;
   - the row links a `decisions/D-*.md` file;
   - an `owner-decision` event names the item.
   BOOKED shows as "Booked" (still listed, not "Your call"); OPEN/CHECK stay open.
5. **Bugs not ingested; old train labels.** Ruling:
   - Ingest the registry from origin/master: `.claude/campaign/bugs/B*.md` front matter + `.claude/campaign/status/F##.jsonl` (latest row per id; `state`, `pr`, `batch`, `tier`). The ledger state wins over the front-matter state.
   - Every B-id resolves to a bug item; release members that are B-ids resolve.
   - Train labels: `R\d` tokens, plus `config.trainAliases` (default `{ "window 2": "R1" }`; the lead extends it in `ops/config.json`).
6. **Lanes "last event never"; stale "building" rows.** Ruling:
   - Lane `lastActivityAt` = max(last rf event by the lane, last commit on a branch linked to an item the lane holds or owns, last commit touching `handoff/lanes/<lane-prefix>*` in routeflow-specs). Lane prefix map: `pc-lane` ← `pc-lane*`, `macmini` ← `macmini-lane*`, `macbook` ← `macbook-lane*`, `lead` ← `lead*`, `ops-monitor` ← `ops-monitor*`.
   - New drift `building-stale` (warn): status building/review and no activity for 48 h. Activity = max(linked branch commit date, item updatedAt, the item's last event).
7. **CI "checks fail" misleading.** Ruling:
   - Fetch the check contexts (CheckRun name/conclusion/status, StatusContext context/state) for master and for each open PR.
   - Classify with `config.ciGates` (default patterns `/verify/i`, `/e2e/i`): gate vs probe.
   - Show the gate result (success / failure / pending / "skipped (private)" when the gate runs are absent or skipped while the repo is PRIVATE) and the failing probes by name, separately. Never "checks fail" for a probe-only failure.
8. **Bugs panel and bug drift** (the lead's requirements):
   - Each open bug shows a fix state: `none` / `branch` / `pr-open` / `in-release` (an open PR whose head is `train/*` names it) / `merged` / `deployed` (merged at or before the latest SUCCESS deploy of api or web whose sha is master's head or later). The PR/branch are found by B-id in the branch name, PR title or PR body.
   - Pending registry: `B*.md` files ADDED on unmerged branches/PRs show as "filed, not on master yet". Read their front matter via `git show <sha>:<path>`, max 50.
   - Alarms:
     - `bug-fixed-still-open`: a merged PR names it and the registry still says open. Warn, error after 24 h.
     - `bug-unowned`: a critical/high open bug with no claim, no branch and no PR, filed more than 4 h ago. Filed date comes from ONE `git log --since=30.days --diff-filter=A --format=%cI --name-only origin/master -- .claude/campaign/bugs` call; older bugs count as old.
     - `bug-no-registry`: a B-id named in a PR or branch with no registry file and not pending.
   - `rf bug file …`: a thin wrapper that runs `node scripts/campaign/bugs.mjs file …` in the routeflow checkout, passing the args through unchanged. Only lanes `lead` and `coordinator` may run it (one minter); others get a refusal naming the rule.

## Gaps found by the planner (the owner asked "what did we miss?")
- G1 **The register is still hand-edited.** After the one-time backfill, the lead's edits never reached the monitor.
  - Ruling: a continuous, idempotent **register sync** until the lead switches the register to generated.
  - `ops/config.json` gets `registerMode: "human" | "generated"` (default `human`).
  - In human mode, `rf sync` (and the PC monitor every 5 min, and `rf brief --refresh`) turns changed register rows and owner-queue rows into events.
  - In generated mode, `rf` regenerates the register in a disposable last commit after each event batch and the sync stops.
- G2 **Bugs filed by bugs.mjs only reach master on merge.** Covered by the pending registry (§8).
- G3 **The PC monitor process dies with this session.** The planner restarts it detached with a pid file. The cloud deploy is the permanent answer.
- G4 **Draft summaries never get confirmed.** A human edit of problem/impact/solution clears `summaryDraft` (fold rule + CLI).
- G5 **Old trackers still running.** The Plane triage brief prints stale numbers in every session start, and the old GitHub-Project trigger spawns on every push and costs PC CPU. Retire both hook entries in `settings.json` (P9b owns the file), replaced by the ops brief. The Plane harness scripts stay (read-only mirror) until the lead retires them.
- G6 **Accuracy needs a number.** `rf audit [--json]` prints the counts the lead asked for: items by status; alarms by kind; problems; owner queue open/answered/booked; untracked PRs; bugs by fix state. Used for before/after.
- G7 **Time zones.** The page shows times in the viewer's local time zone, with relative ages. ETAs are written as "about Oct 19, evening (local)".

## Packages (disjoint files; after fix-round-1)

### A1: truth rules
Files: `lib/{fold,reconcile,ids,schema,next}.mjs` + their tests.
- `schema`: item field `refPrs` (int array).
- `fold`:
  - an event with `data.source === "register"` (item.new, or item.edit `fields.source`) puts PR numbers into `refPrs`, never `links.prs`; the 456 backfill events are reinterpreted this way, with no data rewrite;
  - keep `item.registerFields`, the last register-sourced field values (for the sync's diff);
  - an `owner-decision` event with an item sets `item.answeredAt` and, for type decision, status → `verified`;
  - a story-field edit whose `fields.source !== "summary-draft"` sets `summaryDraft: false` (the summary import used actor `summary-draft`; treat that actor as draft too).
- `reconcile`:
  - export `fixLinksFor({ branch, title, body }, knownIds)`: B-ids anywhere; `row(s) N[,/ N]`; `(closes|fixes|resolves) (row )?(B?\d+)`; numeric only after "row"; branch tokens per `itemIdFromBranch`;
  - `status-behind-merge` uses fix links only (plus F3's rules);
  - `building-stale`, `bug-fixed-still-open`, `bug-unowned`, `bug-no-registry` per above; inputs are the shapes A2 defines (the tests build them by hand).
- `ids.parseEta`: the strict grammar (§3).

### A2: collector + snapshot
Files: `lib/{collector,snapshot}.mjs` + tests + fixtures.
- **GitHub query:** PR `body` (truncate 4000); `commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:50){nodes{__typename ... on CheckRun{name conclusion status} ... on StatusContext{context state}}}}}}}` for open PRs and master.
- **`classifyCheck(name, config)`.** Master gets `{ gate: success|failure|pending|skipped|none, probesFailing: [names], runs: [...] }`.
- **Bugs source:**
  - ledger rows via `git cat-file --batch` of `status/*.jsonl` on origin/master (latest row per id wins by file order);
  - `filedAt` from the one git-log call;
  - pending registry: for unmerged branches with `.claude/campaign/bugs/B*.md` in their diff (the branch source already diffs), `git show <sha>:<file>` front matter; cap 50.
- **Specs source extras** (no lock needed for reads):
  - incidents (`incidents/*.md` except README: title = first `# `; status = the `Status:` value word open|mitigated|closed, default open; id `INC-MMDDx`, derived only);
  - OWNER-QUEUE.md rows → `{ key, statusWord, decisionFile }`;
  - lane handoff commit times (`git log --since=7.days --format=%x00%cI --name-only -- handoff/lanes`).
- **Snapshot:**
  - `problems` per §2 (exclude items tagged `problem`/`owner-ask`);
  - `ownerQueue` per §4 with `state: open|booked`, plus `answeredRecently` (last 10);
  - `bugs[]` gains `fix`, `filedAt`, `pending`, `ledgerState`, `items` (register items naming it), `release`;
  - `trains[].members` resolve B-ids;
  - `lanes[]` gains `lastActivityAt`, `lastActivitySource`;
  - items gain `etaAt` and `statusLabel` (§2 words);
  - `ci.master` per §7;
  - `authEnabled` passes through (F4).

### A3: sync, views, CLI
Files: new `lib/sync.mjs`, `lib/backfill.mjs`, `lib/views.mjs`, `lib/store.mjs`, `bin/rf.mjs`, `server.mjs` + tests (incl. the two-machine test).
- **`sync.mjs`:**
  - `syncEvents({ state, registerMd, ownerQueueMd, config, machine, now })` → events:
    - changed register rows → item.edit with `fields.source = "register"` (diff against `item.registerFields`; unchanged → nothing; new row ids → item.new);
    - answered owner-queue rows → `owner-decision` (`question` = row item text ≤ 600, `answer` = `"<statusWord> → <decision file or '-'>"`) when not yet answered;
    - board-sourced items (tags `problem` | `owner-ask`) not dropped → `status dropped` with note "board snapshot is a generated view, not a source (lead 10-19)".
  - Idempotent: running twice emits nothing the second time (test).
- **CLI:**
  - `rf sync [--dry]` (pull, then build, then append);
  - `rf audit [--json]` (G6; reads the last snapshot when present, else folds);
  - `rf bug file …` (§8).
  - A story-field edit sends `summaryDraft:false`.
- **Generated mode** (`registerMode: generated`):
  - `appendEvents` takes `afterCommit(dir)`, which regenerates `register/WORK-REGISTER.md` from the fold (render from state; P3's `renderRegister` via a state→snapshot adapter) into a SECOND, views-only commit.
  - On a rejected push: if HEAD is our views-only commit, drop it (`git reset --hard HEAD~1`, allowed only when the tree is otherwise clean), `pull --rebase` (event commits replay without conflicts: per-machine files), regenerate, recommit, push.
  - **Two-machine test:** two clones append concurrently in generated mode; both land; the final register on the remote equals the render of the fold of all events.
- **`server.mjs`:** with `--views` (the single PC writer), run `rf sync` logic every 5 min under `tryWithSpecsLock`. Never in cloud.

### A4: page
Files: `public/*`, `test/fixtures/snapshot-sample.json`.
- CI strip per §7.
- Status words per §2; decisions show "Answered"/"Booked".
- Free-text ETAs shown as is (no date chip).
- Bugs panel: severity × area with fix-state chips (No PR · Branch · PR open · In release · Merged · Deployed) and the PR link, plus a "filed, not on master yet" badge.
- Lanes: last activity with its source.
- Times in local time zone + relative (G7).
- Hide Log out when `authEnabled` is false.
- Owner queue: answered/booked folded into a collapsed "Answered recently".

### P9 (lead sync, build-plan-m4.md) runs after A3. It also owns G5 (settings.json retirements).
