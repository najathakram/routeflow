# Cause brief — B-none 2026-09-04-watchdog-spec-host-speed

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.

Pinned sha: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d` (origin/master, fetched this session).

## The bug as stated

- **Source**: owner report — `apps/api/src/common/visibility-watchdog-script.spec.ts` (added by PR #609), test
  `"visibility-watchdog.mjs contract › defaults --minutes to 45 and --repo to najathakram/routeflow when omitted"`
  (`apps/api/src/common/visibility-watchdog-script.spec.ts:140-163` at the pinned sha). It spawns
  `scripts/visibility-watchdog.mjs` and asserts the log contents after a fixed `setTimeout(…, 500)`; on a loaded
  Windows host bare `node` startup measured 3.0–6.4 s, so the log file is still empty when the assertion runs.
- **Repro**: spawn the script async, read the log 500 ms later on a slow/loaded host → log is `""` (empty) →
  **expected** the log to already contain `"minutes=45 repo=najathakram/routeflow"`. Reported failure:
  `Expected substring "minutes=45 repo=najathakram/routeflow", Received ""`. Green on CI's fast ubuntu runner,
  red in full local runs and in isolation on the reporter's Windows host.
- **Suspected cause (claim, unverified, as given by the owner)**: the 500 ms fixed wait races real Node process
  startup + script execution time on a loaded/slow host; CI's faster/idle runner happens to clear that bar.

## The full test, quoted verbatim

`apps/api/src/common/visibility-watchdog-script.spec.ts:140-163` (at pinned sha `f60bd27c`):

```ts
it("defaults --minutes to 45 and --repo to najathakram/routeflow when omitted", () => {
  const logFile = newLogPath("defaults");
  // Real sleep isn't exercised here (45 real minutes) — the process is left running
  // briefly, then killed once the "start" line proves the defaults were applied.
  const child = require("node:child_process").spawn(process.execPath, [SCRIPT], {
    env: fakeEnv("success", logFile),
  });
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      try {
        const log = readLog(logFile);
        expect(log).toContain("minutes=45 repo=najathakram/routeflow");
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 500);
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
});
```

Note: the file starts a comment block naming this exact scenario at `visibility-watchdog-script.spec.ts:6-18`:

```
// scripts/visibility-watchdog.mjs contract — the safety net for the killed-session
// incident of 2026-09-04, where a public repo window outlived the session that opened
// it by ~6.5 hours because the private flip lived only in that session's own control
// flow. This script must flip the repo private on a fixed deadline REGARDLESS of what
// happens to whatever session launched it.
//
// A fake `gh` driver (mode selected by FAKE_MODE) stands in for the real `gh repo edit`
// / `gh repo view` invocations via VISIBILITY_WATCHDOG_GH_CMD, so every case here runs
// with no network access and never touches the real repo's visibility.
// VISIBILITY_WATCHDOG_LOG_FILE points the log at a scratch file instead of the real
// `local-assets/visibility-watchdog.log`, and VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS
// collapses the real 10s read-back poll to near-zero so the never-verifies case runs in
// well under a second instead of ~40s.
```

### Helpers (quoted verbatim, `visibility-watchdog-script.spec.ts`)

`SCRIPT` constant (line 20):

```ts
const SCRIPT = path.resolve(__dirname, "../../../../scripts/visibility-watchdog.mjs");
```

`run` (lines 57-59) — used by every OTHER test in the file, synchronous:

```ts
function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}
```

`fakeEnv` (lines 61-74):

```ts
function fakeEnv(
  mode: string,
  logFile: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VISIBILITY_WATCHDOG_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
    VISIBILITY_WATCHDOG_LOG_FILE: logFile,
    VISIBILITY_WATCHDOG_VERIFY_INTERVAL_MS: "5",
    FAKE_MODE: mode,
    ...extra,
  };
}
```

`newLogPath` (lines 76-78):

```ts
function newLogPath(name: string): string {
  return path.join(dir, `${name}.log`);
}
```

`readLog` (lines 80-82):

```ts
function readLog(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}
```

`beforeAll`/`afterAll` set up `dir` (a real `fs.mkdtempSync` temp dir) and a fake `gh` driver script
`fake-gh.mjs` written into it (lines 25-55); irrelevant to the timing question except that it confirms no
mocking of `child_process` — everything spawns a real Node child process.

## (b) Every other test in the file that waits on time or on child output

Every OTHER test in the file (lines 85-138) calls `run(...)` — i.e. `spawnSync`, which **blocks synchronously
until the child process exits** and returns its full stdout — so none of them race a timer against process
startup. They pass `--minutes 0.01` (0.01 min = 600 ms of real `sleep(waitMs)` inside the script) and rely on
`spawnSync` waiting for the whole run to finish:

- `visibility-watchdog-script.spec.ts:85-101` — `"success: edit succeeds, view confirms PRIVATE — exit 0 with
start/flip/verified logged"`: `run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile))`
  (line 87). No `setTimeout`.
- `visibility-watchdog-script.spec.ts:103-116` — `"never verifies: view keeps reporting PUBLIC — exit 1 with
error logged"`: `run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("public-forever", logFile))`
  (lines 105-108). No `setTimeout`.
- `visibility-watchdog-script.spec.ts:118-128` — `"edit itself fails: exit 1 with error logged, no
flip/verified"`: `run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("edit-fail", logFile))` (line
  120). No `setTimeout`.
- `visibility-watchdog-script.spec.ts:130-138` — `"prints the same lines to stdout that it appends to the
log"`: `run(["--minutes", "0.01", "--repo", "acme/test"], fakeEnv("success", logFile))` (line 132). No
  `setTimeout`.
- `visibility-watchdog-script.spec.ts:140-163` — the "defaults" test above is the **only** test in the file
  that (1) uses async `spawn` instead of `spawnSync`, and (2) uses a `setTimeout` (line 148, `500` ms literal)
  to decide when to read the log and kill the child. It is the only `child.on('exit')`-adjacent case too, but
  note it registers `child.on("error", …)` (line 158), not `child.on("exit", …)` — there is no exit listener,
  so nothing in the test itself waits for or reacts to the child actually starting or exiting; the 500 ms timer
  is the sole gate before assertion.
- Grep for a literal-ms `setTimeout(` across `apps/api/src/common/*script*.spec.ts` and `scripts/**/*.spec.*`
  at the pinned sha found exactly two hits repo-wide:
  - `apps/api/src/common/db-locks.db.spec.ts:22`: `const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));` — a reusable delay helper, not itself a fixed-timeout race on child-process output.
  - `apps/api/src/common/visibility-watchdog-script.spec.ts:148`: the one under investigation.
    No other `*script*.spec.ts` file under `apps/api/src/common` uses a fixed-ms `setTimeout` gate on spawned
    process output.

## (c) `scripts/visibility-watchdog.mjs` — first log write and what precedes it

Quoted verbatim from the pinned sha (`scripts/visibility-watchdog.mjs`):

`logFile()` (lines 107-109):

```js
function logFile() {
  return process.env.VISIBILITY_WATCHDOG_LOG_FILE || DEFAULT_LOG_FILE;
}
```

`DEFAULT_LOG_FILE` (line 76): `path.join(REPO_ROOT, "local-assets", "visibility-watchdog.log")` — overridden in
every spec via `VISIBILITY_WATCHDOG_LOG_FILE` in `fakeEnv` (spec line 69) to a path under the test's
`mkdtempSync` dir.

`log()` (lines 137-144) — synchronous, appends then also prints to stdout:

```js
function log(event, detail) {
  const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}`;
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line + "\n");
  console.log(line);
  return line;
}
```

`main()` (lines 154-159) — the exact first write:

```js
async function main() {
  const { minutes, repo } = parseArgs(process.argv.slice(2));
  const waitMs = Math.round(minutes * 60_000);
  const deadline = new Date(Date.now() + waitMs).toISOString();
  log("start", `minutes=${minutes} repo=${repo} pid=${process.pid} deadline=${deadline}`);
```

This is the line that writes `minutes=… repo=…` — `scripts/visibility-watchdog.mjs:158`, the first statement
in `main()` after the purely synchronous `parseArgs` (lines 83-105) and the synchronous `waitMs`/`deadline`
computation. `main()` is invoked once, at module bottom:

```js
main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", `unhandled: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
```

(lines 210-214, file ends at 215).

**Nothing asynchronous precedes the first `log("start", …)` write.** There is no `gh` call, no `fetch`, and no
`sleep` before it — `parseArgs` and the deadline math are synchronous, and `log()` itself is a synchronous
`fs.appendFileSync`. The only asynchronous work in the whole script — `await sleep(waitMs)` (line 160,
immediately after the start log) and the later verify-poll loop (`await sleep(interval)` at line 195) — comes
**after** the start line is written. So the only source of delay between `spawn()` in the test and the
"start" line landing in the log file is Node's own process bootstrap (module resolution/parse/execution up to
that first synchronous call), which is the axis the owner's report says measured 3.0–6.4 s on a loaded Windows
host versus the test's fixed 500 ms wait.

## (d) History / git log / blame

- `git log --oneline -5 -- apps/api/src/common/visibility-watchdog-script.spec.ts` (from the pinned sha,
  ancestry only) → single entry: `c009cf83 ci: visibility watchdog arms the private flip before any public
window`.
- `git log -1 <pinned-sha> -- <spec file>` → `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d 2026-09-04 fix(api):
customer-keyed advisory lock for order merges (imp-02) + wave D (#609)` — i.e. the spec file's blame at the
  pinned sha attributes creation to commit `f60bd27c8` itself (author najathakram, 2026-09-04 09:41:33 -0500),
  landing via PR #609 as the owner's report states.
- `git blame -L 140,163 <pinned-sha> -- <spec file>` → every line in the "defaults" test, including the `500`
  literal at line 157, blames to `f60bd27c8` (najathakram, 2026-09-04 09:41:33 -0500) — no earlier edits to
  this block.
- **A fix for this exact defect already exists, uncommitted to master, on another local branch**:
  `git branch --all --contains b9c8e840` → `fix/e2e-freshness-guard-fail-open`. Commit `b9c8e840` ("test(ci):
  watchdog spec waits for the start line instead of racing the log", author najathakram, 2026-09-04 13:53:42
  -0500) rewrites exactly this test to poll for the `" start "` line (10 s budget, 100 ms poll interval) instead
  of a fixed `setTimeout(…, 500)`, and kills the child in a `finally`. Its own commit message: _"The defaults
  case read the log 500ms after an async spawn, racing node startup under load. It now polls for the 'start'
  line (10s budget) and kills the child in a finally so it can't outlive the test."_ This commit is **not** an
  ancestor of the pinned sha and is not on `origin/master`. Whether it is intended as the fix for this
  brief's defect, or a coincidentally-identical prior fix on an unrelated branch, is unverified — flagged as an
  open unknown below, not asserted as the ruling.
- No other commit touches `scripts/visibility-watchdog.mjs` beyond the ones already named (`git log --oneline
--all | grep -i watchdog` → `b9c8e840`, `f60bd27c` (#609), `c009cf83`).

## (e) Bug registry

- `git show f60bd27c893bc0b1058d6dcdfff8180cdd92b42d:scripts/campaign/bugs.mjs` → **does not exist** on master
  at the pinned sha (`fatal: path 'scripts/campaign/bugs.mjs' does not exist in 'f60bd27c…'`).
- `git show f60bd27c…:.claude/campaign/bugs` → **does not exist** on master either (`fatal: path
'.claude/campaign/bugs' does not exist`).
- `grep -i watchdog local-assets/docs/routeflow-bug-register.html` (working copy, gitignored durable register
  per MEMORY.md) → **no matches**. No existing B-id references "watchdog" in that register.
- **Conclusion: no bug-registry id (B-###) exists for this defect** — this is a first-time filing.

## (f) Lessons register (master, pinned sha)

- `git show f60bd27c…:.claude/lessons/_meta.json`:

```json
{
  "nextId": 58,
  "activeCount": 35,
  "archivedCount": 16,
  "maxEntries": 40,
  "maxBytes": 40960,
  "updatedAt": "2026-09-04T15:05:00.000Z",
  "schemaVersion": 1,
  "note": "Bookkeeping only — never accumulate prose here (see L-006). updatedAt bump = acknowledged lesson-free fix. L-044 (F14) landed here, taking the id SEQUENCE §4 pre-allocated for it — do NOT reuse 42/43 (reserved for other Wave A batches, gaps are reserved not abandoned); nextId jumped straight to 50 because L-042..L-049 are pre-allocated to Wave A batches landing out of numeric order."
}
```

- `git show f60bd27c…:.claude/lessons/LESSONS.md | wc -c` → **36478 bytes** (cap is 40960 bytes / 40 entries;
  activeCount 35 per `_meta.json` — headroom exists, unlike the size-cap-BLOCKING state MEMORY.md records for
  an earlier point in time).
- `grep -n -i 'setTimeout\|sleep\|timing\|flak' LESSONS.md` (master, pinned sha) → **one match, not a Lesson
  line and not about fixed-sleep test timing**:
  - `LESSONS.md:255`: `- **Root cause:** the failure was at the _install_ step (registry flake), not the job's own` — this is about an npm-registry install flake in CI, unrelated to a fixed `setTimeout` race against child-process startup time.
- **No existing lesson in `LESSONS.md` on master addresses fixed-sleep/fixed-timeout races against spawned
  child-process output or Node startup latency.**

## Existing tests around this behavior

- The only spec exercising `scripts/visibility-watchdog.mjs` is
  `apps/api/src/common/visibility-watchdog-script.spec.ts` (5 `it` blocks, listed in (b) above). Four of the
  five use blocking `spawnSync` and do not race a timer; only the "defaults" test uses async `spawn` + a fixed
  `setTimeout`. No test elsewhere in the repo touches this script (per the `git log --oneline --all | grep -i
watchdog` result in (d), only the three watchdog-related commits touch it).

## Open unknowns

- Whether commit `b9c8e840` on `fix/e2e-freshness-guard-fail-open` was authored specifically to fix this
  reported defect (its message describes the identical symptom — 500 ms racing async spawn under load) or is
  an independent, previously-landed fix for the same root cause on an unrelated branch; S2 should check that
  branch's PR/session context before treating it as the candidate fix.
- Whether the reporter's measured 3.0–6.4 s bare-`node`-startup figure was captured on this exact host/load
  profile and is reproducible on the machine S2/S3 will use to verify a fix.
- Whether `readLog`'s `fs.existsSync` + `fs.readFileSync` pair against the log file has any additional latency
  under Windows (e.g., antivirus, file-locking) beyond raw Node startup, which this brief has not measured
  independently.
