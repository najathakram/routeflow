# Fix round 1: Opus review FAIL (4 MUST, 9 SHOULD), designs by the planner

Base commit bdc788f30 (feat/ops-monitor). Each package owns its files only. Every fix gets a test that FAILS on the current code first (paste the red line), then passes. Builders never commit. Run only your own test files.

## F1: push hook truth (MUST 1, SHOULD 8, SHOULD 9)
Files: `.claude/hooks/ops-post-push.mjs`; `tools/ops-monitor/test/hooks.test.mjs` (post-push cases only; F-none else touches it).

**Design:**
- **Skip background calls.** Ignore any call with `tool_input.run_in_background === true`. Its output says nothing about success.
- **Own splitter, not claude-hook's `commandSegments`.** Export `splitCommand(cmd)`:
  - Removes heredoc bodies: from `<<[-~]?['"]?WORD['"]?` to the line that equals `WORD` (trimmed for `<<-`).
  - Splits on `&&`, `||`, `;`, `|` and newlines only OUTSIDE single or double quotes.
  - Strips `$(...)` and backtick spans entirely.
- **Tokenizer handles quotes.** `VAR="a b"` and `VAR='a b'` assignments are one token each; leading `NAME=value` tokens are dropped; redirection tokens (`2>&1`, `>file`, `> file`, `<file`, `&>file`) are dropped. Example: `SKIP_VERIFY=1 SKIP_VERIFY_REASON="docs only" git push origin feat/x 2>&1 | tail -5` → push, remote `origin`, refspec `feat/x`.
- **Truth check instead of output regexes.** Remove `PUSH_FAIL_RE`.
  - A push is real only when, after the command, the local tracking ref equals the commit that was pushed. One synchronous call: `git rev-parse <srcRef> refs/remotes/<remote>/<dstBranch>`, with `srcRef` = the refspec source or `HEAD`, and `dstBranch` from the refspec or the current branch (`git rev-parse --abbrev-ref HEAD` folded into the same call by passing `--abbrev-ref HEAD` first).
  - Both shas equal → recorded. Else nothing.
  - Delete, dry-run and tag pushes stay ignored.
- **gh pr truth.**
  - `merge`: real only when stdout+stderr matches `/✓ (Squashed and merged|Merged|Rebased and merged) pull request #?(\d+)/` or `/Merged pull request #?(\d+)/i`. The number comes from that match first.
  - `create`: real only when stdout contains `/github\.com\/najathakram\/routeflow\/pull\/(\d+)/`.
  - `ready` / `close`: real only when stdout+stderr has `#N` or the pull URL and no `/^(GraphQL|HTTP \d{3}|error|failed|no pull requests? found)/im`.
- **Speed (≤ 2 synchronous git calls per detected push).**
  1. The rev-parse above.
  2. `git config --get remote.<remote>.url`.
  Both with a 10 s timeout. No other synchronous IO beyond appending the action line.
- **Keep:** the remote URL must match `najathakram/routeflow` and not `routeflow-specs`; the detached recorder spawn; exit 0 always; nothing printed.
- **Tests:**
  - heredoc body containing `gh pr merge 3513` → no action;
  - quoted `"git push"` inside `echo` → none;
  - a pushed sha that doesn't match the tracking ref → none (temp repo where `refs/remotes/origin/x` differs);
  - matching → push recorded;
  - `SKIP_VERIFY_REASON="docs only" git push origin feat/x 2>&1 | tail` → parsed;
  - run_in_background → none;
  - merge without the success line → none, with it → recorded with the number;
  - create with URL → recorded.

## F2: event-store integrity (MUST 2, MUST 3, SHOULD 5, 6, 7)
Files: `tools/ops-monitor/lib/store.mjs`, `tools/ops-monitor/lib/collector.mjs` (specs source only), `tools/ops-monitor/lib/views.mjs` (writeViews IO only), `tools/ops-monitor/test/{store,collector,views}.test.mjs`.

**Design:**
- **Lock ownership.** `withSpecsLock` writes `owner.json` `{ token: randomUUID, pid, host, at }` into the lock dir. A heartbeat (`setInterval` 15 s, `unref`) touches it while `fn` runs. Stale = no heartbeat for 120 s (read `owner.json` mtime). Release deletes the dir ONLY if `owner.json.token` is still ours. Add `tryWithSpecsLock(fn)` → `{ ran: false }` immediately when busy.
- **MUST 2.** The collector's local specs runner calls `tryWithSpecsLock(() => ensureClone + syncSpecs)`. When busy it skips the sync for this run (no error) and still reads events from the working tree (reads need no lock). In cloud mode keep the read-only fetch + reset, now also inside `tryWithSpecsLock`.
- **SHOULD 6 + 7: one pre-push integrity pass for every unpushed commit.** New `reconcileUnpushed(dir)`, run inside the lock right before every push (`appendEvents` retry loop AND `syncSpecs`' push of a non-empty `@{u}..HEAD`):
  1. Fold upstream events (`git show <upstream>:` of each file changed, or simpler: fold the working tree after `pull --rebase`, which already contains upstream).
  2. For every event in OUR unpushed commits (`git diff --name-only @{u}..HEAD` events files → lines whose `id` is not in upstream), re-run `validateAgainstState` against the state without that event.
  3. An `item.new` id collision → renumber (rewrite the line and its same-batch references) and amend. Our unpushed commits are rewritten with `git reset --soft @{u}` + one re-commit of the corrected files, which is safe because nothing is pushed.
  4. A claim now held by another lane → drop that event line, re-commit, and return it in `refused` so the CLI reports `refused: held by <lane>` (exit 1) instead of "ok".
- **MUST 3: views never sit under events.**
  - `writeViews` commits ONLY when the specs working tree has no unpushed commits (`@{u}..HEAD` empty) and pushes immediately.
  - On a rejected push: `git rebase --abort` if a rebase is in progress, `git reset --hard @{u}` (the commit only holds view files, which are regenerated next run), and return `{ pushed: false, retryLater: true }`.
  - A failed pull always aborts any in-progress rebase.
- **Server default** (in F4): local views OFF unless `--views`. Exactly one machine (the PC monitor) runs with `--views`. `rf views` stays manual.
- **Tests:**
  - lock token: an old holder's release does not delete a new holder's lock;
  - `tryWithSpecsLock` while held → ran:false;
  - collector specs runner while the lock is held → sync skipped, events still read;
  - offline item.new committed, another machine takes the id, then `syncSpecs` → renumbered before push;
  - two clones both claim item X, the second's push rejected → after rebase its claim is refused (exit 1) and the line is gone;
  - writeViews with a conflicting views commit → rebase aborted, reset to upstream, event appends still push afterwards.

## F3: alarm truth (MUST 4, SHOULD 11, 12, 13, NIT 14 second half)
Files: `tools/ops-monitor/lib/reconcile.mjs`, `tools/ops-monitor/lib/fold.mjs`, `tools/ops-monitor/lib/ids.mjs`, `tools/ops-monitor/test/{reconcile,fold,ids,snapshot}.test.mjs`.

**Design:**
- **MUST 4.** `status-behind-merge` fires only when ALL of:
  - status ∈ {idea, planned, spec, building, review} (`ready`/`shipping` never fire);
  - every PR linked to the item is merged or closed (no linked PR still open);
  - the newest linked merge is older than 2 h (grace for the lane to record it).
  - Severity: warn while < 24 h since the merge, error after.
  - `ops-stop.mjs`'s advice stays "rf status <id> shipping" (now consistent).
- **SHOULD 11.** In fold, push and pr events also `touchLane(claimedBy of the linked item)`.
- **SHOULD 12.** `parseEta`:
  - ignore a date token immediately followed (optional space) by a unit word `/^(\s)*(days?|d\b|h\b|hrs?|hours?|weeks?|wks?|min)/i`;
  - when the year is defaulted and the date is more than 183 days before `now`, use year+1.
- **SHOULD 13.**
  - Claim conflicts are reported once, by the `claim-conflict` alarm, and only while the conflict is live: the item's current holder plus a later claim from another lane with no release since. Fold records `claimConflict` and clears it when the holder releases, the item goes DONE, or a steal happens.
  - Other anomalies: `error` when the event is < 24 h old, `info` after ("historical: …").
- **NIT 14.** `itemIdFromBranch`: a 4-digit token in 2020-2039 is not an item id unless the branch has no other token AND the token is a known id. Simpler rule: skip 4-digit tokens 2020-2039 entirely.
- **Tests:** each rule red-first: shipping + merged → no alarm; open second PR → none; merged 1 h ago → none; 3 h → warn; 30 h → error; push event touches the claiming lane; "1-2 days" → null; 01-05 seen on 12-20 → next year; resolved claim conflict → no alarm; 30 h old invalid line → info; branch `feat/2026-10-19-x` → null.

## F4: server, auth, packaging (SHOULD 10, NIT 15, MUST 3 server half)
Files: `tools/ops-monitor/server.mjs`, `tools/ops-monitor/lib/auth.mjs`, `tools/ops-monitor/lib/cloud.mjs`, `package.json` (ops:test only), new `tools/ops-monitor/test/run-all.mjs`, `tools/ops-monitor/test/fixtures/plan.md`, `tools/ops-monitor/test/{server,auth,cloud}.test.mjs`.

**Design:**
- **Rate limiting.**
  - Client key: in cloud mode use `x-real-ip` when present, else the LAST `x-forwarded-for` hop (the one the proxy appended). Locally use the socket address.
  - Per-IP: 10 failures per 15 min (count failures only).
  - Global: failures only, cap 300 per 15 min.
  - Bucket map capped at 5000 entries, oldest evicted.
  - A success resets that IP's bucket.
- **Local views default OFF;** `--views` turns it on (never in cloud). Update `resolveListenOptions` and its tests. README note: run the PC monitor with `--views` as the single writer.
- **Session secret.** `OPS_SESSION_SECRET` must be ≥ 64 hex characters (32 bytes) or ≥ 43 base64url characters; otherwise start is refused (the message names the rule, never the value).
- **Test runner.** `test/run-all.mjs` lists `*.test.mjs` in its own directory and spawns `process.execPath --test --test-concurrency=1 <files...>`, exiting with its code. Works on Node 20 and 24. `package.json` `ops:test` = `node tools/ops-monitor/test/run-all.mjs`.
- **Fixture.** `plan.md`: replace any real-looking shas and real ids/phrases (`SA-786`, "billing guards (live harm)", etc.) with acme placeholders (`aaaa1111`, `SA-100`, "widget guards"). Keep the structure the backfill tests need, and keep those tests passing (run backfill.test).
- **Tests:**
  - XFF last-hop keying;
  - 11th failure blocked, success resets;
  - global cap counts failures only;
  - map size cap;
  - short secret refused;
  - `--views` parsing (default off);
  - run-all exits non-zero when a test fails (use a temp dir with a failing test via an env override of the directory).
