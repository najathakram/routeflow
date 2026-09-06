---
name: bug-registry
description: >
  File, track and close bugs in RouteFlow's in-repo registry. Auto-load when the owner reports a
  bug, asks to "update the bug registry", "file a bug", "add this bug", "log this", asks what is
  known about a bug id (B###), asks which bug an agent should take next, or when a fix lands and
  the registry needs closing out. Keywords: "bug registry", "file a bug", "report a bug", "log a
  bug", "B###", "what's the status of B", "which bug next", "close out the bug".
---

# The bug registry

Three stores, each owning exactly one thing. They are not redundant, and nothing should be copied
between them by hand — everything downstream of the record is derived.

| Store                               | Owns                                                 | Written by                                                                                  |
| ----------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `.claude/campaign/bugs/B###.md`     | What the bug **is** — analysis + append-only history | this skill, analysis agents                                                                 |
| `.claude/campaign/status/F##.jsonl` | What the bug **is doing** — state + proof            | `bugs.mjs` only (`file`, `prove`, `discharge`, `reopen`, `claim`/`release`, `tier`, `move`) |
| GitHub Issues (one card per batch)  | What is **in flight** — lanes derived from PR/CI     | `scripts/team/team.mjs`                                                                     |

`local-assets/docs/routeflow-bug-register.html` is a **rendered view**, not a source. It is
gitignored and only the owner can republish it. Never treat it as authoritative and never block on
it.

## Reporting a bug (the owner's entry point)

The owner describes a bug in plain English. Do not interrogate them — file first, analyse second.

```bash
npm run bugs -- file "<one-line title>" --location "<file path or Area · surface>" --severity critical|high|medium|low --batch F## --tier T1
```

Pass `--batch` whenever you know it: without a batch there is no ledger row, so `campaign-check` and `next` cannot see the bug at all. That allocates the next id (**max + 1, never filling a gap** — a gap is an id reserved by an
unmerged branch), writes the catalogue row, creates `.claude/campaign/bugs/B###.md`, and prints
whether the bug trips the carve-out. Then run the analysis pass below.

If the owner's report is really several bugs, file each one separately. A record that describes two
defects cannot be closed by one proof, and `campaign-check` will refuse it later.

## The analysis pass

Run this **once per batch at claim time, not once per bug at file time.** Bugs are batched because
they share files; analysing them individually re-reads the same service ten times and is the single
most wasteful thing available here. The exception is a freshly filed bug with no batch yet — give
that one a quick pass so it can be routed.

Use a **Fable** agent (high effort). Fill each section with `npm run bugs -- note B### "<text>" --section "<name>"`:

1. **What this feature is for** — the user-visible purpose. You cannot judge a fix without it.
2. **Root cause** — the actual defect, and its **class**. Check whether that class already has a
   signature in `.claude/skills/bug-hunt/scripts/scan-signatures.mjs`; if it does, search for
   siblings, because the same shape is usually in three more places.
3. **User impact** — who hits this, how often, and what it costs them. Severity is a claim; this is
   the evidence for it.
4. **Fix approach and UX** — including the question that matters most: **can this class be made
   structurally unwritable?** A fix that patches one call site prevents one bug; a lint rule, a
   type, or a scan signature prevents the next N. Issue #502 is the standing home for that work.
   Name the UX consequence explicitly — a correct fix that degrades the flow is not done.
5. **Test plan** — the tier and the **exact `REG-B###` test name**. `campaign-check` will refuse to
   close this bug without a passing test carrying that token, so decide it here, not later.
   T1 = jest, T2 = Playwright against the deployed build, T3 = manual row in the batch build-plan.

## The carve-out — what an agent may fix unattended

Owner decision, 2026-09-02. `classify()` in `scripts/campaign/bugs.mjs` is the single expression of
it; do not re-implement the judgement anywhere else.

- **Agent-safe** — plan it, fix it, open the PR, unattended.
- **Parked** — anything matching **money**, **tenancy** or **migration** patterns. Analyse and plan
  it fully, then stop and hand the owner a ready plan. Do not write the fix unattended.

The classifier is deliberately over-broad: a false "sensitive" costs one glance, a false "safe"
costs a production money bug. It currently parks **16 of the 19** batches that hold workable rows,
so most throughput comes from the analysis pass, not from unattended fixing.

## Picking up work

```bash
npm run bugs -- status              # every batch: done/total, how many analysed, board issue
npm run bugs -- waves               # ⭐ the parallel schedule: what 4 agents can run RIGHT NOW
npm run bugs -- next                # the head of wave 1 (carve-out, claims and in-flight applied)
npm run bugs -- brief F11           # ⭐ everything needed to start: plan, ordering, per-bug fix + test plan
npm run bugs -- show B129           # one bug in full
npm run bugs -- list --open --batch F11
npm run bugs -- triage              # catalogue bugs with NO ledger row — invisible to everything above
```

**`brief` is the one an agent should run.** It assembles the batch plan (ordering, file conflicts,
risks), then each bug with its Summary, Fix approach and Test plan, and ends with the exact commands
to close out. Reading it is the difference between fixing the right bug and fixing it the right way —
every F11 card, for instance, carries a fix the adversarial pass REFUTED, and `brief` leads with that.
It also leads with any record marked `contestedBy:` / `supersededBy:` in its front matter: **never
build from a contested record alone** — its plan is disputed by another record, and a builder who
follows it ships the regression and writes a green test for it.

`waves` greedy-colours the batch hard-conflict graph (`deps`' non-hub sharing rule) and caps each
wave at **4** — the standing agent cap. `next` returns the head of wave 1, not the head of a
severity sort, because the worst batch routinely shares a file with the batch someone is already in.

⚠️ **A batch already being worked is not removed from the schedule — it OCCUPIES wave 1.** Claiming
a batch used to delete the conflicts it carried, so `next` would offer the batch that edits the same
files to a second agent. A busy batch (rows `in-flight`, or a live `team.mjs` lease) now holds a
slot of the cap and keeps its hard conflicts, which is why wave 1 can be shorter than the cap, or
empty, while work is clearly available. It is never offered as a pick.

Both commands say **why** a batch is not on offer: a live lease, rows already `in-flight`, the
carve-out, or `blocked by in-flight F## — shares <file>` (or `blocked by leased F##` when the holder
is a remote `team.mjs` lease rather than a local row — the two are distinguished, not both reported
as "in-flight"). A prose "claimed for planning" comment is surfaced as a warning, never treated as a
lock. A batch with no `board.json` issue is reported as **unchecked**, not as free — no lease could
be read for it at all. `next`'s text output warns about EVERY batch's own claim check, not just the
head's — a batch listed as "safe to run alongside it" carries its own `⚠` line when its check failed.

`next --json` and `waves --json` carry the same self-describing payload, so a dispatcher never has
to infer the schedule it was given:

| field                  | meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `next` / `alongside`   | the head of wave 1, and the rest of wave 1 (`next --json` only)   |
| `eligible`             | all of wave 1 (`next --json` only)                                |
| `waves`                | the full colouring, wave 1 first                                  |
| `busy`                 | batches already being worked — they occupy wave 1, never returned |
| `blocked`              | candidates a busy batch pushed past wave 1, with the shared files |
| `skipped` / `parked`   | not scheduled, with the reason / held by the carve-out            |
| `cap` / `hubThreshold` | the parameters that produced this schedule                        |

Work is claimed per **batch**, never per bug — the board card, the pipeline folder and the PR are
all batch-scoped.

```bash
node scripts/team/team.mjs claim <issue#>   # the authoritative lease (compare-and-swap)
npm run bugs -- claim F11                   # the ledger's own record: rows → in-flight
npm run bugs -- release F11                 # give them back (restores queued OR regressed)
```

**`team.mjs claim` exit code 3 means another agent holds it — stop.** Run `bugs claim` too: the
lease lives on GitHub and is unreadable offline, while `in-flight` rows are local and are what
`next`/`waves` honour when the network is not there.

## Re-routing and re-tiering

```bash
npm run bugs -- move B32 --to F13 --why "shares no non-hub file with F11"   # re-batch, all shards at once
npm run bugs -- tier B32 T1 --why "the analysis designed 9 jest cases"      # reconcile the ledger with the analysis
```

Both are first-class commands precisely because doing them by hand means editing two shards, the
record front matter and the catalogue — four chances to leave the ledger holding two rows for one id.

**A triage id filed without `--batch` has no ledger row at all**, and `move`/`tier`/`prove`/`reopen`
normally refuse an id with no shard to find. Give it its first row with `--tier`:

```bash
npm run bugs -- move B213 --to F32 --tier T1 --why "triage id promoted into the hotfix shard"
```

`--tier` is required only the first time (no existing shard row); once the id has a row, plain
`move --to` re-homes it as above and `--tier` is unnecessary.

## Closing out

Two transitions, and they are deliberately separate — `proven` means merged with a passing test,
`done` means live after a green deploy. Collapsing them is the fiction `campaign-check` exists to
prevent, so neither command will invent the other's evidence.

```bash
# after the PR merges, per bug
npm run bugs -- prove B129 --pr 601 --proof "REG-B129 jest: cancelling a run leaves its orders sweepable"

# after a GREEN DEPLOY, per batch
npm run bugs -- discharge F11 --evidence "Railway deploy <id> SUCCESS; Actions run <id> E2E green against it" \
  --evidence-B129 "Actions run <id> job <id>: spec 28 REG-B129 passed against that deploy"
```

Both write the ledger **replace-in-place** and update the record's front matter and History.
Never hand-edit `status/F##.jsonl`: a second row for the same id is a duplicate the gate rejects,
and that is the first mistake everyone makes.

Guards you cannot talk your way past:

- `--proof` must cite the exact `REG-B###` token (a prefix will not do — `REG-B12` must not be
  satisfiable by `REG-B120`).
- `--evidence` must actually name the deploy and the run. This is the one claim `campaign-check`
  cannot verify for you, so it is the one place a lie would survive.
- **Every T2 row needs its OWN `--evidence-B### "…"`, or the discharge is refused** — nothing
  partial is written. `campaign-check` accepts that string _instead of_ a Playwright artifact (a
  verify runner never has one), so one batch-wide sentence would otherwise discharge every T2 row
  in the batch past the strongest control the campaign has. Two rows given identical text are
  refused too (normalized — trim, collapse whitespace, lowercase — so a trailing space cannot
  defeat this), and the check is scoped to the **whole ledger**, not just this call: reusing a
  string across two separate `discharge` calls (a different batch, a later session) is refused too,
  not silently "grandfathered" the way a pre-rule row is. The batch-wide `--evidence` stays right
  for T1/T3 and lands in `evidence`. **Only three ids are ever grandfathered — a hard-coded set
  (`B24`, `B130`, `B154`) in `campaign-check.mjs`, not an open-ended "any shared bucket" rule.** A
  fresh duplicate outside that set fails the gate outright; only when EVERY id in a shared bucket is
  one of those three does it fall back to a warning.
- `--pending-deploy` is T2-only.
- **A T3 row needs `--build-plan <path/to/build-plan.md>` on `prove`, or the prove is refused.**
  `campaign-check` discharges a T3 row only from a `REG-B###` row in its batch's OWN
  `build-plan.md` "## Manual verification" section, read from the ledger's `buildPlan` field — with
  nothing writing that field, a T3 prove used to land a claim the gate could never verify and no
  command could repair. `prove` resolves the path against the repo root, asserts the file exists and
  its Manual verification section carries the exact token, and persists it:

  ```bash
  npm run bugs -- prove B211 --pr 601 --proof "REG-B211 manual verification row" \
    --build-plan .claude/pipeline/2026-09-02-f11-run-cancel-skip/build-plan.md
  ```

  **The path must be repo-relative** — an absolute path or one that escapes the repo root (`../…`)
  is refused outright, never persisted. The ledger is shared across every machine and CI runner: an
  absolute path leaks a local username/drive letter into a repo that goes public for CI and resolves
  to nothing anywhere else, turning the gate red there. `prove` stores the normalised,
  forward-slash, repo-relative form regardless of OS.

  **The token must sit in a table row.** Both `prove` and `campaign-check` (via the shared
  `scripts/campaign/reg-token.mjs`) require the `REG-B###` token to appear on a line starting with
  `|` inside the "## Manual verification" section, after stripping fenced code blocks — a token
  merely mentioned in prose, or inside a fence explicitly saying not to use it, does not discharge
  the row. T3's whole proof is "a manual-verification **row**"; write it as one:

  ```markdown
  ## Manual verification

  | Token    | What was checked by hand             |
  | -------- | ------------------------------------ |
  | REG-B211 | Cancelling the run left it sweepable |
  ```

### When a closed bug comes back

```bash
npm run bugs -- reopen B129 --why "REG-B129 failed in Actions run <id> against deploy <id>"
```

`regressed` is a real ledger state — the bug keeps its id, its record and its whole history instead
of being re-filed under a fresh number. It clears the PR and proof (so it is workable again and
`next`/`waves` re-offer its batch) and therefore **costs a citation**: the failing `REG-B###` token,
or the run/deploy/report that showed it. `campaign-check` holds `regressed` to that evidence exactly
as it holds `already-fixed`.

### What is actually automatic

Be precise about this, because the answer shapes how much you can skip:

- **Automatic:** the record follows the LEDGER. `prove` / `discharge` / `reopen` / `tier` / `move`
  write it, and `sync` derives front matter and History from it.
- **NOT automatic:** commit archaeology. Of 101 `fix:` commits here, 4 name a B-id and 12 name a
  batch; 85 name neither. The scanner is a weak, best-effort signal (a bare `B###` token, plus
  `(F##)` fanned out to that shard, anchored at the last-synced sha so nothing scrolls out of a
  window). **What makes tracking automatic is that `prove`/`discharge` are the non-negotiable last
  step of a fix** — not that a commit message happened to mention a number.

`sync` runs as **Gate 4 of `.claude/hooks/stop.mjs`**, which reports and never blocks. ⚠️ That hook
only exists on branches carrying it — until PR #597 merges, a session on another branch gets no
Gate 4 at all, so run `npm run bugs -- sync` yourself there. Commit the changed `bugs/B###.md`
files alongside the fix.

⚠️ **After ANY ledger edit (`prove`/`discharge`/`reopen`/`tier`/`move`/`file`), run `sync` before
committing.** A ledger row that lands without a matching `sync` leaves every record's front matter
stale, and the pre-push self-test refuses a push whose mirror has drifted:

```bash
npm run bugs -- sync --check   # read-only: exits 1 naming records whose front matter lags the ledger
```

`--check` derives the same comparison `sync` does but writes nothing (no record, no History event,
no anchor update) and skips the commit scan — use it to verify the tree is clean without mutating
anything. Plain `sync` (no flag) is still what fixes drift once `--check` finds it.

## Keeping the registry honest

```bash
npm run bugs -- enrich      # re-import the register HTML detail + file sets into every record
npm run bugs -- deps        # the conflict graph: batch cohesion, cross-batch conflicts, outliers
npm run bugs -- deps --bug B129
npm run bugs -- render      # regenerate the one-page HTML view from the records
npm run bugs -- self-test   # runs inside npm run verify (today step 6 of 7 — the ordinal moves;
                            # package.json's verify script is the only place worth reading it from)
```

`deps` answers the question batching is supposed to answer: **which bugs must land together, and
which batches can never run in parallel.** Two bugs conflict when they touch the same file.

⚠️ **Hub files are the whole difficulty.** `orders.service.ts` is touched by 36 bugs,
`invoices.service.ts` by 30, `routes.service.ts` by 29, `schema.prisma` by 28. A naive
shares-a-file rule reported that no
batch was EVER parallel-safe, which is useless — two bugs in a 5,000-line service almost always
touch different methods. Only a shared **non-hub** file counts as a hard conflict.

⚠️ **The graph is bounded by its file data, and cannot see method-level collisions inside a
god-file.** It missed the B34/B146 collision the F11 analysis proved by hand, and only found it
once the analysis file sets were merged into front matter. So: run `deps` first to find gross
structure and outliers, then analyse — and **write the analysis` files` back into front matter**,
because that is what sharpens the graph for everyone after you.

`render` writes `local-assets/docs/routeflow-bug-registry.html`, a DERIVED view. ⚠️ It is a
different file from `routeflow-bug-register.html`, which `enrich` still parses as the historical
import source — never overwrite that one.

### Two agents, one shard

`status/F##.jsonl` is shared mutable state, and the campaign routinely runs several sub-agents on
one batch. Every ledger write therefore takes an exclusive lock on the shard — a `<shard>.lock`
DIRECTORY created with `mkdir`, which is the one filesystem primitive that is atomic and fails
loudly on both NTFS and POSIX. It is held across the **read** as well as the write, because the
failure it prevents is a lost update, not a torn file: two `prove`s of different rows in one shard
each read the whole shard, each write their own copy back, and the second silently reverted the
first — a proven, evidence-backed row back to `queued`, with `self-test` and `campaign-check` both
green.

**The catalogue is locked the same way.** `bugs.jsonl` gets its own `bugs.jsonl.lock` through the
same primitive, and `file`, `move`, `import`, `index` and `discharge` all hold it — otherwise two
sessions writing the catalogue at once (or, for `discharge`, scanning every OTHER shard's evidence
while holding only their own) read one snapshot, act on it, and the second write silently discards
the first's. **Lock order is one-way and load-bearing: the catalogue lock is OUTERMOST, and a
shard lock (or several, for `move`) nests inside it — never the reverse.** One-way ordering is what
makes deadlock structurally impossible; nothing here ever waits on the two locks in opposite
directions, so there is no cycle to wait on. `bugs.mjs self-test` enforces this two ways: it parses
its own source to fail if a `withCatalogueLock(` call ever turns up nested inside a
`withShardLock(`/`withShardLocks(` callback, and it races two lock-order-obeying commands against
each other to confirm they still finish in seconds, not the ~10s+ a reversed-order deadlock would
cost.

A lock is broken on its owner being **dead**, never on its **age**. Each lock directory carries an
`owner.json` (`{pid, token, at, bootAt}`); a waiter breaks the lock when `process.kill(pid, 0)`
reports the pid is gone, **or when `bootAt` (a boot-epoch stamp, `Date.now() - os.uptime()*1000`)
no longer matches the CURRENT boot** — proof the recorded pid cannot possibly still be that
process even if the OS has since reused the same pid number for something else entirely. Release
deletes the directory only while the token in it is still ours. Age decides nothing except as a
**last resort** — a lock directory carrying no readable `owner.json` at all, older than **120 s**.
(Breaking on age robbed live holders, whose stale snapshot then reverted committed rows, and the
stolen-from process went on to delete its successor's lock and admit a third writer.)

Lock directories are **gitignored** (`.claude/campaign/**/*.lock/`, `.claude/campaign/bugs.jsonl.lock/`)
— they live inside the tracked `.claude/campaign/` tree the shards and catalogue occupy, so without
that rule one left behind by a crash could land in a commit.

What that means for you:

- **Nothing to do in the normal case.** Every command takes and releases the lock itself, and a
  Ctrl-C, SIGTERM or SIGHUP mid-write releases it too.
- **`bugs: could not lock … within 10000ms`** means the named pid really is still writing. Retry.
  Only if nothing is running should you remove the named `.lock` directory by hand — and if the
  message says the lockdir carries no owner stamp, you don't even need to: it breaks itself once
  it is 120s old.
- **`bugs: breaking the lock on F##.jsonl — its owner (pid N) is gone`** means a writer died
  mid-write. **`… predates this boot`** means the pid answered but cannot be the same process (a
  reboot recycled it). Either line is worth reading: re-read the shard before trusting it. The
  `LAST RESORT` variant means even the owner could not be identified.
- **`bugs: our lock on F##.jsonl was broken by another process; verify the shard`** is the serious
  one, and the process now **exits non-zero** for it — something outside `bugs.mjs` removed a live
  lock directory, so two writers may have been inside the critical section — read the shard and the
  records it names before continuing.
- **Still never hand-edit a shard.** The lock protects `bugs.mjs` from `bugs.mjs`; it cannot
  protect the ledger from an editor.

## House rules that outrank anything here

- **Never name a live client** in a record — slug, business name, product, invoice or order number,
  tenant UUID. The repo goes public during CI windows and these files are tracked. Use `acme`-style
  placeholders.
- **Money** goes through `@routeflow/pricing` (`packages/pricing`); there are no mirrors.
- **Tenancy**: `forTenant()` or `tenantTransaction()`; a bare `$transaction` is not scoped.
- Record the lesson after any fix — `.claude/lessons/LESSONS.md`, enforced by Gate 3.
