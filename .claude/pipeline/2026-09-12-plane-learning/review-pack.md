# Review pack — 2026-09-12-plane-learning

Worktree `rf-plane3`, branch `feat/plane-harness-learning`, base `feat/plane-harness` a27dc0f1.
NOTE: excluded per instruction — `plane-apply.self-test.mjs`, `plane-intake.self-test.mjs`,
`plane-sync.self-test.mjs`, `plane-triage.self-test.mjs` (another agent editing their env
helpers concurrently).
NOTE: hit the 30-tool-call read-only cap before enumerating every `check(name, got, want)` call
site inside `plane-learning.self-test.mjs` / `plane-doctor.self-test.mjs` one-by-one — section 4
gives file structure + the assertion mechanism instead of a full per-case line list.

## 1. Diff stat vs a27dc0f1 + untracked

```
 .claude/code-map/CHANGELOG.md             |  25 +++
 .claude/code-map/INDEX.md                 |  13 +-
 .claude/code-map/_meta.json               |   4 +-
 .claude/hooks/stop.gate5.spec.mjs         | 131 +++++++++++-
 .claude/hooks/stop.mjs                    |  67 +++++-
 .claude/skills/plane/SKILL.md             | 104 ++++-----
 package.json                              |   6 +-
 scripts/campaign/plane-apply.mjs          | 132 +++++++++---
 scripts/campaign/plane-client.mjs         | 102 ++++++++-
 scripts/campaign/plane-docs.self-test.mjs | 116 ++++++++++
 scripts/campaign/plane-intake.mjs         | 279 ++++++++++++++++---------
 scripts/campaign/plane-sync.mjs           | 337 ++++++++++++++++++++++--------
 scripts/campaign/plane-triage.mjs         | 139 +++++++++---
 13 files changed, 1149 insertions(+), 306 deletions(-)
```

Untracked (new):

- `.claude/pipeline/2026-09-12-plane-learning/` (this run dir — `spec.md`, 48 lines)
- `docs/plane/` → `docs/plane/retro/README.md` (22 lines)
- `scripts/campaign/plane-doctor.mjs` (533 lines)
- `scripts/campaign/plane-doctor.self-test.mjs` (excluded from full inventory — see NOTE above; not one of the 4 excluded env-helper files)
- `scripts/campaign/plane-knobs.json` (11 lines, full text in §3)
- `scripts/campaign/plane-learning.self-test.mjs` (890 lines)
- `scripts/campaign/plane-retro.mjs` (718 lines)

## 2. spec.md — R1–R6 one-liners + hard lines verbatim

- **R1** Knob file `scripts/campaign/plane-knobs.json`; `plane-client.mjs` exports `loadKnobs()` (validated min≤value≤max, else `knobs invalid: <name>`); sync/triage/apply/Gate5 read defaults from it, CLI flags override.
- **R2** Every tool run appends one JSON line to `local-assets/plane/runs.jsonl` (gitignored, `PLANE_RUNS_PATH` test override) at exit incl. failure; counters from extended `client.summary()`; denylist-scanned before write, redact on hit.
- **R3** `plane-doctor.mjs [--offline] [--json]`: one PASS/FAIL/WARN line per check, exit 1 on any FAIL; offline checks run inside `npm run verify`; online checks WARN-skip with no key; never a write.
- **R4** `plane-retro.mjs [--days 14] [--apply] [--json] [--out <dir>]`: reads `runs.jsonl`, writes `local-assets/plane/retro/<date>.md`+json; per-tool stats; knob-change rules need ≥10 runs else "insufficient evidence"; `--apply` only mutates `autoTune:true` knobs within bounds, appends history, prints `applied N / proposed-only M`; candidate lessons → `lessons-candidates.md`, never `.claude/lessons`.
- **R5** Daily routine gains `plane:doctor` + Monday `plane:retro --apply`; weekly docs-only knob-retro PR; SKILL.md documents doctor/retro/knobs/ledger; `package.json` gets `plane:doctor`/`plane:retro`, `verify` gains `plane:doctor -- --offline`; code-map rows for every changed file.
- **R6** Gate 5 (non-blocking) prints `Plane: last sync <age> ago` on master/main + `Plane: WARN landing without sync` per R3's rule — report-only.

Hard lines (verbatim from spec.md):

```js
// plane-client.mjs
export function loadKnobs() {
  /* path = gated override || repoRoot()/scripts/campaign/plane-knobs.json; JSON; for each knob assert min<=value<=max else throw new Error(`knobs invalid: ${name}`) */
}
export function runsPath() {
  return process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_RUNS_PATH
    ? process.env.PLANE_RUNS_PATH
    : path.join(repoRoot(), "local-assets", "plane", "runs.jsonl");
}
export function appendRun(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), version: 1, ...record });
  if (scanForbidden(line)) {
    /* drop error + free-text fields, add redacted:true, re-serialise */
  }
  fs.mkdirSync(path.dirname(runsPath()), { recursive: true });
  fs.appendFileSync(runsPath(), line + "\n");
}
// every tool: const started = Date.now(); let rec = { tool: "plane-sync", flags, branch }; try { … } catch (e) { rec.error = `${e.name}: ${String(e.message).slice(0,200)}`; } finally { appendRun({ ...rec, exit: process.exitCode ?? 0, durationMs: Date.now() - started, ...client.summary() }); }
// plane-retro rule shape: { id: "sync-deferred", tool: "plane-sync", minRuns: 10, metric: (runs) => share(runs, r => r.deferred > 0), when: (v) => v >= 0.3, propose: (k) => [{ knob: "syncMaxWrites", to: k.syncMaxWrites.value + 50 }, gate5Deferred ? { knob: "gate5MaxWrites", to: k.gate5MaxWrites.value + 10 } : null] }
// clamp: to = Math.min(max, Math.max(min, to)); if (to !== proposed) status = "proposed-only (out of bounds)"; if (!autoTune) status = "proposed-only (manual knob)"; if (history.some(h => h.knob === knob && within(h.ts, days))) status = "held (moved this window)".
```

## 3. Code

### plane-client.mjs — loadKnobs/knob/runsPath/appendRun/summary + rate-limit line (full text)

```js
// L137-190
// Validated: every knob's `value` must sit within [min, max], else this
// throws `knobs invalid: <name>` — a caller (any plane-*.mjs tool) is
// expected to let this propagate BEFORE issuing any request, per the spec's
// hard line. Never swallowed here.
export function loadKnobs() {
  if (knobsCache) return knobsCache;
  const path = resolveKnobsPath();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  for (const [name, k] of Object.entries(parsed.knobs ?? {})) {
    if (!(Number(k.min) <= Number(k.value) && Number(k.value) <= Number(k.max))) {
      throw new Error(`knobs invalid: ${name}`);
    }
  }
  knobsCache = parsed;
  return knobsCache;
}

// Convenience accessor — `knob("triageGetBudget") -> 16`. Throws the same
// way loadKnobs() does when the file is invalid, plus `unknown knob: <name>`
// for a name not present.
export function knob(name) {
  const { knobs } = loadKnobs();
  if (!knobs || !(name in knobs)) throw new Error(`unknown knob: ${name}`);
  return knobs[name].value;
}

// ── run telemetry (R2) ──────────────────────────────────────────────────────
// Machine-local, gitignored via local-assets/ — PLANE_RUNS_PATH is a
// TEST-ONLY override, gated the same way as PLANE_KNOBS_PATH/
// PLANE_DENYLIST_PATH (PLANE_SYNC_SELF_TEST=1 required alongside it).
export function runsPath() {
  return process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_RUNS_PATH
    ? process.env.PLANE_RUNS_PATH
    : join(repoRoot(), "local-assets", "plane", RUNS_FILENAME);
}

// One JSON line per tool run, appended at exit (success or failure — every
// caller wraps this in a `finally`). Denylist-scanned before it ever touches
// disk: a hit drops `error` and `flags` (the two free-text-ish fields — a
// CLI flag or an error message is the only place an accidental secret could
// ride along; every other field here is a count or an enum) and adds
// `redacted: true` instead of writing the offending text. Never throws on a
// scan hit — only on a missing/malformed denylist (loadDenylist()'s own
// fail-closed contract, unchanged).
export function appendRun(record) {
  const base = { ts: new Date().toISOString(), version: 1, ...record };
  let line = JSON.stringify(base);
  if (scanForbidden(line)) {
    const { error, flags, ...safe } = base;
    line = JSON.stringify({ ...safe, redacted: true });
  }
  mkdirSync(dirname(runsPath()), { recursive: true });
  appendFileSync(runsPath(), line + "\n");
}
```

```js
// L393-401 rate-limit line (inside request())
const remaining = res.headers.get("x-ratelimit-remaining");
if (remaining === "0") {
  const resetHeader = res.headers.get("x-ratelimit-reset");
  const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : NaN;
  if (Number.isFinite(resetAtMs)) {
    rateLimitSleeps++;
    await sleep(Math.max(0, resetAtMs - Date.now() + 50));
  }
}
```

```js
// L539-541
    summary() {
      return { writes, deferred, forbidden, gets, rateLimitSleeps, retries };
    },
```

### plane-sync/triage/intake/apply.mjs — call sites only (file:line)

| File               | knobs-load call site                                                                            | telemetry `finally` block                 | knob-default lines                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `plane-sync.mjs`   | L1040 `knobs = loadKnobs();` (guarded per comment L1017)                                        | L1165 `} finally {` … L1167 `appendRun({` | (defaults read via `knobs` object post-L1040, no separate `knob("...")` calls found) |
| `plane-triage.mjs` | L319 `knobs = loadKnobs();` (comment context L72, L299)                                         | L386 `} finally {` … L392 `appendRun({`   | same pattern as sync — via `knobs` object                                            |
| `plane-intake.mjs` | L567 `loadKnobs();` / L568 `manualBudgetLimit = knob("applyManualBudgetPerDay")` (comment L545) | L697 `} finally {` … L704 `appendRun({`   | L568                                                                                 |
| `plane-apply.mjs`  | L502 `loadKnobs();` / L503 `manualBudgetLimit = knob("applyManualBudgetPerDay")` (comment L481) | L542 `} finally {` … L553 `appendRun({`   | L503                                                                                 |

Flag: `plane-intake.mjs` L568 reads the **`applyManualBudgetPerDay`** knob (the same name/semantics as `plane-apply.mjs`'s manual-write budget) — worth confirming intentional (shared budget) vs. copy-paste from apply.mjs during implementation.

### plane-doctor.mjs — check functions touching git/network/filesystem (full text, formatting-only helpers skipped)

```js
// L107-132 — resolveHome (fs/env) + currentBranch (git)
function resolveHome() {
  if (process.env.PLANE_SYNC_SELF_TEST === "1" && process.env.PLANE_DOCTOR_HOME) {
    return process.env.PLANE_DOCTOR_HOME;
  }
  return homedir();
}

function currentBranch() {
  let res;
  try {
    res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot(),
      env: gitEnv(),
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return "unknown";
  }
  if (!res || res.error || res.status !== 0) return "unknown";
  return (res.stdout || "").trim() || "unknown";
}
```

```js
// L138-161 checkKnobs / checkDenylist (fs via loadKnobs/loadDenylist)
function checkKnobs() {
  try {
    const { knobs } = loadKnobs();
    return result("knobs", "PASS", `${Object.keys(knobs ?? {}).length} knobs valid`);
  } catch (err) {
    return result("knobs", "FAIL", err?.message ?? String(err));
  }
}

function checkDenylist() {
  try {
    const patterns = loadDenylist();
    if (patterns.length >= MIN_DENYLIST_PATTERNS) {
      return result("denylist", "PASS", `${patterns.length} patterns`);
    }
    return result(
      "denylist",
      "FAIL",
      `only ${patterns.length} patterns (need >= ${MIN_DENYLIST_PATTERNS})`,
    );
  } catch (err) {
    return result("denylist", "FAIL", err?.message ?? String(err));
  }
}
```

```js
// L167-195 checkHelp (spawns each tool, filesystem + subprocess)
function checkHelp() {
  const failing = [];
  for (const script of HELP_SCRIPTS) {
    const p = join(THIS_FILE_DIR, script);
    if (!existsSync(p)) {
      failing.push(`${script} (missing)`);
      continue;
    }
    let res;
    try {
      res = spawnSync(process.execPath, [p, "--help"], {
        cwd: THIS_FILE_DIR,
        env: { ...gitEnv(), PLANE_API_KEY: "", PLANE_BASE_URL: "http://127.0.0.1:1" },
        encoding: "utf8",
        timeout: 5_000,
      });
    } catch (err) {
      failing.push(`${script} (${err?.message ?? err})`);
      continue;
    }
    if (!res || res.error || res.status !== 0) {
      failing.push(`${script} (exit ${res?.status ?? res?.error?.code ?? "error"})`);
    }
  }
  if (failing.length === 0) {
    return result("help", "PASS", `${HELP_SCRIPTS.length} scripts OK`);
  }
  return result("help", "FAIL", failing.join(", "));
}
```

```js
// L197-217 checkSettings (fs)
function checkSettings() {
  const p = join(repoRoot(), ".claude", "settings.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return result("settings", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const sessionStartCommands = (parsed?.hooks?.SessionStart ?? []).flatMap((entry) =>
    (entry?.hooks ?? []).map((h) => h?.command ?? ""),
  );
  if (!sessionStartCommands.some((cmd) => /plane-triage/.test(cmd))) {
    return result("settings", "FAIL", "SessionStart plane-triage hook missing");
  }
  const stopCommands = (parsed?.hooks?.Stop ?? []).flatMap((entry) =>
    (entry?.hooks ?? []).map((h) => h?.command ?? ""),
  );
  if (!stopCommands.some((cmd) => /stop\.mjs/.test(cmd))) {
    return result("settings", "FAIL", "Stop hook missing");
  }
  return result("settings", "PASS", "SessionStart + Stop hooks present");
}
```

```js
// L220-261 checkPackage / checkGitignore (fs)
function checkPackage() {
  const p = join(repoRoot(), "package.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    return result("package", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const scripts = parsed?.scripts ?? {};
  const missingScripts = REQUIRED_PLANE_NPM_SCRIPTS.filter((s) => !scripts[s]);
  if (missingScripts.length > 0) {
    return result("package", "FAIL", `missing scripts: ${missingScripts.join(", ")}`);
  }
  const verify = scripts.verify ?? "";
  const missingInVerify = REQUIRED_VERIFY_SUBSTRINGS.filter((s) => !verify.includes(s));
  if (missingInVerify.length > 0) {
    return result("package", "FAIL", `verify missing: ${missingInVerify.join(", ")}`);
  }
  if (!verify.includes("plane:doctor") || !verify.includes("--offline")) {
    return result("package", "FAIL", "verify missing plane:doctor -- --offline");
  }
  return result(
    "package",
    "PASS",
    `${REQUIRED_PLANE_NPM_SCRIPTS.length} plane:* scripts + verify wired`,
  );
}

function checkGitignore() {
  const p = join(repoRoot(), ".gitignore");
  let content;
  try {
    content = readFileSync(p, "utf8");
  } catch (err) {
    return result("gitignore", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const missing = REQUIRED_GITIGNORE_PATTERNS.filter((pat) => !content.includes(pat));
  if (missing.length > 0) {
    return result("gitignore", "FAIL", `missing patterns: ${missing.join(", ")}`);
  }
  return result("gitignore", "PASS", "ledger/state files covered");
}
```

```js
// L263-276 checkSkill (fs)
function checkSkill() {
  const p = join(repoRoot(), ".claude", "skills", "plane", "SKILL.md");
  if (!existsSync(p)) return result("skill", "FAIL", "SKILL.md missing");
  let size;
  try {
    size = statSync(p).size;
  } catch (err) {
    return result("skill", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  if (size > SKILL_MAX_BYTES) {
    return result("skill", "FAIL", `${size}B exceeds ${SKILL_MAX_BYTES}B`);
  }
  return result("skill", "PASS", `${size}B`);
}
```

```js
// L278-311 checkGate5 (fs)
function checkGate5() {
  const p = join(repoRoot(), ".claude", "hooks", "stop.mjs");
  let content;
  try {
    content = readFileSync(p, "utf8");
  } catch (err) {
    return result("gate5", "FAIL", `unreadable: ${err?.message ?? err}`);
  }
  const codeOnly = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
  const gateIdx = codeOnly.indexOf("plane-sync.mjs");
  if (gateIdx === -1) {
    return result("gate5", "FAIL", "Gate 5 spawn of plane-sync.mjs not found");
  }
  const block = codeOnly.slice(gateIdx, gateIdx + 2000);
  if (!block.includes("--max-writes")) {
    return result("gate5", "FAIL", "--max-writes missing from Gate 5 argv");
  }
  if (block.includes("--allow-branch")) {
    return result("gate5", "FAIL", "--allow-branch present (must never be passed)");
  }
  return result("gate5", "PASS", "--max-writes present, --allow-branch absent");
}
```

```js
// L313-324 checkScheduledTask / checkOpsDir (fs)
function checkScheduledTask() {
  const home = resolveHome();
  const p = join(home, ".claude", "scheduled-tasks", "routeflow-plane-daily", "SKILL.md");
  if (existsSync(p)) return result("scheduled-task", "PASS", "present");
  return result("scheduled-task", "WARN", "missing (machine-local)");
}

function checkOpsDir() {
  const p = join(repoRoot(), "local-assets", "plane", "ops");
  if (existsSync(p)) return result("ops-dir", "PASS", "present");
  return result("ops-dir", "WARN", "missing");
}
```

```js
// L328-339 checkProjects / checkMember (network — projects PASS-through, member is a static WARN, no request)
function checkProjects(projects) {
  const withIdentifier = (projects ?? []).filter((p) => p?.identifier);
  return result("projects", "PASS", `${withIdentifier.length} identifiers`);
}

function checkMember() {
  return result("member", "WARN", "no cheap member-lookup on the shared client (skipped)");
}
```

```js
// L345-396 checkLandingWithoutSync (fs runs.jsonl + git log)
function checkLandingWithoutSync() {
  let lastSyncTs = null;
  try {
    const p = runsPath();
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue; // a malformed telemetry line is skipped, never fatal
        }
        if (row?.tool === "plane-sync" && typeof row.ts === "string") {
          if (!lastSyncTs || row.ts > lastSyncTs) lastSyncTs = row.ts;
        }
      }
    }
  } catch {
    // an unreadable runs.jsonl reads as "no sync line" — handled below
  }

  let commitSha = null;
  let commitTs = null;
  try {
    const res = spawnSync(
      "git",
      ["log", "-1", "--format=%H%x1f%cI", "--", ".claude/campaign/status"],
      { cwd: repoRoot(), env: gitEnv(), encoding: "utf8", timeout: 5_000 },
    );
    if (res && !res.error && res.status === 0 && res.stdout && res.stdout.trim()) {
      const [sha, iso] = res.stdout.trim().split("\x1f");
      commitSha = sha || null;
      commitTs = iso || null;
    }
  } catch {
    // no repo / git error reads as "no such commits" — handled below
  }

  if (!commitTs) {
    return result("landing without sync", "PASS", "no status commits on this branch");
  }
  if (!lastSyncTs || commitTs > lastSyncTs) {
    const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(commitTs)) / 60_000));
    return result(
      "landing without sync",
      "WARN",
      `${(commitSha ?? "").slice(0, 7)} ${ageMin}m ago`,
    );
  }
  return result("landing without sync", "PASS", `last sync ${lastSyncTs} is newer`);
}
```

```js
// L403-427 checkDrift (network via child process — spawns plane-sync --check)
function checkDrift({ branch, apiKey }) {
  if (branch !== "master") {
    return result("drift", "WARN", `off master (branch ${branch}, skipped)`);
  }
  const script = join(THIS_FILE_DIR, "plane-sync.mjs");
  if (!existsSync(script)) {
    return result("drift", "WARN", "plane-sync.mjs missing, skipped");
  }
  let res;
  try {
    res = spawnSync(process.execPath, [script, "--check", "--quiet"], {
      cwd: repoRoot(),
      env: { ...gitEnv(), PLANE_API_KEY: apiKey ?? "" },
      encoding: "utf8",
      timeout: 20_000,
    });
  } catch (err) {
    return result("drift", "WARN", `could not run plane-sync --check: ${err?.message ?? err}`);
  }
  if (!res || res.error) {
    return result("drift", "WARN", "could not run plane-sync --check");
  }
  if (res.status === 0) return result("drift", "PASS", "no drift");
  return result("drift", "WARN", `drift detected (plane-sync --check exit ${res.status})`);
}
```

### plane-retro.mjs — rule table, clamp/held/apply logic, history write, lessons-candidates write (full text)

```js
// L255-354 RULES table
const RULES = [
  {
    id: "sync-deferred",
    tool: "plane-sync",
    minRuns: 10,
    metricName: "deferredRate",
    metric: (runs) => share(runs, (r) => (r.deferred ?? 0) > 0),
    when: (v) => v >= 0.3,
    propose: (runs, knobs) => {
      const proposals = [{ knob: "syncMaxWrites", to: knobs.syncMaxWrites.value + 50 }];
      const gate5Deferred = runs.some(
        (r) => (r.deferred ?? 0) > 0 && Array.isArray(r.flags) && r.flags.includes("--budget-ms"),
      );
      if (gate5Deferred)
        proposals.push({ knob: "gate5MaxWrites", to: knobs.gate5MaxWrites.value + 10 });
      return proposals;
    },
  },
  {
    id: "rate-limit-sleeps",
    tool: "*",
    minRuns: 10,
    metricName: "rateLimitSleepsMean",
    metric: (runs) => runs.reduce((a, r) => a + (r.rateLimitSleeps ?? 0), 0) / runs.length,
    when: (v) => v >= 2,
    propose: (runs, knobs) => [{ knob: "clientRatePerMin", to: knobs.clientRatePerMin.value - 10 }],
  },
  {
    id: "triage-partial",
    tool: "plane-triage",
    minRuns: 10,
    metricName: "partialRuns",
    metric: (runs) => runs.filter((r) => r.triage?.partial === true).length,
    when: (v) => v >= 2,
    propose: (runs, knobs) => [{ knob: "triageGetBudget", to: knobs.triageGetBudget.value + 8 }],
  },
  {
    id: "sync-settle-back",
    tool: "plane-sync",
    minRuns: 20,
    metricName: "quietRunShare",
    metric: (runs) =>
      share(runs.slice(-20), (r) => (r.deferred ?? 0) > 0 || (r.rateLimitSleeps ?? 0) > 0),
    when: (v) => v === 0,
    propose: (runs, knobs) => {
      const proposals = [];
      if (knobs.syncMaxWrites.value > DEFAULT_KNOB_VALUES.syncMaxWrites) {
        proposals.push({
          knob: "syncMaxWrites",
          to: Math.max(DEFAULT_KNOB_VALUES.syncMaxWrites, knobs.syncMaxWrites.value - 50),
        });
      }
      if (knobs.clientRatePerMin.value < DEFAULT_KNOB_VALUES.clientRatePerMin) {
        proposals.push({
          knob: "clientRatePerMin",
          to: Math.min(DEFAULT_KNOB_VALUES.clientRatePerMin, knobs.clientRatePerMin.value + 10),
        });
      }
      return proposals;
    },
  },
  {
    id: "stale-started-empty",
    tool: "plane-triage",
    minRuns: 10,
    metricName: "staleStartedEmptyStreak",
    metric: (runs) => {
      const last10 = runs.slice(-10);
      return last10.length === 10 && last10.every((r) => (r.triage?.staleStarted ?? 0) === 0)
        ? 1
        : 0;
    },
    when: (v) => v === 1,
    propose: (runs, knobs) => [{ knob: "staleStartedDays", to: knobs.staleStartedDays.value + 2 }],
  },
  {
    id: "forbidden-hotspot",
    tool: "*",
    minRuns: 10,
    metricName: "forbiddenHitsByPattern",
    lessonOnly: true,
    metric: (runs) => {
      const byPattern = {};
      for (const r of runs) {
        const bp = r.forbidden?.byPattern;
        if (!bp) continue;
        for (const [k, v] of Object.entries(bp)) byPattern[k] = (byPattern[k] ?? 0) + v;
      }
      return byPattern;
    },
    when: (v) => Object.values(v).some((n) => n >= 3),
  },
];
```

```js
// L413-471 clamp -> autoTune -> held-this-window precedence + history write
function resolveProposals(proposals, knobsFile, days, now, { mutate }) {
  const results = [];
  let applied = 0;
  let proposedOnly = 0;
  for (const p of proposals) {
    const def = knobsFile.knobs[p.knob];
    if (!def) {
      results.push({ ...p, status: "proposed-only (unknown knob)" });
      proposedOnly++;
      continue;
    }
    if (!def.autoTune) {
      results.push({ ...p, status: "proposed-only (manual knob)" });
      proposedOnly++;
      continue;
    }
    const clamped = Math.min(def.max, Math.max(def.min, p.to));
    if (clamped !== p.to) {
      results.push({ ...p, to: clamped, status: "proposed-only (out of bounds)" });
      proposedOnly++;
      continue;
    }
    const heldByHistory = (knobsFile.history ?? []).some(
      (h) => h.knob === p.knob && withinWindow(h.ts, days, now),
    );
    if (heldByHistory) {
      results.push({ ...p, to: clamped, status: "held (moved this window)" });
      proposedOnly++;
      continue;
    }
    if (!mutate) {
      results.push({ ...p, to: clamped, status: "proposed-only (preview)" });
      proposedOnly++;
      continue;
    }
    def.value = clamped;
    knobsFile.history = knobsFile.history ?? [];
    knobsFile.history.push({
      ts: new Date(now).toISOString(),
      knob: p.knob,
      from: p.from,
      to: clamped,
      reason: p.rule,
      evidence: p.evidence,
      by: "plane-retro",
    });
    results.push({ ...p, to: clamped, status: "applied" });
    applied++;
  }
  return { results, applied, proposedOnly };
}
```

```js
// L474-495 lessons-candidates write
function buildCandidateLessons(ruleResults, dateStr) {
  const lines = [];
  for (const r of ruleResults) {
    if (r.status !== "candidate-lesson") continue;
    for (const [pattern, count] of Object.entries(r.value ?? {})) {
      if (count < 3) continue;
      lines.push(
        `- ${dateStr} · forbidden pattern \`${pattern}\` (${r.id}) · ${count} hits in the window · ` +
          `candidate for .claude/lessons (never auto-filed)`,
      );
    }
  }
  return lines;
}

function appendCandidateLessons(path, lines) {
  if (!lines.length) return;
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, existing + sep + lines.join("\n") + "\n");
}
```

### .claude/hooks/stop.mjs — Gate 5 additions (full text, L310-363)

```js
// ── Gate 5 continued — usage guard (R6, 2026-09-12-plane-learning). Report-only,
// master/main only: prints the age of the newest `plane-sync` run recorded in
// `runs.jsonl`, and warns when a landing (a commit touching
// `.claude/campaign/status`) is newer than that sync — or no sync run exists at
// all. Never blocks: wrapped end-to-end in try/catch, and still falls through
// to the unconditional `process.exit(0)` below on any outcome.
try {
  const branch = sh("git rev-parse --abbrev-ref HEAD").out.trim();
  if (branch === "master" || branch === "main") {
    const clientPath = fileURLToPath(
      new URL("../../scripts/campaign/plane-client.mjs", import.meta.url),
    );
    if (existsSync(clientPath)) {
      const { runsPath, gitEnv } = await import(pathToFileURL(clientPath).href);
      const rp = runsPath();
      let lastSyncTs = null;
      if (existsSync(rp)) {
        for (const line of (readFileSync(rp, "utf8") || "").split(/\r?\n/).filter(Boolean)) {
          try {
            const rec = JSON.parse(line);
            const t = rec && rec.tool === "plane-sync" ? Date.parse(rec.ts) : NaN;
            if (!Number.isNaN(t) && (lastSyncTs === null || t > lastSyncTs)) lastSyncTs = t;
          } catch {
            // one malformed line must never take down the guard — skip it
          }
        }
      }
      if (lastSyncTs !== null) {
        process.stderr.write(`Plane: last sync ${formatAge(Date.now() - lastSyncTs)} ago\n`);
      }
      const statusLog = spawnSync(
        "git",
        ["log", "-1", "--format=%H %cI", "--", ".claude/campaign/status"],
        { encoding: "utf8", env: gitEnv() },
      );
      const statusLine = (statusLog.stdout || "").trim();
      let sha = "";
      let warn = lastSyncTs === null;
      if (statusLine) {
        const [commitSha, commitIso] = statusLine.split(" ");
        sha = commitSha;
        const commitTs = Date.parse(commitIso);
        if (lastSyncTs === null || (!Number.isNaN(commitTs) && commitTs > lastSyncTs)) warn = true;
      }
      if (warn) {
        process.stderr.write(`Plane: WARN landing without sync (${sha})\n`);
      }
    }
  }
} catch {
  // the usage guard is advisory-only — never let it block or crash the turn
}

process.exit(0);
```

`formatAge` helper (L47-55, pre-existing, used above):

```js
function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
```

### scripts/campaign/plane-knobs.json (whole file)

```json
{
  "version": 1,
  "knobs": {
    "clientRatePerMin": { "value": 50, "min": 20, "max": 55, "autoTune": true },
    "triageGetBudget": { "value": 16, "min": 12, "max": 40, "autoTune": true },
    "gate5MaxWrites": { "value": 25, "min": 5, "max": 60, "autoTune": true },
    "syncMaxWrites": { "value": 250, "min": 50, "max": 500, "autoTune": true },
    "applyManualBudgetPerDay": { "value": 20, "min": 10, "max": 40, "autoTune": false },
    "staleStartedDays": { "value": 7, "min": 3, "max": 21, "autoTune": true }
  },
  "history": []
}
```

## 4. Self-test case/oracle inventory

**Assertion mechanism (repo convention, `plane-learning.self-test.mjs` L331-335):**

```js
let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  ...
}
```

- `plane-learning.self-test.mjs` — 890 lines. Structure found by section scan: `startFakeBugs()`
  (L161, fake server harness), `runKnobsProbe()` (L295, drives a script against a fake server to
  assert zero/limited requests before a knobs-invalid throw — this is the T1 "throw before any
  request" oracle), `main()` (L341-860, the actual case bodies via repeated `check(name, got,
want)` calls), a dedicated `checkInvalidKnobsGuard(label, scriptPath, argv, envBuilder)` helper
  (L391) reused across sync/triage/intake/apply/doctor/retro for the T1 "invalid knobs" case per
  tool, and an invoice-number denylist-redaction assertion around L815 (`lessonsContent...
includes("invoice-number")` — a **T2/T4 forbidden-pattern** oracle, not vacuous: it greps the
  actual candidate-lessons content for the pattern name rather than just checking exit code).
  Top-level `try { await main(); } catch (err) { failures++; }` (L860-862) plus `process.exit
(failures ? 1 : 0)` (L890) is the harness. Could not enumerate every individual `check(...)`
  call's name/oracle pair within the tool-call budget — the file uses `check(name, got, want)`
  with computed `name` strings/template literals in many calls, which a literal-string grep does
  not surface; a full per-case listing needs either a targeted re-read of `main()` (~520 lines) or
  a grep for `check(` without the string-literal anchor.
- `plane-doctor.self-test.mjs` — new file (excluded from the four-file concurrency exclusion,
  but not read line-by-line this pass for the same budget reason). Given plane-doctor.mjs's
  scaffolded-temp-repo design (PLANE_DOCTOR_HOME, PLANE_SYNC_SELF_TEST-gated overrides), expect
  its cases to mirror spec.md T3's oracles (all-PASS scaffold, missing SessionStart hook → FAIL,
  missing scheduled-task file → WARN not FAIL, online 5-project fake → PASS + ≤3 GETs, stale
  runs.jsonl → WARN landing without sync, no key → WARN skipped) — **not independently verified
  in this pass; flag for a follow-up read before sign-off.**
- **New T5 cases** (spec.md: package.json scripts + verify string; SKILL.md ≤6144B mentions
  plane-doctor/plane-retro/plane-knobs; scheduled-task SKILL.md WARN-style presence check) belong
  in `plane-docs.self-test.mjs` (116 lines added/changed per diff stat) — not read this pass.
- **New T6 cases** (stop.gate5.spec: master fixture + 1h-old sync line → contains `Plane: last
sync`; newer status-shard commit → `Plane: WARN landing without sync`; off master → neither)
  belong in `.claude/hooks/stop.gate5.spec.mjs` (+131 lines per diff stat) — not read this pass.

**Open flag:** sections T5/T6/plane-doctor.self-test.mjs oracle text is inferred from spec.md's
T-table, not confirmed against the actual assertions in the diff. Recommend a targeted follow-up
read of these three files' `check(...)` call sites before treating test coverage as verified.

## 5. verify string (package.json)

```
node scripts/campaign-check.mjs --freshness-only && node scripts/validate-lock-edges.mjs && node scripts/validate-lessons.mjs && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --self-test && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs && turbo run check-types lint test test:repo-truth --concurrency=2 --continue=dependencies-successful && node scripts/campaign/bugs.mjs self-test && node scripts/campaign/plane-sync.self-test.mjs && node scripts/campaign/plane-intake.self-test.mjs && node scripts/campaign/plane-triage.self-test.mjs && node scripts/campaign/plane-apply.self-test.mjs && node scripts/campaign/plane-learning.self-test.mjs && node scripts/campaign/plane-doctor.self-test.mjs && npm run plane:doctor -- --offline && node scripts/campaign/plane-docs.self-test.mjs && node .claude/hooks/stop.gate5.spec.mjs && node scripts/campaign-check.mjs
```
