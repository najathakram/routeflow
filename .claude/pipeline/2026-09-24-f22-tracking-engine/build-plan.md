# Build plan — F-22 "Tracking engine: registers, gates and auto-published views" (S5)

> **Stage S5 — "how".** Authored by Fable 5.1 on `2026-09-24`.
> Status: `DRAFT` (DRAFT | APPROVED | IMPLEMENTED | CLOSED)
> Written AFTER [test-plan.md](./test-plan.md) — the tests decide the shape of the work.
> This file is the ONLY context the implementation and review agents receive. It stands alone.
> Inputs: [discovery.md](./discovery.md) (why), [spec.md](./spec.md) (`R1`–`R19`),
> [test-plan.md](./test-plan.md) (`T1`–`T36`). No ux-spec (no UI).
> **PLAN ONLY on this machine** — no engine launch; a human lead reviews first.

**Gate to pass before S6:** every work package declares `satisfies:` and `provenBy:`. Checked
in the package map.

**Ground rule — nothing named here is invented.** Grounded 2026-09-24 at
`docs/code-map-web-mobile-catchup` @ `fd69298f`. Existing files this plan EDITS:
`scripts/roadmap/render.mjs`, `scripts/campaign/plane-fake-server.mjs`, `package.json`,
`.claude/settings.json`, `.github/PULL_REQUEST_TEMPLATE.md`, `.claude/roadmap/README.md`.
Files this plan CREATES (marked `(new)` everywhere): `scripts/roadmap/from-git.mjs`,
`scripts/roadmap/publish.mjs`, `scripts/roadmap/render.self-test.mjs`,
`scripts/roadmap/from-git.self-test.mjs`, `scripts/roadmap/publish.self-test.mjs`,
`scripts/roadmap/roadmap-docs.self-test.mjs`, `.husky/post-merge`. Files this plan EDITS (added
2026-09-24, fleet lead ruling, F-2/test-plan.md): `scripts/campaign/plane-client.mjs` — WP3 adds
two optional, test-only `createClient({ ... })` constructor params, `minWriteIntervalMs` and
`retryBackoffMs`, DEFAULTING to today's real constants (260 ms; `[300, 600, 900]`) so every
existing caller (production, and every OTHER Plane self-test) is byte-identical in behavior;
`publish.self-test.mjs` is the only caller ever passing an override (zero delay, against the fake
server), which is how R19/F-2 gets resolved without weakening the real client or building a
second HTTP client. Files this plan READS but otherwise never edits (exports used beyond the two
new params: `scanForbidden`, `loadDenylist`, `appendRun`, `gitEnv`):
`scripts/campaign/plane-denylist.json`,
`scripts/campaign/plane-docs.self-test.mjs` (the pattern to copy),
`scripts/campaign/plane-triage.self-test.mjs` (the spawn/fixture pattern),
`scripts/campaign/plane-sync.mjs` (line 1247, the `main()` guard), `.husky/_/h` (husky's
loader, runs a hook with `sh -e`), `.lintstagedrc.json`, `.claude/skills/plane/SKILL.md`
(**never edited** — 6132 of a 6144-byte cap).

**Preamble omitted** — major scale; discovery.md and spec.md carry the problem and requirements.

**Findings carried from S4 for the lead (not decided here):** F-1 (spec: the F-22 row's own
`targetDate`/`release` — bookkeeping PR), F-2 (test-plan: R19's "< 1 s each" → per-file
budgets), F-3 (test-plan: R10/R11 live proof is env-gated; the PC runs it once after merge).

---

## Objective

Make the three roadmap registers (`.claude/roadmap/{features,deferred,releases}.jsonl`)
self-policing and their views self-publishing: `npm run verify` refuses an inconsistent
register; a render writes a machine-readable `lag.json` and a content-hash stamp; every new
session prints a four-line `Roadmap` block saying what the registers hold, what is lagging, and
whether the local render and the published copy are stale — with the one command that fixes
each; a from-git report tells the coordinator which PR numbers git says belong to which feature
(and how few commits carry a trailer yet); and one command renders, denylist-scans and publishes
the three pages to Plane (Pages if the probe confirms them, else three pinned ROAD work items),
then runs the existing bug-sync and triage — the composite a machine-local hourly task on the PC
runs.

**In scope:** R1–R19 as written in spec §9, including the `should`/`could` rows R7, R14, R15,
R16, R17, R18 (kept: each is a few lines riding on a file a `must` package already owns, and
the README/PR-template/hook are where adoption actually happens). R15's install is manual.
**Explicitly out of scope (spec §6 / discovery §10):** auto-writing `status`, `percentDone`,
`targetDate`, `notes` or any deferral/release field; any tool running `git commit`/`git push`/`gh`;
blocking commits that lack a trailer; editing any F-09 script (`plane-client.mjs`,
`plane-sync.mjs`, `plane-triage.mjs`, `plane-doctor.mjs`, …) or `.claude/skills/plane/SKILL.md`;
network inside `verify`, the SessionStart hook or the git hook; ROAD cycle/module automation;
public hosting of the HTML; a fleet-wide scheduler; changes to `bugs.jsonl`, the code map or the
lessons register; fixing the F-22 row itself (F-1).

---

## Constraints & conventions

- **Stack / framework:** standalone Node ESM scripts, **no new dependency** — `node:fs`,
  `node:path`, `node:crypto`, `node:child_process`, `node:url`, `node:os` only. `fetch` is
  reached only through `plane-client.mjs`'s `createClient()` (never a second HTTP client).
  Node ≥ 18 (CI pins 20; this host runs 24). No TypeScript under `scripts/`.
- **Test runner and layout:** the repo's hand-rolled **standalone self-test** convention — a
  plain `.mjs` run directly (`node scripts/roadmap/<name>.self-test.mjs`), a local
  `check(name, got, want)` printing `  ok  ` / `  FAIL` (with `got`/`want` on failure),
  `process.exit(failures ? 1 : 0)`; a summary line `<name>.self-test: all checks passed` /
  `<n> FAILURE(S)`. Copy `scripts/campaign/plane-docs.self-test.mjs` (static checks) and
  `scripts/campaign/plane-triage.self-test.mjs` (spawned CLI + fake server + fixture sweep)
  exactly. **No `node:test`, no Jest project, no Vitest** under `scripts/`.
- **Header rule for every self-test:** every read is `existsSync`-guarded (`readIfExists`),
  every new module is reached by `await import()` in try/catch or by `spawn`, so on a clean
  tree each check fails on a `false`/absent assertion — never an ENOENT/`ERR_MODULE_NOT_FOUND`
  throw (`plane-docs.self-test.mjs` header, test-plan §6).
- **Lint / format:** Prettier — semicolons, double quotes, `printWidth` 100, trailing commas.
  `.lintstagedrc.json` formats `*.mjs` at commit. **Format only the files you own:**
  `npx prettier --write <your files>`; never `npm run format` (repo-wide glob) and never touch
  another package's file to format it. `scripts/roadmap/render.mjs` and
  `.claude/roadmap/README.md` are **not** prettier-clean today — WP1/WP4 reformat them as part
  of their edit and say so in `report.md`; the perRound `--check` deliberately lists only files
  that are clean today.
- **Existing patterns to copy rather than invent:**
  - `scripts/campaign/plane-sync.mjs:1247` — the `main()` guard:
    `if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();`
  - `scripts/campaign/plane-triage.mjs` `main()` — `--help`/`-h` and unknown-flag handling
    **before** any `process.env` read; `USAGE` string; `KNOWN_FLAGS` set; `appendRun` in a
    `finally` for every run except help/usage exits; the exact
    `<Tool>: skipped (no PLANE_API_KEY)` skip line.
  - `scripts/campaign/plane-client.mjs` — `gitEnv()` for every git spawn (scrubs `GIT_*`; the
    worktree-hook trap); `PLANE_SYNC_SELF_TEST=1` + `PLANE_MACHINE_ROOT`/`PLANE_SYNC_STATE_DIR`/
    `PLANE_RUNS_PATH` as the state overrides; the client's `post`/`patch` return
    `{ forbidden }` / `{ deferred }` objects instead of throwing on a denylist hit or budget stop.
  - `scripts/roadmap/render.mjs:17` — `ROOT` from `import.meta.url` (L-194); keep it.
  - `scripts/campaign/plane-docs.self-test.mjs` — `existingHooksIntact`, positional `verify`
    assertions, the `skip` line for machine-local files.
  - `scripts/campaign-check.mjs` — the STALE message _shape_ only (`<what> is STALE — generated
<when> but <cause> … Regenerate it: <command>`); `--first-parent` on `git log` (its F1 note).
- **Must NOT change:** any file under `scripts/campaign/` other than the additive fake-server
  seeds in WP3; `.claude/skills/plane/SKILL.md`; the existing SessionStart element's text; the
  `hooks.PostToolUse`/`hooks.Stop` arrays; `render.mjs`'s existing `--validate` error strings
  (T1 characterizes them); the on-disk JSONL register format; the existing `plane:*` scripts.
- **Do-not-introduce (CLAUDE.md):** Vitest · Biome · Supabase · Vercel · a second HTTP client ·
  a root-level test runner or root ESLint config · any npm dependency.
- **Live-client policy (CLAUDE.md):** no live client slug/name/uuid/invoice number anywhere —
  fixtures use `Alpha`/`Beta`-style names; every rendered byte passes `scanForbidden` before a
  request.
- **Landmines:**
  1. `render.mjs` calls `main()` **unguarded** at the bottom today — importing it runs a render
     into `local-assets/roadmap/`. WP1's first edit is the guard.
  2. `loadJsonl()` returns `[]` for a missing file — `--status` must `existsSync` each register
     explicitly to print `registers unreadable (<path>)` (R5).
  3. Both HTML footers call `new Date()` — idempotence (T3) needs the injected `now` there too.
  4. `git log` is newest-first — from-git needs `--reverse` (T12's untagged order) and
     `--first-parent`.
  5. The client's `get()` **throws** on any non-2xx (`GET <path> -> HTTP <status>…`); there is
     no status-returning GET. The probe parses `/-> HTTP (\d{3})/` from the error message.
  6. The client retries 429/5xx **three** times with 300/600/900 ms sleeps — a fake that 500s
     once is retried into success; `failWrite.times` must be 4 (T22).
  7. `client.post`/`patch` may return `{ forbidden: {name} }` or `{ deferred: true }` instead of
     a created object — treat both as a failed write (no stamp, exit 1).
  8. The composite spawns `plane-sync.mjs`/`plane-triage.mjs`; in the publish self-test those
     REAL scripts would hit the fake server and pollute `requests` — every publish spawn in the
     self-test sets `ROADMAP_CAMPAIGN_DIR` to a stub dir (test-plan §7).
  9. `PLANE_SYNC_SELF_TEST=1` must accompany every path override or the client silently writes
     the REAL ledger/runs file on this machine.
  10. husky's loader `.husky/_/h` runs a hook with `sh -e` — each command in `.husky/post-merge`
      ends with `|| true` or the second never runs. Repo hooks carry no shebang
      (`.husky/pre-commit`); don't add one.
  11. macOS `os.tmpdir()` is under `/var` → `/private/var`; `realpathSync` fixture paths before
      comparing them to anything git or a child prints (B573).
  12. `git status --porcelain -- <path>` for the dirty check must use the reg dir's own path
      (under the fixture repo), not `.claude/roadmap` relative to `ROOT`.
  13. The PR template's placeholder lines (`Feature: F-`, `Bug: B`, `Defers: D-`) reach squash
      commit bodies unfilled — `parseTrailers` drops exactly those three tokens silently (never
      "unknown", never "tagged").
  14. `node --import <path>` (T9/T16) needs an absolute path or file URL.
  15. `.claude/settings.json`: ADD a second element to `hooks.SessionStart`; never replace the
      `hooks` object (`existingHooksIntact`).
  16. The status byte cap must be met by **rebuilding** the LAG line with fewer ids (`+N more`),
      never by slicing the string.

---

## Test packages

_In the `lean` profile there is no separate test author: each WP below writes its own
self-test first (RED, pasted into `report.md`), then the implementation (GREEN). The TP sections
define what those files assert; the WP that owns each file is named._

### TP1 — `render.self-test.mjs` (owned by WP1)

- **writes:** `scripts/roadmap/render.self-test.mjs` (new)
- **tests:** T1, T2 (+ T2-p1…p4), T3, T4, T5, T6, T7, T8, T9, T10, T36
- **brief:** Fixture A / defects D1–D5 / fixtures B, C exactly as test-plan §7 (`writeFixtureA(dir)`
  and one-line mutators). Reach `render.mjs` two ways: `await import(pathToFileURL(RENDER))`
  in try/catch for the in-process checks (T2, T4, T5, T7, T2-p*), and `spawn(process.execPath,
[RENDER, ...argv], { env })` for the CLI checks (T1, T3, T6, T8, T9, T10) with
  `env = { ...gitEnv(), ROADMAP_SELF_TEST: "1", ROADMAP_NOW: "2026-01-12T10:00:00Z",
ROADMAP_REG_DIR: <fixture> }`. Oracles: T4's exact-line table in test-plan §2.1; T1's five
  strings; T2's ids `["F-01","F-02"]`/`[2,1]` and `D-01`/`7`; the independent sha256 computed in
  the test with `createHash("sha256")` over the three files' bytes in order; T5's `≤ 768` /
  `+N more`; T6's four exit-0 lines; T8's two `warn:` strings. T9's stub file content:
  `globalThis.fetch = () => { throw new Error("network forbidden in self-test"); };`.
  Print the measured ms in T7's `ok` line and the file's own wall-clock in the summary (T36).
- **must fail with:** `FAIL T2 (R2): render.mjs exports … got {"renderAll":false,…}`; `FAIL T1
(R1): defect D1 → exit 1 … got {"code":0}`; `FAIL T6 (R5): … line1 "wrote roadmap.html, …"`.

### TP2 — `from-git.self-test.mjs` (owned by WP2)

- **writes:** `scripts/roadmap/from-git.self-test.mjs` (new)
- **tests:** T11, T12, T13, T14, T15, T16, T17, T36
- **brief:** Build fixture repo G exactly as test-plan §7 (`git init -q`; every commit
  `git -c user.name=t -c user.email=t@example.invalid commit -q -m <subject> -m <body>`; env
  `gitEnv()`; `realpathSync` the dir). T11's table (test-plan §2.1) plus the placeholder row
  (`Feature: F-\nBug: B\nDefers: D-` → all four arrays empty). T12's exact block with the
  fixture's real sha7s substituted (read them back with `git log --reverse --format=%h`). T14:
  after `--apply`, compare `features.jsonl` line-by-line to the pre-apply copy — exactly one line
  differs and it differs only in the `"prs":[…]` substring; `git diff --cached --quiet` exits 0;
  then commit, re-run → `--apply: nothing to write`; dirty case; D1 case. T15: blank
  `"prs":[…]` → `"prs":[]` in both copies and compare bytes; static grep the three scripts'
  comment-stripped sources. T16 uses TP1's stub-file recipe.
- **must fail with:** `FAIL T11 (R6): from-git.mjs exports parseTrailers … got {"exists":false}`;
  `FAIL T12 (R6): report block … got {"code":1,"stdout":""}`.

### TP3 — `publish.self-test.mjs` + fake-server seeds (owned by WP3)

- **writes:** `scripts/roadmap/publish.self-test.mjs` (new); `scripts/campaign/plane-fake-server.mjs`
  (additive seeds `pages`, `failWrite` — exact code in WP3)
- **tests:** T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28, T36
- **brief:** `startFakePlane(seed)` per case; env on every spawn:
  `{ ...gitEnv(), PLANE_SYNC_SELF_TEST: "1", PLANE_MACHINE_ROOT: <tmp>, PLANE_SYNC_STATE_DIR:
<tmp>/plane, PLANE_RUNS_PATH: <tmp>/runs.jsonl, PLANE_BASE_URL: server.url, PLANE_API_KEY:
"self-test-key", ROADMAP_SELF_TEST: "1", ROADMAP_NOW: "2026-01-12T10:00:00Z", ROADMAP_REG_DIR:
<fixture>, ROADMAP_CAMPAIGN_DIR: <tmp>/campaign, STUB_CALLS_LOG: <tmp>/calls.log,
STUB_EXIT_SYNC, STUB_EXIT_TRIAGE }` (delete `PLANE_API_KEY` for T26). Stub children source is
  test-plan §7. Ledger path = `<tmp>/plane/.plane-writes.jsonl`. Assert request sequences from
  `server.requests` (`{method, path, query, body}`); non-GET = `method !== "GET"`. T21's
  `.published.json` oracle is the literal object in test-plan T21 with the fixture hash computed
  independently. T20/T24 use the `liveGate` helper (exact code below); the summary line lists
  skipped ids. Grep the temp ledger and runs file for `self-test-key` → absent.
- **exact code (the live gate):**

```js
// Runs a live check only when the operator opted in AND a key exists. Half-configured = FAIL,
// so a green run can never be misread as "Pages confirmed" (test-plan F-3; describeDb's rule).
const skipped = [];
function liveGate(tName, what) {
  const optIn = process.env.ROADMAP_LIVE_PROBE === "1";
  const hasKey = Boolean(process.env.PLANE_API_KEY);
  if (optIn && hasKey) return true;
  if (optIn) {
    check(
      `${tName}: ROADMAP_LIVE_PROBE=1 set but PLANE_API_KEY is absent`,
      { hasKey },
      { hasKey: true },
    );
    return false;
  }
  skipped.push(tName);
  console.log(
    `  skip  ${tName}: ${what} not run on this machine — set ROADMAP_LIVE_PROBE=1 and PLANE_API_KEY to run it (the only proof that retires D-A1)`,
  );
  return false;
}
// summary:
console.log(
  failures
    ? `\npublish.self-test: ${failures} FAILURE(S)`
    : `\npublish.self-test: all checks passed${skipped.length ? ` (skipped: ${skipped.join(", ")} — live probe; run with ROADMAP_LIVE_PROBE=1 PLANE_API_KEY=… on the PC)` : ""}`,
);
```

- **must fail with:** `FAIL T18 (R10): probe file written … got {"exists":false}`; `FAIL T21
(R11): run 1 → 3 POSTs … got {"nonGet":0}`; on this machine `skip T20`, `skip T24` print
  regardless (neither red nor green).

### TP4 — `roadmap-docs.self-test.mjs` (owned by WP4)

- **writes:** `scripts/roadmap/roadmap-docs.self-test.mjs` (new)
- **tests:** T29, T30, T31, T32, T33, T36
- **brief:** Pure file-content assertions, `readIfExists` everywhere, modelled line-for-line on
  `plane-docs.self-test.mjs`. T29 positional indices over `scripts.verify`; T30 `JSON.stringify`
  equality of element 0 against the literal
  `{"hooks":[{"type":"command","command":"node scripts/campaign/plane-triage.mjs --brief"}]}`;
  T31 token greps over `.husky/post-merge`, `render.mjs`, `from-git.mjs` (strip `//` comment
  lines first; the plane-client import specifier check: parse `import {…} from "../campaign/plane-client.mjs"`
  and assert the set ⊆ `{gitEnv}`); T32/T33 token lists from the test plan; T33's SKILL.md check:
  `spawnSync("git", ["show", "HEAD:.claude/skills/plane/SKILL.md"], { env: gitEnv() })` equals the
  working-tree bytes. Must itself finish < 1000 ms (T36).
- **must fail with:** `FAIL T29 (R1): verify contains render.mjs --validate … got {"validateInVerify":false}`;
  `FAIL T30 (R4): SessionStart has two elements … got {"length":1}`; `FAIL T31: .husky/post-merge exists … got {"exists":false}`.

**Red gate command** (every check must fail on an assertion; `skip` rows are neither):

```bash
node scripts/roadmap/render.self-test.mjs; node scripts/roadmap/from-git.self-test.mjs; node scripts/roadmap/publish.self-test.mjs; node scripts/roadmap/roadmap-docs.self-test.mjs
```

---

## Work packages

Rules: file lists are DISJOINT; ordering only via `dependsOn:`; each package implementable from
this file alone; effort omitted everywhere (= medium; LOW risk throughout).

### WP1 — `render.mjs`: guard, seams, stamps, `lag.json`, `--status`, warnings, `--help`

- **files:** `scripts/roadmap/render.mjs`
- **tests:** `scripts/roadmap/render.self-test.mjs` (new — TP1)
- **satisfies:** R2, R3, R5, R17, R19 (`--help` on render; timing)
- **provenBy:** T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T36
- **dependsOn:** none
- **brief:** Extend the existing renderer in place (do not create a second renderer). Keep
  `ROOT`, `loadJsonl`, `validate` (its error strings are characterized by T1), the HTML
  builders and CSS. Add: the `main()` guard; the self-test seams; `regDir()`/`nowIso()`;
  `registersHash`; `computeLag` as the ONE LAG rule used by the tracker HTML, `lag.json` and the
  status line; atomic writes; `renderAll`; `statusReport`; `validateWarnings`; `--status`,
  `--help`/`-h`, unknown-flag → exit 2 with `Usage:` on stderr. `--validate` prints warnings to
  stderr after its OK line (exit code unchanged). Render also reads `bugs.jsonl` from
  `<regDir>/bugs.jsonl` when the `ROADMAP_REG_DIR` seam is active (absent → `[]`), else from
  `.claude/campaign/bugs.jsonl` as today. `renderTracker`'s inline `today`/`lagFeatures`/`lagDeferred`
  are replaced by the injected `day` and `computeLag`'s result (same HTML output). Reformat the
  file with prettier (it is not clean today) and note that in `report.md`.
- **exact code (transplant; names are the contract WP2/WP3 import):**

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gitEnv } from "../campaign/plane-client.mjs"; // the ONLY plane-client import allowed here (T31)

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REG_FILES = ["features.jsonl", "deferred.jsonl", "releases.jsonl"];
export const HTML_FILES = ["roadmap.html", "tracker.html", "deferred.html"];
export const STATUS_BYTE_CAP = 768;
const SELF_TEST = process.env.ROADMAP_SELF_TEST === "1";

// Seams (test-only, gated like PLANE_SYNC_SELF_TEST=1 + PLANE_RUNS_PATH in plane-client.mjs):
//   ROADMAP_REG_DIR   register directory override
//   ROADMAP_NOW       ISO timestamp used as "now" (footers, stamps, the LAG day)
//   ROADMAP_STATUS_THROW=1  force the status "failed" branch
export function regDir() {
  return SELF_TEST && process.env.ROADMAP_REG_DIR
    ? process.env.ROADMAP_REG_DIR
    : join(ROOT, ".claude", "roadmap");
}
export function defaultOutDir() {
  return join(ROOT, "local-assets", "roadmap");
}
export function nowIso() {
  if (SELF_TEST && process.env.ROADMAP_NOW) return new Date(process.env.ROADMAP_NOW).toISOString();
  return new Date().toISOString();
}
export const dayOf = (iso) => iso.slice(0, 10);
export const sha7 = (h) => (h ? String(h).slice(0, 7) : "unknown");

export function registersHash(dir = regDir()) {
  const h = createHash("sha256");
  for (const f of REG_FILES) h.update(readFileSync(join(dir, f)));
  return h.digest("hex");
}

// Throws an Error with `.unreadable = <path>` for a missing or unparsable register (R5).
export function loadRegisters(dir = regDir()) {
  const out = {};
  for (const f of REG_FILES) {
    const p = join(dir, f);
    if (!existsSync(p))
      throw Object.assign(new Error(`registers unreadable (${p})`), { unreadable: p });
    try {
      out[f.replace(".jsonl", "")] = loadJsonl(p);
    } catch {
      throw Object.assign(new Error(`registers unreadable (${p})`), { unreadable: p });
    }
  }
  return out; // { features, deferred, releases }
}

const utcDay = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysLate = (date, day) => Math.round((utcDay(day) - utcDay(date)) / 86_400_000);

// THE LAG rule. Strict `<` on the UTC calendar day; `done` never lags; a deferral lags only while open.
export function computeLag(features, deferred, day) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    features: features
      .filter((f) => f.targetDate < day && f.status !== "done")
      .sort(byId)
      .map((f) => ({
        id: f.id,
        targetDate: f.targetDate,
        status: f.status,
        daysLate: daysLate(f.targetDate, day),
      })),
    deferred: deferred
      .filter((d) => d.status === "open" && d.revisitBy < day)
      .sort(byId)
      .map((d) => ({ id: d.id, revisitBy: d.revisitBy, daysLate: daysLate(d.revisitBy, day) })),
  };
}

export function validateWarnings(features, releases, day) {
  const ship = new Map(releases.map((r) => [r.id, r.shipDate]));
  const warns = [];
  for (const f of features) {
    const s = ship.get(f.release);
    if (s && f.targetDate > s)
      warns.push(`warn: ${f.id} targetDate ${f.targetDate} is after ${f.release} ships ${s}`);
    if (f.targetDate < day && f.status === "planned" && Number(f.percentDone) === 0) {
      warns.push(`warn: ${f.id} is past its targetDate (${f.targetDate}) but still planned at 0%`);
    }
  }
  return warns;
}

export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function headSha() {
  try {
    const r = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      env: gitEnv(),
      encoding: "utf8",
    });
    return r.status === 0 && r.stdout ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// Returns { errors } on invalid registers (nothing written) or { errors: [], stamp, lag, files }.
export function renderAll({
  outDir = defaultOutDir(),
  prsPath = null,
  now = nowIso(),
  dir = regDir(),
} = {}) {
  const regs = loadRegisters(dir);
  const errors = validate(regs.features, regs.deferred, regs.releases);
  if (errors.length) return { errors };
  const day = dayOf(now);
  const prMap = prsPath
    ? new Map(JSON.parse(readFileSync(prsPath, "utf8")).map((p) => [p.number, p.state]))
    : null;
  const bugsPath =
    SELF_TEST && process.env.ROADMAP_REG_DIR
      ? join(dir, "bugs.jsonl")
      : join(ROOT, ".claude", "campaign", "bugs.jsonl");
  const stats = bugCounts(regs.features, regs.deferred, loadJsonl(bugsPath));
  const lag = computeLag(regs.features, regs.deferred, day);
  mkdirSync(outDir, { recursive: true });
  writeAtomic(join(outDir, "roadmap.html"), renderRoadmap(regs.features, regs.releases, now));
  writeAtomic(
    join(outDir, "tracker.html"),
    renderTracker(regs.features, regs.deferred, regs.releases, prMap, stats, lag, day, now),
  );
  writeAtomic(join(outDir, "deferred.html"), renderDeferred(regs.deferred, regs.features, now));
  writeAtomic(
    join(outDir, "lag.json"),
    JSON.stringify({ generatedAt: now, day, ...lag }, null, 2) + "\n",
  );
  const stamp = { renderedAt: now, day, registersHash: registersHash(dir), headSha: headSha() };
  writeAtomic(join(outDir, ".rendered.json"), JSON.stringify(stamp, null, 2) + "\n");
  return { errors: [], stamp, lag, files: [...HTML_FILES, "lag.json", ".rendered.json"] };
}

// ── status ────────────────────────────────────────────────────────────────
function readStamp(path) {
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null; // a malformed stamp is "no stamp"
  }
}
function staleWhy(stamp, currentHash, today) {
  if (stamp.registersHash !== currentHash) return `registers are now ${sha7(currentHash)}`;
  if (stamp.day !== today) return `today is ${today}`;
  return null;
}
function countsLine({ features, deferred, releases }, today) {
  const c = (s) => features.filter((f) => f.status === s).length;
  const named = ["in-progress", "planned", "at-risk", "done"];
  const other = features.length - named.reduce((n, s) => n + c(s), 0);
  const next = releases
    .filter((r) => r.shipDate >= today)
    .sort((a, b) => (a.shipDate < b.shipDate ? -1 : 1))[0];
  return `Roadmap: ${features.length} features (${c("in-progress")} in-progress · ${c("planned")} planned · ${c("at-risk")} at-risk · ${c("done")} done${other ? ` · ${other} other` : ""}) · ${deferred.length} deferred (${deferred.filter((d) => d.status === "open").length} open) · next: ${next ? `${next.id} ships ${next.shipDate}` : "none"}`;
}
function lagLine(lag, keepF = lag.features.length, keepD = lag.deferred.length) {
  const list = (rows, keep) => {
    if (!rows.length) return "";
    const ids = rows.slice(0, keep).map((r) => `${r.id} -${r.daysLate}d`);
    if (rows.length > keep) ids.push(`+${rows.length - keep} more`);
    return ` (${ids.join(", ")})`;
  };
  return `Roadmap LAG: ${lag.features.length} features past target${list(lag.features, keepF)} · ${lag.deferred.length} deferred past revisitBy${list(lag.deferred, keepD)}`;
}
function renderLine(outDir, currentHash, today) {
  const fix = "→ node scripts/roadmap/render.mjs";
  const stampPath = join(outDir, ".rendered.json");
  const stamp = readStamp(stampPath);
  const anyHtml = HTML_FILES.some((f) => existsSync(join(outDir, f)));
  if (!stamp && !anyHtml)
    return `Roadmap render: never rendered on this machine (no ${stampPath}) ${fix}`;
  if (!stamp) return `Roadmap render: STALE — no stamp (regenerate once to stamp it) ${fix}`;
  const missing = HTML_FILES.find((f) => !existsSync(join(outDir, f)));
  if (missing) return `Roadmap render: STALE — ${missing} missing ${fix}`;
  const why = staleWhy(stamp, currentHash, today);
  if (why)
    return `Roadmap render: STALE — rendered ${stamp.renderedAt} (day ${stamp.day}, registers ${sha7(stamp.registersHash)}) but ${why} ${fix}`;
  return `Roadmap render: fresh (${stamp.renderedAt}, registers ${sha7(stamp.registersHash)})`;
}
function publishLine(outDir, currentHash, today, hasKey) {
  const stamp = readStamp(join(outDir, ".published.json"));
  if (!stamp) {
    return hasKey
      ? "Roadmap publish: never published on this machine → npm run roadmap:publish"
      : "Roadmap publish: no PLANE_API_KEY on this machine — the PC's hourly job publishes";
  }
  const why = staleWhy(stamp, currentHash, today);
  if (why) {
    return `Roadmap publish: STALE — last published ${stamp.publishedAt} (day ${stamp.day}, registers ${sha7(stamp.registersHash)}) but ${why} → npm run roadmap:publish${hasKey ? "" : " (needs PLANE_API_KEY)"}`;
  }
  return `Roadmap publish: fresh (${stamp.publishedAt}, target ${stamp.target})`;
}
const bytesOf = (lines) => Buffer.byteLength(lines.join("\n"), "utf8");

// Never throws; never network; ≤ 5 lines; ≤ 768 bytes (the LAG line is REBUILT with fewer ids).
export function statusReport({
  outDir = defaultOutDir(),
  now = nowIso(),
  hasKey = Boolean(process.env.PLANE_API_KEY),
  dir = regDir(),
} = {}) {
  try {
    if (SELF_TEST && process.env.ROADMAP_STATUS_THROW === "1") throw new Error("self-test throw");
    const today = dayOf(now);
    const lines = [];
    let regs = null;
    let currentHash = null;
    let lag = null;
    try {
      regs = loadRegisters(dir);
    } catch (err) {
      if (!err?.unreadable) throw err;
      lines.push(`Roadmap: registers unreadable (${err.unreadable})`);
    }
    if (regs) {
      currentHash = registersHash(dir);
      const errors = validate(regs.features, regs.deferred, regs.releases);
      if (errors.length)
        lines.push(
          `Roadmap: registers INVALID (${errors.length} problems) → node scripts/roadmap/render.mjs --validate`,
        );
      lines.push(countsLine(regs, today));
      lag = computeLag(regs.features, regs.deferred, today);
      lines.push(lagLine(lag));
    }
    const lagIdx = lag ? lines.length - 1 : -1;
    lines.push(renderLine(outDir, currentHash, today));
    lines.push(publishLine(outDir, currentHash, today, hasKey));
    if (lag) {
      let keepF = lag.features.length;
      let keepD = lag.deferred.length;
      while (bytesOf(lines) > STATUS_BYTE_CAP && (keepF > 0 || keepD > 0)) {
        if (keepF > 0) keepF--;
        else keepD--;
        lines[lagIdx] = lagLine(lag, keepF, keepD);
      }
    }
    return { lines, bytes: bytesOf(lines) };
  } catch (err) {
    const line = `Roadmap: status failed (${err?.message ?? err})`;
    return { lines: [line], bytes: Buffer.byteLength(line, "utf8") };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
const USAGE =
  "Usage: render.mjs [--validate] [--status] [--prs <gh-pr-list.json>] [--out <dir>] [--help]";
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const args = { validate: false, status: false, prs: null, out: defaultOutDir() };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--validate") args.validate = true;
    else if (tok === "--status") args.status = true;
    else if (tok === "--prs") args.prs = argv[++i];
    else if (tok === "--out") args.out = resolve(argv[++i]);
    else return { bad: tok };
  }
  return args;
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (args.bad) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (args.status) {
    // Exit 0 in EVERY case — a session start must never block on this (R5).
    let out;
    try {
      out = statusReport({ outDir: args.out });
    } catch (err) {
      out = { lines: [`Roadmap: status failed (${err?.message ?? err})`] };
    }
    process.stdout.write(out.lines.join("\n") + "\n");
    process.exitCode = 0;
    return;
  }
  // --validate and the render keep today's behaviour and messages; --validate additionally
  // prints validateWarnings(features, releases, dayOf(nowIso())) to stderr, one per line, exit unchanged.
  // The render path becomes: const r = renderAll({ outDir: args.out, prsPath: args.prs });
  //   if (r.errors.length) { console.error("render: registers fail validation, fix before rendering:"); … process.exit(1); }
  //   console.log(`wrote roadmap.html, tracker.html, deferred.html to ${args.out}`);
  // (loadRegisters' unreadable error → console.error(err.message); process.exit(1).)
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
```

`renderRoadmap(features, releases, now)`, `renderTracker(features, deferred, releases, prMap,
  bugStats, lag, day, now)` and `renderDeferred(deferred, features, now)` take `now` for their
footers (`Generated ${now.slice(0, 10)}` for the roadmap page, `Generated ${now}` for the other
two — same text as today, injected clock) and the tracker uses `lag.features`/`lag.deferred`
(ids → look up rows for the card text) and `day` for the `lag` card class.

### WP2 — `from-git.mjs`: trailer report and bounded `--apply`

- **files:** `scripts/roadmap/from-git.mjs` (new)
- **tests:** `scripts/roadmap/from-git.self-test.mjs` (new — TP2)
- **satisfies:** R6, R7, R8, R19 (`--help`)
- **provenBy:** T11, T12, T13, T14, T15, T16, T17, T36
- **dependsOn:** WP1 (imports `regDir`, `loadRegisters`, `validate` from `render.mjs`)
- **brief:** A read-only report by default; `--apply` is the one bounded write (working tree
  only, `prs[]` substring only, refuses on a dirty reg dir or invalid registers, never stages).
  Exit 0 always except an unusable git (exit 2, one stderr line `from-git: <reason>`) or a
  refused `--apply` (exit 1). Imports from `plane-client.mjs`: `gitEnv` only. No `gh`, no
  network, no `git commit`/`push`. Git root is derived from the reg dir
  (`git -C <regDir> rev-parse --show-toplevel`), so the fixture repo works and L-194 holds.
- **exact code:**

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gitEnv } from "../campaign/plane-client.mjs";
import { regDir, loadRegisters, validate } from "./render.mjs";

const USAGE = "Usage: from-git.mjs [--since <ref>] [--apply] [--help]";
const ID_RE = /^(F-\d+|B\d+|D-\d+)$/;
// The PR template's unfilled placeholders — dropped silently, never "unknown", never "tagged".
const PLACEHOLDERS = new Set(["F-", "B", "D-"]);
const KIND = { Feature: "F", Bug: "B", Defers: "D" };

export function parseTrailers(body) {
  const out = { features: [], bugs: [], defers: [], unknown: [] };
  const push = (arr, v) => {
    if (!arr.includes(v)) arr.push(v);
  };
  for (const m of String(body ?? "").matchAll(/^(Feature|Bug|Defers):[ \t]*(.*)$/gm)) {
    const bucket = m[1] === "Feature" ? out.features : m[1] === "Bug" ? out.bugs : out.defers;
    for (const tok of m[2].split(/[,\s]+/).filter(Boolean)) {
      if (PLACEHOLDERS.has(tok)) continue;
      if (!ID_RE.test(tok) || tok[0] !== KIND[m[1]]) {
        push(out.unknown, tok.slice(0, 20));
        continue;
      }
      push(bucket, tok);
    }
  }
  return out;
}

function git(args, cwd) {
  const r = spawnSync("git", ["-C", cwd, ...args], { env: gitEnv(), encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(
      `git ${args[0]} failed: ${String(r.stderr || "")
        .trim()
        .slice(0, 200)}`,
    );
  return r.stdout;
}
export const gitRootOf = (dir) => git(["rev-parse", "--show-toplevel"], dir).trim();
export function defaultSince(root) {
  const shas = git(
    ["log", "--diff-filter=A", "--format=%H", "--", ".claude/roadmap/README.md"],
    root,
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!shas.length)
    throw new Error("no commit adds .claude/roadmap/README.md — pass --since <ref>");
  return shas[shas.length - 1];
}
export function readCommits(root, since) {
  const raw = git(
    ["log", "--first-parent", "--reverse", "--format=%H%x00%s%x00%B%x1e", `${since}..HEAD`],
    root,
  );
  return raw
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim())
    .map((rec) => {
      const [sha, subject, body] = rec.split("\x00");
      const pr = /\(#(\d+)\)\s*$/.exec(subject);
      return {
        sha,
        sha7: sha.slice(0, 7),
        subject,
        body,
        pr: pr ? Number(pr[1]) : null,
        trailers: parseTrailers(body),
      };
    });
}

export function buildReport({ commits, features, since7 }) {
  const rows = new Map(features.map((f) => [f.id, f]));
  const proposals = new Map(); // featureId -> [{pr, sha7, subject}]
  const unknown = [];
  const seen = [];
  const untagged = [];
  let tagged = 0;
  for (const c of commits) {
    const t = c.trailers;
    if (t.features.length + t.bugs.length + t.defers.length > 0) tagged++;
    else untagged.push(c);
    for (const id of t.features) {
      const row = rows.get(id);
      if (!row) {
        unknown.push({ id, c });
        continue;
      }
      if (c.pr && !(row.prs ?? []).includes(c.pr)) {
        const list = proposals.get(id) ?? [];
        if (!list.some((p) => p.pr === c.pr))
          list.push({ pr: c.pr, sha7: c.sha7, subject: c.subject });
        proposals.set(id, list);
      }
    }
    for (const b of t.bugs) seen.push({ id: `Bug: ${b}`, c });
    for (const d of t.defers) seen.push({ id: `Defers: ${d}`, c });
    for (const u of t.unknown) unknown.push({ id: u, c });
  }
  const pct = commits.length ? Math.round((tagged / commits.length) * 100) : 0;
  const lines = ["Proposed prs[] appends"];
  if (!proposals.size) lines.push("  none");
  for (const [id, list] of [...proposals].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const p of list.sort((a, b) => a.pr - b.pr))
      lines.push(`  ${id}: #${p.pr}  ${p.sha7}  ${p.subject}`);
  }
  lines.push("Unknown ids");
  if (!unknown.length) lines.push("  none");
  for (const u of unknown) lines.push(`  ${u.id}  ${u.c.sha7}  ${u.c.subject}`);
  lines.push("Bug/Defers trailers seen");
  if (!seen.length) lines.push("  none");
  for (const s of seen) lines.push(`  ${s.id}  ${s.c.sha7}  ${s.c.subject}`);
  lines.push(
    "Coverage",
    `  ${tagged} of ${commits.length} commits since ${since7} carry a roadmap trailer (${pct}%)`,
    "  untagged:",
  );
  for (const c of untagged.slice(0, 20)) lines.push(`    ${c.sha7}  ${c.subject}`);
  if (untagged.length > 20) lines.push(`    +${untagged.length - 20} more`);
  return { lines, proposals };
}

// Rewrites ONLY the `"prs":[…]` substring of a proposed row; every other byte of every line is kept.
export function applyPrs({ dir, proposals }) {
  const path = join(dir, "features.jsonl");
  const lines = readFileSync(path, "utf8").split("\n");
  const changed = [];
  const manual = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const list = proposals.get(row.id);
    if (!list) continue;
    const m = /"prs":\[([^\]]*)\]/.exec(line);
    if (!m) {
      manual.push(row.id);
      continue;
    }
    const have = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    const merged = [...new Set([...have, ...list.map((p) => p.pr)])].sort((a, b) => a - b);
    const next = `${line.slice(0, m.index)}"prs":[${merged.join(",")}]${line.slice(m.index + m[0].length)}`;
    if (next !== line) {
      lines[i] = next;
      changed.push(row.id);
    }
  }
  if (changed.length) writeFileSync(path, lines.join("\n"), "utf8");
  return { changed, manual };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  let since = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") since = argv[++i];
    else if (argv[i] === "--apply") apply = true;
    else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const dir = regDir();
  let root, commits, since7;
  try {
    root = gitRootOf(dir);
    const sinceSha = since ?? defaultSince(root);
    since7 = git(["rev-parse", "--short=7", sinceSha], root).trim();
    commits = readCommits(root, sinceSha);
  } catch (err) {
    process.stderr.write(`from-git: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const regs = loadRegisters(dir);
  const { lines, proposals } = buildReport({ commits, features: regs.features, since7 });
  process.stdout.write(lines.join("\n") + "\n");
  if (!apply) {
    process.exitCode = 0;
    return;
  }
  if (validate(regs.features, regs.deferred, regs.releases).length) {
    process.stderr.write("from-git: refusing --apply — registers fail validation\n");
    process.exitCode = 1;
    return;
  }
  if (git(["status", "--porcelain", "--", dir], root).trim()) {
    process.stderr.write("from-git: refusing --apply — .claude/roadmap has uncommitted changes\n");
    process.exitCode = 1;
    return;
  }
  if (!proposals.size) {
    process.stdout.write("--apply: nothing to write\n");
    process.exitCode = 0;
    return;
  }
  const { changed, manual } = applyPrs({ dir, proposals });
  process.stdout.write(git(["diff", "--stat", "--", dir], root));
  for (const id of changed)
    process.stdout.write(
      `--apply: ${id} prs[] updated (working tree only — commit it in your bookkeeping PR)\n`,
    );
  for (const id of manual)
    process.stdout.write(`--apply: ${id} has no "prs" key — add it by hand\n`);
  process.exitCode = 0;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
```

### WP3 — `publish.mjs`: probe, publish (Pages or ROAD fallback), composite; fake-server seeds

- **files:** `scripts/roadmap/publish.mjs` (new), `scripts/campaign/plane-fake-server.mjs`
  (additive only: `seed.pages`, `seed.failWrite`), `scripts/campaign/plane-client.mjs`
  (additive only: `createClient({ minWriteIntervalMs, retryBackoffMs })`, both optional, both
  defaulting to the current real constants — F-2 ruling, see the header note)
- **tests:** `scripts/roadmap/publish.self-test.mjs` (new — TP3)
- **satisfies:** R10, R11, R12, R13, R14, R19 (`--help`)
- **provenBy:** T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28, T36
- **dependsOn:** WP1 (imports `renderAll`, `regDir`, `registersHash`, `nowIso`, `dayOf`,
  `defaultOutDir`, `writeAtomic`, `ROOT`)
- **brief:** Order of operations in `main()` (every mode): parse flags (`--help`/`-h` → exit 0;
  unknown → exit 2 `Usage:`; before any env read) → set up the `appendRun` record and a
  `finally` that writes exactly one `runs.jsonl` line → **render** (`renderAll`; invalid →
  `Roadmap publish: registers fail validation (N problems) → node scripts/roadmap/render.mjs --validate`,
  publish exit 1) → **denylist** (`scanForbidden` over each HTML file and each title, default
  patterns; a hit → `Roadmap publish: refused — <file> matches denylist pattern "<name>"`, exit
  1, no client created) → **key** (absent → `Roadmap publish: skipped (no PLANE_API_KEY)`, publish
  exit 0) → **fresh check** (`.published.json` hash = current AND day = today AND no `--force`
  → `Roadmap publish: fresh, nothing to do`, zero requests) → **client** (`createClient({ apiKey,
tool: "roadmap-publish", maxWrites: 3 })`) → `resolveProject("ROAD")` → **verdict**
  (`--probe`, or no `plane-pages-probe.json` yet → run `probe()`, write the file; else reuse the
  file's verdict; `--probe` prints the `PASS`/`WARN` line and stops) → if every probe status is
  401/403 → `Roadmap publish: unauthorized (HTTP <status>)`, exit 1 → **existing** (`findExisting`
  by exact title on the list path) → **plan** (`buildPublishPlan`) → `--dry-run` prints
  `Roadmap publish: dry-run — target: <verdict> (<path>)`, then `  <file>: <bytes> bytes` ×3, then
  `  would POST|PATCH <key>` ×3, and stops (no writes, no stamp, no chain) → **writes** in plan
  order via `client.post`/`client.patch` (`{ ref: "roadmap:<key>", reason: "roadmap publish" }`),
  collecting `refs[key] = res.id ?? existing[key]`; a thrown error or a `{forbidden}`/`{deferred}`
  result → `Roadmap publish: failed on <key> (HTTP <status> | <message>)`, exit 1, **no stamp**
  → **stamp** `.published.json` `{ publishedAt: now, day, registersHash, target: verdict, refs }`
  and `Roadmap publish: published 3 pages (target <verdict>)` → **chain** (skipped for `--probe`,
  `--dry-run`, help/usage): spawn `<campaignDir>/plane-sync.mjs --if-digest-changed`, print
  `Roadmap step plane-sync: exit <n>`; spawn `<campaignDir>/plane-triage.mjs --brief`, print
  `Roadmap step plane-triage: exit <n>`; read `<outDir>/lag.json` and print
  `Roadmap lag: <n> features past target · <m> deferred past revisitBy (lag.json)` → composite
  exit = `publishExit !== 0 || syncExit !== 0 ? 1 : 0`. The chain runs even when publish
  skipped/failed (R14: later read-only steps are never skipped). Writes per run ≤ 3 by
  construction (plan length 3) and by the client's `maxWrites: 3`.
- **exact code (publish.mjs, the parts that must not be improvised):**

```js
#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  createClient,
  scanForbidden,
  loadDenylist,
  appendRun,
  gitEnv,
} from "../campaign/plane-client.mjs";
import {
  ROOT,
  renderAll,
  regDir,
  registersHash,
  nowIso,
  dayOf,
  defaultOutDir,
  writeAtomic,
} from "./render.mjs";

const USAGE = "Usage: publish.mjs [--probe] [--dry-run] [--force] [--out <dir>] [--help]";
const SELF_TEST = process.env.ROADMAP_SELF_TEST === "1";
export const PAGE_ORDER = ["roadmap", "tracker", "deferred"];
export const PAGE_TITLES = {
  roadmap: "Roadmap · public view",
  tracker: "Roadmap · tracker",
  deferred: "Roadmap · deferred register",
};
export const MAX_BODY_BYTES = 200_000;
export const ROAD_IDENTIFIER = "ROAD"; // D-A8: if ROAD does not resolve, this constant moves to OPS
export const probePaths = (roadId) => ["pages/", `projects/${roadId}/pages/`];

function campaignDir() {
  return SELF_TEST && process.env.ROADMAP_CAMPAIGN_DIR
    ? process.env.ROADMAP_CAMPAIGN_DIR
    : join(ROOT, "scripts", "campaign");
}

export function truncateBody(html, max = MAX_BODY_BYTES) {
  if (Buffer.byteLength(html, "utf8") <= max) return html;
  const cut = Buffer.from(html, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "");
  return `${cut}<p>… truncated, see the repo render</p>`;
}

// results: [{ path, status, body }] — `pages` only on a 2xx list envelope or bare array; prefer the project path.
export function probeVerdict(results) {
  const isList = (b) =>
    Array.isArray(b) || (b !== null && typeof b === "object" && Array.isArray(b.results));
  const ok = results.filter((r) => r.status >= 200 && r.status < 300 && isList(r.body));
  if (!ok.length) return { verdict: "road-item", pagesPath: null };
  const preferred = ok.find((r) => r.path.startsWith("projects/")) ?? ok[0];
  return { verdict: "pages", pagesPath: preferred.path };
}

// The shared client has no status-returning GET: a 2xx resolves (recorded as 200), a non-2xx
// throws `GET <path> -> HTTP <status>…` (parsed here), a network failure has no status (0).
async function probe(client, roadId) {
  const results = [];
  for (const path of probePaths(roadId)) {
    try {
      const body = await client.get(path);
      results.push({
        path,
        status: 200,
        body,
        topLevelKeys:
          body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [],
      });
    } catch (err) {
      const m = /-> HTTP (\d{3})/.exec(String(err?.message ?? ""));
      results.push({ path, status: m ? Number(m[1]) : 0, body: null, topLevelKeys: [] });
    }
  }
  return results;
}

async function findExisting(client, listPath) {
  const items = await client.listAll(listPath);
  const byTitle = new Map(items.map((it) => [it.name, it.id]));
  const existing = {};
  for (const key of PAGE_ORDER)
    if (byTitle.has(PAGE_TITLES[key])) existing[key] = byTitle.get(PAGE_TITLES[key]);
  return existing;
}

// pages: [{ key, title, html }] in PAGE_ORDER; existing: { [key]: id }
export function buildPublishPlan({ verdict, pagesPath, roadProjectId, existing = {}, pages }) {
  const base = verdict === "pages" ? pagesPath : `projects/${roadProjectId}/work-items/`;
  return PAGE_ORDER.map((key) => {
    const p = pages.find((x) => x.key === key);
    const body = { name: p.title, description_html: truncateBody(p.html) };
    const id = existing[key];
    return id
      ? { method: "PATCH", path: `${base}${id}/`, body, ref: key }
      : { method: "POST", path: base, body, ref: key };
  });
}

function runStep(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(campaignDir(), name), ...args], {
      env: gitEnv(),
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function readProbeFile(outDir) {
  const p = join(outDir, "plane-pages-probe.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function readStamp(outDir) {
  const p = join(outDir, ".published.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
```

The `main()` follows the brief's order literally; probe output line:
`Roadmap probe: ${verdict === "pages" ? "PASS" : "WARN"} — verdict ${verdict} (${results.map((r) => `${r.path} ${r.status}`).join(", ")})`;
probe file: `{ probedAt: now, results: results.map(({path,status,topLevelKeys}) => ({path,status,topLevelKeys})), verdict, pagesPath }`.
The `runs.jsonl` record: `{ tool: "roadmap-publish", flags: argv, branch, exit, steps: { publish, sync, triage },
  writes: client?.writes ?? 0, registersHash, target, skipped? }` (probe-only: `{ tool, flags, branch, exit, probe: verdict }`).
`branch` = `git rev-parse --abbrev-ref HEAD` under `gitEnv()`, tolerated to fail (`null`).

- **exact code (plane-fake-server.mjs additions — additive; existing routes and defaults unchanged):**

```js
// seed.pages: undefined → no pages route (existing 404, the "Pages not exposed" probe case)
//             "list"    → GET pages/ and GET projects/<id>/pages/ return the {results,…} envelope; POST creates; PATCH updates
//             405       → both GETs return 405
// seed.failWrite: { at: <1-based ordinal of a write request (POST/PATCH on pages or work-items)>, times: <n> }
//             → that write and the next (times−1) write requests return 500 (the client retries 5xx 3×, so times: 4
//               makes ONE logical write fail through all its retries).
const pagesMode = seed.pages;
const wsPages = [];
const projectPages = {};
for (const p of projects) projectPages[p.identifier] = [];
let nextPageId = 1;
let writeOrdinal = 0;
const failWrite = seed.failWrite ?? null;
// inside the request handler, after `send`/`notFound` are defined:
const injectedFailure = () => {
  writeOrdinal++;
  if (failWrite && writeOrdinal >= failWrite.at && writeOrdinal < failWrite.at + failWrite.times) {
    send(500, { error: "fake Plane server: injected write failure" });
    return true;
  }
  return false;
};
const pagesRoute = (store, rest) => {
  if (pagesMode === 405) return send(405, { error: "method not allowed" });
  if (pagesMode !== "list") return notFound();
  if (rest.length === 0) {
    if (req.method === "GET") return send(200, listPayload(store, query));
    if (req.method === "POST") {
      if (injectedFailure()) return;
      const created = { id: uuidIds ? nextUuid() : `page-${nextPageId++}`, ...body };
      store.push(created);
      return send(201, created);
    }
    return notFound();
  }
  if (rest.length === 1 && req.method === "PATCH") {
    const idx = store.findIndex((p) => p.id === rest[0]);
    if (idx === -1) return notFound();
    if (injectedFailure()) return;
    store[idx] = { ...store[idx], ...body };
    return send(200, store[idx]);
  }
  return notFound();
};
// workspace-level: place BEFORE `if (tail[0] !== "projects" || tail.length < 2) return notFound();`
if (tail[0] === "pages") return pagesRoute(wsPages, tail.slice(1));
// project-level: place in the `rest` section BEFORE `if (rest[0] !== "work-items") return notFound();`
if (rest[0] === "pages") return pagesRoute(projectPages[identifier], rest.slice(1));
// and add `if (injectedFailure()) return;` as the first line of the existing POST work-items/ and
// PATCH work-items/<id>/ branches (after the existing `failFirstCreate` 429 check).
```

Expose `pages: { ws: wsPages, byProject: projectPages }` on the returned `state`. Run
`node scripts/campaign/plane-sync.self-test.mjs` and `plane-triage.self-test.mjs` after the
edit — they must stay green (perRound covers triage; final covers sync).

### WP4 — wiring and docs: `verify` gate, scripts, SessionStart element, post-merge hook, PR template, README

- **files:** `package.json`, `.claude/settings.json`, `.husky/post-merge` (new),
  `.github/PULL_REQUEST_TEMPLATE.md`, `.claude/roadmap/README.md`
- **tests:** `scripts/roadmap/roadmap-docs.self-test.mjs` (new — TP4)
- **satisfies:** R1, R4, R9, R15 (install/rollback lines; the install itself is manual), R16,
  R18, R19
- **provenBy:** T29, T30, T31, T32, T33, T34 (manual), T35 (manual), T36
- **dependsOn:** WP1, WP2, WP3 (the `verify` chain names their self-tests, which must exist and
  be green before `verify` changes; the README documents the flags they ship)
- **brief and exact edits:**

  1. `package.json` `scripts` — add (alphabetical near the `plane:*` block):

```json
"roadmap:validate": "node scripts/roadmap/render.mjs --validate",
"roadmap:render": "node scripts/roadmap/render.mjs",
"roadmap:status": "node scripts/roadmap/render.mjs --status",
"roadmap:from-git": "node scripts/roadmap/from-git.mjs",
"roadmap:publish": "node scripts/roadmap/publish.mjs",
```

and in `scripts.verify`, immediately after `node scripts/campaign/plane-doctor.self-test.mjs`
and before `node scripts/validate-lessons.digest.self-test.mjs`, insert:

```
 && node scripts/roadmap/render.mjs --validate && node scripts/roadmap/render.self-test.mjs && node scripts/roadmap/from-git.self-test.mjs && node scripts/roadmap/publish.self-test.mjs && node scripts/roadmap/roadmap-docs.self-test.mjs
```

Nothing else in `verify` moves. `verify` must contain neither `publish.mjs` nor
`roadmap:publish` (T29).

2. `.claude/settings.json` — `hooks.SessionStart` becomes exactly:

```json
"SessionStart": [
  {
    "hooks": [
      { "type": "command", "command": "node scripts/campaign/plane-triage.mjs --brief" }
    ]
  },
  {
    "hooks": [{ "type": "command", "command": "node scripts/roadmap/render.mjs --status" }]
  }
],
```

`permissions`, `PostToolUse`, `Stop` untouched (Landmine 15).

3. `.husky/post-merge` (new) — exact content (no shebang; husky's `_/h` runs it with `sh -e`):

```sh
# F-22 (spec R16): refresh the local roadmap render after a merge/pull so the next session's
# status line is already fresh. Never publishes, never touches the network, never fails a merge.
# Worktrees without husky hooks skip this by design — the PC's hourly `npm run roadmap:publish`
# is the backstop (see .claude/roadmap/README.md).
node scripts/roadmap/render.mjs || true
node scripts/roadmap/render.mjs --status || true
```

4. `.github/PULL_REQUEST_TEMPLATE.md` — insert after the `## Changes` block, before
   `## Checklist`:

```md
## Roadmap trailers

<!-- Keep the lines that apply and fill the id; delete the rest. Read by
     `node scripts/roadmap/from-git.mjs` — convention in .claude/roadmap/README.md. -->

Feature: F-
Bug: B
Defers: D-
```

5. `.claude/roadmap/README.md` — append a section `## Tracking engine (F-22)` that documents,
   in this order and using these exact tokens (T33 greps them): `npm run roadmap:validate` (the
   `verify` gate; `warn:` lines are report-only); `node scripts/roadmap/render.mjs --status` (the
   SessionStart block; the four lines; the **stale rule**: STALE iff any HTML file or the stamp
   is missing, or the stamp's `registersHash` ≠ the sha256 of the three register files in order,
   or the stamp's `day` ≠ today UTC — `.rendered.json` for the render, `.published.json` for the
   publish); `lag.json`; `from-git.mjs` (report by default; `--since <ref>`; `--apply` appends
   only `prs[]` in the working tree, refuses on a dirty `.claude/roadmap` or invalid registers,
   never commits — undo with `git checkout -- .claude/roadmap`); `publish.mjs` (`--probe` writes
   `plane-pages-probe.json`; `--dry-run`; `--force`; `--out`); `npm run roadmap:publish` (the
   composite: publish → `plane-sync.mjs --if-digest-changed` → `plane-triage.mjs --brief` → lag
   line; exit 1 iff publish or sync failed; one `roadmap-publish` line in `runs.jsonl`); the
   **one publisher machine** policy (the PC; any other machine may run it by hand with a key);
   the hourly job — install line: "On the PC, create the machine-local scheduled task
   `routeflow-roadmap-hourly` (the same `~/.claude/scheduled-tasks/` mechanism as
   `routeflow-plane-daily`) running `npm run roadmap:publish` from the main checkout every hour;
   it is **not a repo file** and is **not reverted by git** — delete it by hand to roll back";
   the `post-merge` hook (render + status only; skipped in a worktree without husky hooks; the
   hourly job is the backstop); the Plane targets (Pages when the probe verdict is `pages`, else
   three pinned ROAD work items titled `Roadmap · public view` / `Roadmap · tracker` /
   `Roadmap · deferred register`, updated in place; no tool ever deletes them). Reformat the
   README with prettier (not clean today) and note it in `report.md`. **Do not touch
   `.claude/skills/plane/SKILL.md`.**

### Package map

| WP  | satisfies                      | provenBy                                                   | dependsOn     | Wave |
| --- | ------------------------------ | ---------------------------------------------------------- | ------------- | ---- |
| WP1 | R2, R3, R5, R17, R19           | T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T36               | —             | 1    |
| WP2 | R6, R7, R8, R19                | T11, T12, T13, T14, T15, T16, T17, T36                     | WP1           | 2    |
| WP3 | R10, R11, R12, R13, R14, R19   | T18, T19, T20, T21, T22, T23, T24, T25, T26, T27, T28, T36 | WP1           | 2    |
| WP4 | R1, R4, R9, R15, R16, R18, R19 | T29, T30, T31, T32, T33, T34, T35, T36                     | WP1, WP2, WP3 | 3    |

Cross-check: R1 WP4 · R2 WP1 · R3 WP1 · R4 WP4 · R5 WP1 · R6 WP2 · R7 WP2 · R8 WP2 (and
proven again on WP3 by T28) · R9 WP4 (static proof; the behaviour is WP1/WP2's absence of
network code, proven by T9/T16) · R10–R14 WP3 · R15 WP4 · R16 WP4 · R17 WP1 · R18 WP4 · R19 all
four. Every T1–T36 appears in exactly one package's `provenBy`. Nothing deliberately out of
scope among R1–R19.

---

## Acceptance criteria

1. `R1` — `npm run verify` contains `node scripts/roadmap/render.mjs --validate` and exits
   non-zero on each of the five defect classes (T1); on the current registers it stays green
   (A14: `roadmap validate: OK — 22 features, 26 deferred, 4 releases.` on 2026-09-24).
2. `R2` — a render writes `lag.json` and `.rendered.json` atomically beside the HTML; the LAG
   ids in `lag.json`, `tracker.html` and the status line agree for the same registers and day;
   two renders with a pinned clock are byte-identical; invalid registers change no file.
3. `R3` — `render.mjs --status` prints ≤ 5 lines, ≤ 768 bytes, every line starting `Roadmap`,
   with the exact stale/fresh wording and fix commands of test-plan §2.1 T4.
4. `R4` — `.claude/settings.json` `hooks.SessionStart` has exactly two elements: the untouched
   triage element first, `node scripts/roadmap/render.mjs --status` second; `PostToolUse`/`Stop`
   intact.
5. `R5` — `--status` exits 0 for invalid, unreadable, never-rendered and internally-failing
   cases, and runs < 300 ms in-process on the real registers.
6. `R6` — `from-git.mjs` prints the four sections exactly as test-plan §2.1 T12 over fixture
   repo G; bad ref / not a repo → exit 2; never `gh`, never network.
7. `R7` — `--apply` changes only `"prs":[…]` substrings, never stages or commits, refuses on
   a dirty reg dir or invalid registers, and is a no-op the second time.
8. `R8` (negative) — after every command, the registers with `prs[]` blanked are byte-identical
   to before; no script source contains `git commit`, `git push` or `gh` outside comments.
9. `R9` (negative) — `verify`, the SessionStart element, the post-merge hook, `--status` and
   `from-git.mjs` make no network call: static greps pass (T29, T31) and both CLIs complete
   under a throwing `fetch` stub (T9, T16).
10. `R10` — `publish.mjs --probe` writes `plane-pages-probe.json` with two GET results and a
    verdict, prints `PASS`/`WARN`, exits 0, adds no ledger line; on the fake: 200-list → `pages`,
    404/405 → `road-item`.
11. `R11` — first publish creates three pages/items (≤ 3 writes, titles in order), later runs
    `PATCH` the same refs found by title, a fresh stamp means zero requests, `--dry-run` writes
    nothing, a mid-run failure leaves no stamp and exits 1 naming the page, the next run recovers.
12. `R12` (negative) — a denylisted byte in any rendered file → exit 1 before any request,
    pattern name printed, matched text never printed, no stamp.
13. `R13` — without `PLANE_API_KEY`: local render happens, `Roadmap publish: skipped (no
PLANE_API_KEY)`, exit 0; `--help` exits 0 and `--bogus` exits 2 before any env read.
14. `R14` — the composite runs sync then triage after publish (even after a failed publish),
    prints one `Roadmap step <name>: exit <n>` per step and the lag line, exits 1 iff publish or
    sync failed, and appends exactly one `roadmap-publish` line to `runs.jsonl`.
15. `R15`/`R16`/`R18`/`R19` — the README carries the install/rollback/one-publisher/worktree
    lines; `.husky/post-merge` has the two commands with `|| true` and nothing else executable;
    the PR template carries the three trailer lines; every new command answers `--help`;
    `.claude/skills/plane/SKILL.md` is byte-identical to `HEAD`.
16. Deploy day — a machine that has never rendered prints `render: never rendered on this
machine …` and `publish: no PLANE_API_KEY …` (or `never published …`) and nothing blocks;
    existing renders without a stamp print `STALE — no stamp` once.

---

## Verification commands

Every command below exists today and passes on the untouched tree (checked 2026-09-24), except
the `final` roadmap chain, whose files this plan creates.

Per round (cheap; after every implementation round):

```bash
node scripts/roadmap/render.mjs --validate                       # the gate itself, on the real registers (0.1 s)
node scripts/campaign/plane-docs.self-test.mjs                    # settings.json/verify/SKILL.md shape guards (0.07 s)
node scripts/campaign/plane-triage.self-test.mjs                  # F-09 consumer of the fake server — WP3's seeds must not break it (1 s)
npx prettier --check package.json .claude/settings.json .github/PULL_REQUEST_TEMPLATE.md scripts/campaign/plane-fake-server.mjs   # only files that are clean today
```

Final (once, at the end; `lean` profile does not run it in-engine — the human runs it, then the
husky pre-push runs the full `npm run verify`, measured on the dev host per L-182):

```bash
node scripts/roadmap/render.mjs --validate && node scripts/roadmap/render.self-test.mjs && node scripts/roadmap/from-git.self-test.mjs && node scripts/roadmap/publish.self-test.mjs && node scripts/roadmap/roadmap-docs.self-test.mjs
node scripts/campaign/plane-sync.self-test.mjs                    # the other fake-server consumer (slow, so not perRound)
node scripts/campaign/plane-docs.self-test.mjs
npm run plane:doctor -- --offline
npm run verify                                                    # the whole pre-push chain, once, timed
```

Not in any gate (network): `ROADMAP_LIVE_PROBE=1 PLANE_API_KEY=… node scripts/roadmap/publish.self-test.mjs`
on the PC — the one manual step (T20/T24), recorded in the PR body.

---

## UI verification

n/a — no UI surface.

---

## Risks & rollback

| Risk                                                                                 | Likelihood | Blast radius                                   | Mitigation / what the reviewer should watch                                                                                                                 |
| ------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plane's real Pages payload differs from the pinned `{name, description_html}` (D-A1) | med        | a failed first live publish; nothing else      | `buildPublishPlan` is one function; the ROAD-item fallback uses the shape `plane-sync.mjs` already proves live; T20/T24 on the PC before the first real run |
| The SessionStart block hides behind a triage failure (D-A5)                          | low        | a missing status line                          | exit-0/no-network contract (T6, T9); owner checks the first session after merge                                                                             |
| `render.mjs` guard/reformat breaks today's `--validate` text                         | low        | `verify` red                                   | T1 characterizes the strings; perRound runs `--validate` on the real registers                                                                              |
| Fake-server seeds regress F-09 self-tests                                            | low        | `verify` red                                   | seeds are additive and default-off; perRound runs the triage self-test, final runs sync's                                                                   |
| Self-test wall-clock bloats the pre-push (L-182)                                     | med        | every local push slower                        | T36 budgets; the merge session measures `npm run verify` on the dev host; publish self-test floor ~4 s is stated (F-2)                                      |
| A rendered byte matches a denylist pattern and blocks every publish                  | low        | publish refused until a register row is edited | pattern name in the message; registers are client-free by policy                                                                                            |
| `--apply` rewrite corrupts a row                                                     | low        | one JSONL line in the working tree             | substring-only rewrite (T14 byte comparison); `git checkout -- .claude/roadmap` undoes it                                                                   |

- **Rollback:** revert the PR (all files are in one diff; nothing in app code depends on them).
  Kill switches without a revert: remove the second `hooks.SessionStart` element; delete
  `.husky/post-merge`; delete the machine-local task on the PC (not reverted by git — README
  says so). Plane pages/items created by publish stay; delete by hand if wanted (no tool
  deletes; creation is in `.plane-writes.jsonl`).
- **Migration reversibility:** none — no schema, no DB.
- **Feature flag / entitlement:** none; `PLANE_API_KEY` presence selects skip-vs-publish and
  denies nothing.
- **Deploy day:** every session prints the new block after its next pull; first state on each
  machine is `never rendered` / `never published` (or `no PLANE_API_KEY`) — intended. Registers
  need no change (A14). Optional once-only backfill: `npm run roadmap:from-git` read into the next
  bookkeeping PR. The owner installs the PC task (R15) after merge; until then publishing is
  manual from any machine with a key.
- **Observability:** at 2 am — `local-assets/plane/runs.jsonl` `roadmap-publish` lines with
  `exit ≠ 0` and the error text; `.published.json` stops advancing; the next session's
  `Roadmap publish: STALE … last published <when>` line; `npm run verify` red on the gate.

---

## Pipeline args

_Not launched on this machine (plan only; no `PLANE_API_KEY` here). Ready to copy when the lead
approves. `startedAt` is taken at launch. Each `tests[]` entry is a standalone self-test run as
`node <path>` (the repo convention); in the `lean` profile the task's implementer writes it first
(RED pasted into `report.md`) and then the implementation (GREEN)._

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-24-f22-tracking-engine/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-24-f22-tracking-engine/test-plan.md',
  discoveryPath: '.claude/pipeline/2026-09-24-f22-tracking-engine/discovery.md',
  specPath: '.claude/pipeline/2026-09-24-f22-tracking-engine/spec.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '<ISO timestamp taken at launch>',
  runDir: '.claude/pipeline/2026-09-24-f22-tracking-engine',

  scale: 'major',      // full artifact set, 13 files, a new feature — not the ten-line preamble mode
  mode: 'feature',
  profile: 'lean',     // explicit: every file is LOW risk (tooling; no money/auth/tenancy/PII), so
                       // `standard`'s extras (separate test author, Opus reviewer on HIGH-risk, probes)
                       // buy nothing here; the four self-tests are the oracle and run in `verify`.
  context: 'F-22 tracking engine: verify gate, render stamps + lag.json + --status, from-git trailer report, Plane publish (pages|road-item) + hourly composite, hook/template/README wiring',
  baselineSha: '<sha of master at launch>',

  tasks: [
    {
      id: 'WP1', title: 'render.mjs: guard, seams, stamps, lag.json, --status, warnings, --help',
      type: 'feature',
      files: ['scripts/roadmap/render.mjs'],
      tests: ['scripts/roadmap/render.self-test.mjs'],
      dependsOn: [],
    },
    {
      id: 'WP2', title: 'from-git.mjs: trailer report and bounded --apply',
      type: 'feature',
      files: ['scripts/roadmap/from-git.mjs'],
      tests: ['scripts/roadmap/from-git.self-test.mjs'],
      dependsOn: ['WP1'],
    },
    {
      id: 'WP3', title: 'publish.mjs: probe, publish (pages|road-item), composite; fake-server seeds',
      type: 'feature',
      files: ['scripts/roadmap/publish.mjs', 'scripts/campaign/plane-fake-server.mjs'],
      tests: ['scripts/roadmap/publish.self-test.mjs'],
      dependsOn: ['WP1'],
    },
    {
      id: 'WP4', title: 'wiring and docs: verify gate, npm scripts, SessionStart element, post-merge hook, PR template, README',
      type: 'feature',
      files: ['package.json', '.claude/settings.json', '.husky/post-merge', '.github/PULL_REQUEST_TEMPLATE.md', '.claude/roadmap/README.md'],
      tests: ['scripts/roadmap/roadmap-docs.self-test.mjs'],
      dependsOn: ['WP1', 'WP2', 'WP3'],
    },
  ],

  verifyCommands: {
    perRound: [
      'node scripts/roadmap/render.mjs --validate',
      'node scripts/campaign/plane-docs.self-test.mjs',
      'node scripts/campaign/plane-triage.self-test.mjs',
      'npx prettier --check package.json .claude/settings.json .github/PULL_REQUEST_TEMPLATE.md scripts/campaign/plane-fake-server.mjs',
    ],
    final: [
      'node scripts/roadmap/render.mjs --validate && node scripts/roadmap/render.self-test.mjs && node scripts/roadmap/from-git.self-test.mjs && node scripts/roadmap/publish.self-test.mjs && node scripts/roadmap/roadmap-docs.self-test.mjs',
      'node scripts/campaign/plane-sync.self-test.mjs',
      'node scripts/campaign/plane-docs.self-test.mjs',
      'npm run plane:doctor -- --offline',
    ],
  },

  // formatCommand deliberately OMITTED: `npm run format` is a repo-wide glob that would reformat
  // files a task does not own (and does not cover .mjs). Each task's brief says: run
  // `npx prettier --write <only the files you own>` before reporting; .lintstagedrc.json formats
  // *.mjs at commit anyway.
}
```
