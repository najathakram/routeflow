# Accuracy round 2 (after #3529 shipped in #3536; lead + planner audit of the live page, 10-19)

Worktree `C:/ClaudeCode/rf-opsmon-2`, branch `fix/ops-monitor-accuracy-2` from master ca40a1fbf. Earlier rulings: build-plan.md, accuracy-round.md, fix-round-1/2.md in this folder. Each change gets a test that FAILS on today's code first.

## X1: truth of "Hurting now", statuses, incidents, owner queue
Files: `tools/ops-monitor/lib/{schema,fold,reconcile,snapshot,collector,backfill,sync}.mjs`, `public/{app.js,app.css,index.html}`, their tests, `test/fixtures/snapshot-sample.json`.

1. **Unknown status words never become "planned" silently.** Register row 530 says `done`, which is not in STATUSES, so the monitor showed "Planned".
   - The parser (backfill + sync) maps done / closed / fixed / complete / completed / resolved → `verified`; shipped / deployed → `live`; blocked → keep the previous status plus `blocked`; in-progress / wip → `building`.
   - Any other word: status `planned` + `statusText: <raw>` (new item field) + info alarm `unknown-status:<id>` "Row <id> has status '<raw>' the monitor does not know".
   - Re-sync emits the corrected status for rows already ingested (the sync diff compares the parsed value).
2. **"Hurting now" needs live harm.**
   - New item field `harm`: `live | latent | none | null` (schema), settable by `rf item edit <id> --harm <v>` (bin/rf.mjs flag) and shown on the card.
   - Derived latent rule (snapshot, pure): a census/audit/ops item that is DONE (live/verified) and whose title or gate matches `/\blatent\b|\b0 lines\b|\$0\.00|no (?:live )?customer/i` marks harm `latent` on every open bug item that either shares a PR number with it (`links.prs ∪ refPrs`) or is named as "row N"/"rows N/M" in its title or gate.
     - Today's data: 530 (done, "0 lines / $0.00 … latent only", PRs #3468, #3470) → 525 (refPrs #3467, #3470) becomes latent.
     - An explicit `harm` on the bug always wins.
   - `problems` ("Hurting now") = open bug/incident items with priority P0/P1 whose effective harm is not latent/none, plus open incidents (rule 3).
   - New snapshot list `latentRisks: [{ id, title, evidence: "<census item id>: <gate excerpt ≤ 160>" }]`. The page shows it collapsed under the band as "Latent risks (no customer harmed)".
3. **Incident files are snapshots, so they need a status and freshness.**
   - The collector parses the `**Status:**` line's first word: open | mitigated | closed | resolved | suspected | unverified. No line → `unknown`. It also reads each incident file's last commit time with ONE `git log --format=%x00%cI --name-only -- incidents` call.
   - Hurting now includes an incident only when its status is `open` and the file changed within the last 7 days.
   - Otherwise:
     - mitigated → "Mitigated" (shown in the latent list area as "Mitigated incidents");
     - suspected/unverified → "Unverified";
     - closed/resolved → hidden;
     - unknown, or open but stale → drift alarm `incident-stale:<id>` (warn) "Incident '<title>' has no status update for N days; set its **Status:** line".
4. **"Waiting on you" = decisions only.**
   - `ownerQueue` keeps type `decision` items (open, not answered) only.
   - A new `ownerTodos` holds other open items whose lane is `owner` (tasks like "Run the EAS build").
   - The page's "Waiting on you" column lists decisions. Below it, one quiet line "N tasks of yours" expands to the to-dos.
   - The brief's "Waiting on the owner" uses decisions only.
5. The page shows `statusText` (the raw word) in "Details for the team" when present. The bugs panel and the cards show `harm` latent as "Latent: no customer harmed (census …)".

## X2: client names never leave the machine
Files: new `tools/ops-monitor/lib/mask.mjs`, `server.mjs`, `lib/brief.mjs`, `lib/config.mjs`, `lib/cloud.mjs`, `bin/rf.mjs` (brief/views paths only), `lib/views.mjs` (board JSON + dashboard sections), their tests.

- `mask.mjs`:
  - `loadClientNames({ env, home })` reads `<opsHome>/client-names.json` (a JSON array of strings; also `{ "names": [...] }`). In cloud mode it uses `OPS_CLIENT_NAMES` (a JSON array in a secret variable) when the file is absent. Returns `[]` when neither exists (local).
  - `maskText(text, names)`: case-insensitive, whole-word, regex-safe, longest first. Each name becomes "a live business".
  - `maskDeep(obj, names)`: returns a deep copy with EVERY string masked (keys untouched).
- `server.mjs`: the snapshot is masked with `maskDeep` right after `buildSnapshot`, before SSE broadcast, `/api/snapshot`, `last-snapshot.json` and views. Names are reloaded when the file's mtime changes (check at most every 60 s).
- Cloud: `--cloud` / `RF_CLOUD=1` REFUSES to start (exit 1, message names the rule, never values) when the list is empty: no `OPS_CLIENT_NAMES` and no file.
- `brief.mjs`, the since-line and views use the same `maskText` with `loadClientNames`. Remove `clientNames` from `DEFAULT_CONFIG` and from `loadConfig` (the specs config never holds names; lead ruling 10-19: live-tenant slugs never go into any git repo).
- Tests:
  - every string field in a fixture snapshot (items, bugs, alarms, problems, incidents, owner queue, trains, latent list) is masked;
  - word boundaries ("acme" masked, "acmes" and "macme" not);
  - mtime reload;
  - cloud refuses with an empty list and starts with one;
  - no name ever appears in /api/snapshot, SSE or last-snapshot.json (spawn the server with a temp home + fixture).
- `README.md`: one paragraph on `client-names.json` (machine-local, outside both repos; the lead fills it; online it is a secret variable). The owner-steps doc in routeflow-specs gets a line later (planner).
