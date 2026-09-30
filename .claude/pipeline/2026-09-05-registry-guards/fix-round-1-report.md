# Fix-round 1 report — registry guards (Sonnet fixer)

Scope: `scripts/campaign/bugs.mjs`, `.claude/code-map/INDEX.md`, `.claude/pipeline/2026-09-05-registry-guards/test-plan.md`. Implemented every ruling row marked **FIX** (F1, F2, F4, F5, F7, F8, F9, F10), the DROP note for F7, and explicitly did NOT touch F6 (close-out only) or F3's code (DEFER — only the shared doc-line addition, which F1 also calls for).

## F1 — `sync --check` vacuity (major)

Two edits, exactly as specified.

**(a) Success line + usage header, in `cmds.sync`:**

```diff
-//     --check: read-only; exits 1 naming records whose front matter lags the ledger (the pre-push self-test runs it on the real tree)
+//     --check: read-only; exits 1 naming records whose front matter lags the ledger (front matter only; the commit scan is out of scope) (the pre-push self-test runs it on the real tree)
...
     if (stale.length)
       fail(`sync --check: ${stale.length} record(s) out of date — run sync: ${stale.join(", ")}`);
-    console.log("sync --check: records mirror the ledger");
+    console.log(`sync --check: ${catalogue.length} record(s) mirror the ledger`);
     return;
```

**(b) `runCli` cwd fix** (real-tree run must not depend on invoker's cwd):

```diff
       out: execSync(`node ${cmd} 2>&1`, {
         encoding: "utf8",
         env: { ...process.env, BUGS_ROOT: root, BUGS_SELF_TEST: "1" },
         stdio: ["ignore", "pipe", "pipe"],
+        // A real-tree run (`root` undefined — T13b, the pre-push guard) must
+        // not depend on the INVOKER's cwd: `rootDir()` resolves `.claude/campaign`
+        // relative to `process.cwd()`, so a caller running from any other
+        // directory (`apps/api`, say) silently sees an empty catalogue and
+        // `--check` reports clean having examined zero real records. A fixture
+        // run (`root` given) keeps the inherited cwd — irrelevant there since
+        // BUGS_ROOT already points every path helper at the tmp fixture.
+        ...(root === undefined ? { cwd: REPO_ROOT } : {}),
       }),
```

T13's two "mirrors" assertions changed to `/\d+ record\(s\) mirror the ledger/.test(out)` (both the "clean" check and the "reconciled" check). T13b's check object became `{ code: 0, mirrors: true, examined: true, ranASync: false }`, with `mirrors` also switched to the same regex (the old literal substring `"records mirror the ledger"` no longer appears now the message carries a count) and a new `examined: Number((real.out.match(/(\d+) record\(s\) mirror/) || [])[1]) >= 1` field.

Checked `.claude/skills/bug-registry/SKILL.md`'s `sync --check` paragraph (line 265: `npm run bugs -- sync --check   # read-only: exits 1 naming records whose front matter lags the ledger`) — it does **not** quote the old success message verbatim, so no SKILL.md edit was needed (ruling's own "it does not appear to — verify" confirmed true).

## F2 — triage path silently discarded `--why` (major)

```diff
-        const body = appendEvent(rec.body, `batch-${to}`, "batched", `assigned to ${to}`);
+        const body = appendEvent(
+          rec.body,
+          `batch-${to}`,
+          "batched",
+          `assigned to ${to}${why ? ` — ${why}` : ""}`,
+        );
...
-      console.log(`move: ${id} -> ${to} (first ledger row, tier ${tier})`);
+      console.log(`move: ${id} -> ${to} (first ledger row, tier ${tier})${why ? ` (${why})` : ""}`);
```

Detail-text separator (`—`) mirrors the re-home path's `appendEvent` call exactly; the console-line suffix (` (${why})`) mirrors the re-home path's `console.log` formatting exactly.

T14's triage `runCli` call extended with `"--why", "triage reason"`; added one `check()` asserting `show B1`'s History has a line containing both `batched` and `triage reason`.

## F4 — no rollback on a late triage failure (minor)

Mirrored `cmds.file`'s shape (`bugs.mjs:440-466` pre-fix-round numbering) around the catalogue write, record write, and final read-back:

```diff
-      const rows = readCatalogue();
-      const cat = rows.find((r) => r.id === id);
-      if (cat) {
-        cat.batch = to;
-        writeCatalogue(rows);
-      }
-
-      const rec = readRecord(id);
-      if (rec) {
-        const body = appendEvent(rec.body, `batch-${to}`, "batched", `assigned to ${to}`);
-        writeRecord(id, { ...rec.front, ...frontFor(bug, landed) }, body);
-      }
-
-      if (!readShard(to).rows.some((r) => r.id === id))
-        fail(`${id} is missing from ${to}.jsonl after the triage-move`);
+      const before = readCatalogue();
+      try {
+        const rows = readCatalogue();
+        const cat = rows.find((r) => r.id === id);
+        if (cat) {
+          cat.batch = to;
+          writeCatalogue(rows);
+        }
+
+        const rec = readRecord(id);
+        if (rec) {
+          const body = appendEvent(
+            rec.body,
+            `batch-${to}`,
+            "batched",
+            `assigned to ${to}${why ? ` — ${why}` : ""}`,
+          );
+          writeRecord(id, { ...rec.front, ...frontFor(bug, landed) }, body);
+        }
+
+        if (!readShard(to).rows.some((r) => r.id === id))
+          fail(`${id} is missing from ${to}.jsonl after the triage-move`);
+      } catch (e) {
+        writeCatalogue(before);
+        dropLedgerRow(to, id);
+        fail(
+          `move: ${id} failed after the ledger write (${e.message}) — catalogue and ledger restored to their pre-write state`,
+        );
+      }
```

Lock structure unchanged: `withCatalogueLock` remains outermost around the whole triage branch; `upsertLedgerRow` still takes the shard lock internally. No new `withShardLock(` call was introduced, so the static lock-order self-test's parse (which only looks for `withCatalogueLock(` lexically nested inside a `withShardLock(`/`withShardLocks(` span) is unaffected — confirmed by the self-test's lock-order checks staying `ok`.

Note: as in `cmds.file`, `fail()` calls `process.exit(1)` directly (does not throw), so the read-back assertion's own `fail()` call, even though now textually inside the `try`, still exits immediately rather than triggering the `catch` — this matches `file`'s existing behavior byte-for-byte (its own read-back-style assertions work the same way) and is not a new gap.

## F5 — code map invents `roundSha`, credits `file` instead of `expand` (minor)

`.claude/code-map/INDEX.md`, bugs.mjs entry:

```diff
-builds the row exactly as `file --batch` does (same fields/`roundSha`derivation) under
+builds the row exactly as `file --batch` does (same fields) under
...
-appends the record's `batched`event with`file`'s own key/text,
+appends the record's `batched`event with`expand`'s own key/text,
```

Checked `.claude/code-map/CHANGELOG.md`'s 2026-09-05 bullet — it does not say "roundSha" and already says "`file`'s own row shape" (not "key/text"), so neither phrase from F5 is repeated there; no CHANGELOG edit made (per F5's own "if it repeats either phrase" condition — it doesn't).

**Deviation (reported, not applied):** the same INDEX.md paragraph still quotes the _old_ `--check` success message verbatim ("prints `sync --check: records mirror the ledger` and exits 0") which is now stale after F1's message-format change. This wasn't in F5's explicit scope (only the `roundSha` clause and the `file`→`expand` attribution were named) and F6 (the `_meta.json`/mapping bump) is explicitly deferred to close-out, so I left it for the close-out documentation pass rather than expand scope unilaterally.

## F6 — NOT done (per instructions)

`_meta.json.mappedSha` left untouched at `2da6228c`; this is close-out executor's job per the ruling.

## F7 — anti-vacuity note in test-plan.md (nit)

```diff
-Creating the row without `mustBeNew`; skipping the History event; accepting the path without `--tier`. |
+Creating the row without `mustBeNew`; skipping the History event; accepting the path without `--tier`. (`mustBeNew` guards a between-check-and-write race and is not unit-mutable — accepted) |
```

No code change (per ruling: "DROP the plan mutation").

## F8 — catalogue-write coverage (nit)

Two new `check()`s using `list --batch`, confirming `cmds.list`'s `--batch` filter reads `r.batch` from the catalogue (`bugs.mjs:1029`) and prints the id (`r.id.padEnd(5)` at `bugs.mjs:1035`):

```js
const listF05 = runCli(["list", "--batch", "F05"], tmp);
check(
  "T14/R10: list --batch F05 shows the triaged bug (catalogue.batch was updated)",
  /\bB1\b/.test(listF05.out),
  true,
);
...
const listF06AfterRehome = runCli(["list", "--batch", "F06"], tmp);
const listF05AfterRehome = runCli(["list", "--batch", "F05"], tmp);
check(
  "T14/R10: list --batch reflects the re-home's catalogue update too",
  { f06HasB1: /\bB1\b/.test(listF06AfterRehome.out), f05HasB1: /\bB1\b/.test(listF05AfterRehome.out) },
  { f06HasB1: true, f05HasB1: false },
);
```

## F9 — dead anchor snapshot/restore in T13b (nit)

Deleted the `realAnchorPath`/`realAnchorSaved` snapshot, the `try/finally` restore, and the explanatory paragraph about it (now that `--check` exists and returns before `commitMentions`, no anchor write can ever occur in this block). Kept the `runCli(["sync", "--check"], undefined)` call and its `check()` (now carrying the `examined` field from F1).

## F10 — unknown-flag rejection in `sync` (nit)

Added before any read in `cmds.sync`:

```js
const known = new Set(["--quiet", "--rescan", "--check"]);
const unknown = args.filter((a) => a.startsWith("--") && !known.has(a));
if (unknown.length)
  fail(`sync: unknown flag(s) ${unknown.join(", ")} — usage: sync [--quiet] [--rescan] [--check]`);
```

Added one T13 check:

```js
const typoed = runCli(["sync", "--chek"], tmp);
check(
  "T13/R9: an unrecognised sync flag is refused, not silently treated as a write",
  {
    code: typoed.code,
    ranASync: /recorded \d+ new event/.test(typoed.out),
    named: typoed.out.includes("unknown flag"),
  },
  { code: 1, ranASync: false, named: true },
);
```

**Gate 4 / invocation-site grep (run before implementing, to make sure no existing caller would break):**

- `.claude/hooks/stop.mjs:193` — `spawnSync("node", ["scripts/campaign/bugs.mjs", "sync", "--quiet"], ...)` — only `--quiet`.
- `grep -rn "bugs\.mjs" scripts .claude/hooks .husky package.json .github` (each searched individually) — the only other `sync`-related hits are the usage-comment line in `bugs.mjs` itself and `package.json`'s `verify`/`bugs`/`bugs:self-test` scripts, none of which invoke `sync` with any flag combination.
- `.husky/` — no `bugs.mjs` references at all.
- `.github/` — no `bugs.mjs` references at all.

No existing caller passes anything beyond `--quiet`, so the new rejection is safe.

## F3, F6, F11, F12 — untouched (per ruling)

F3's code (full-bytes/header-line comparison) not implemented — DEFER, RUN-LOG candidate; only the doc-scoping sentence (shared with F1's usage-header edit) was added. F6 left for close-out. F11/F12 are ACCEPT (no code change).

---

## Gate results

### `node scripts/campaign/bugs.mjs self-test`

Before prettier reformat: **298 checks, all `ok`, exit 0** (`self-test: all checks passed`). New cases visible in the tail: all T13/T13b/T14 checks including the new F1 (`examined`), F2 (`--why` reason), F8 (`list --batch`), and F10 (`--chek` refusal) assertions.

Re-ran after `prettier --write` reformatted the file (pure formatting diff — no logic changed): **exit 0, tail confirms `self-test: all checks passed`**, including the final new T14 checks (`F06's shard holds B1 after the re-home`, `list --batch reflects the re-home's catalogue update too`, `triage-move on an id outside the catalogue is refused as an unknown id`).

### Prettier

`npx prettier --write scripts/campaign/bugs.mjs` — reformatted (7.0s), then `npx prettier --check "scripts/campaign/*.mjs"` — **"All matched files use Prettier code style!"**

### `node scripts/campaign/bugs.mjs sync --check` (from repo root)

```
sync --check: 213 record(s) mirror the ledger
```

Exit 0. New count line present, as required.

### F1 vacuity repro (from the review)

```
$ cd apps/api && node ../../scripts/campaign/bugs.mjs sync --check
sync --check: 0 record(s) mirror the ledger
EXIT=0
```

This is **expected**, not a regression: this direct invocation bypasses `runCli` entirely (it's a raw `node ... sync --check` from a non-root cwd, not the self-test's child-process harness), so `rootDir()` still resolves `.claude/campaign` relative to the process's own `cwd()` and sees an empty catalogue. The fix scoped by the ruling only forces `cwd: REPO_ROOT` inside `runCli` (i.e., for the self-test's own real-tree assertion, T13b) — the guard against this exact vacuity is T13b's new `examined` assertion, which fails if the real-tree run (which import-time uses `runCli(..., undefined)` and now inherits `cwd: REPO_ROOT`) ever examines zero records. Real-world protection continues to rely on Gate 4 / `npm run verify` always running from the repo root (confirmed above: the only automated caller, `.claude/hooks/stop.mjs`, does not `cd` anywhere first).

### `git status --porcelain`

```
 M .claude/code-map/INDEX.md
 M .claude/pipeline/2026-09-05-registry-guards/test-plan.md
 M scripts/campaign/bugs.mjs
?? .claude/pipeline/2026-09-05-registry-guards/closeout-plan.md
?? .claude/pipeline/2026-09-05-registry-guards/closeout-prep.md
?? .claude/pipeline/2026-09-05-registry-guards/fix-round-1-ruling.md
?? .claude/pipeline/2026-09-05-registry-guards/lesson-L-080.md
?? .claude/pipeline/2026-09-05-registry-guards/review-opus.md
```

Only the three modified files are ones I touched, matching the allowed list exactly. The five untracked `??` files under the run directory (`closeout-plan.md`, `closeout-prep.md`, `fix-round-1-ruling.md`, `lesson-L-080.md`, `review-opus.md`) were **not created by me** — `closeout-prep.md`, `fix-round-1-ruling.md`, and `review-opus.md` were already untracked at the start of this session (part of the ruling/review inputs I was told to read); `closeout-plan.md` and `lesson-L-080.md` appeared mid-session with fresh mtimes (01:03–01:04), evidence that the pipeline orchestrator (Fable) is concurrently drafting close-out material in this same run directory while this fix round executed. I did not read, modify, or rely on their contents, and this fix round's own `fix-round-1-report.md` (this file) is the only file I added.

### `git diff --stat`

```
 .claude/code-map/INDEX.md                          |   2 +-
 .../2026-09-05-registry-guards/test-plan.md        |   2 +-
 scripts/campaign/bugs.mjs                          | 189 +++++++++++++++------
 3 files changed, 138 insertions(+), 55 deletions(-)
```

## Deviations from the literal instructions

1. **F1's T13b `mirrors` field**: the instructions named only the `examined` addition and T13's regex change explicitly for T13b's object shape; I also switched T13b's `mirrors` check from `real.out.includes("records mirror the ledger")` to the same `/\d+ record\(s\) mirror the ledger/.test(...)` regex used for T13, because the literal substring no longer appears in the new message format (`"N record(s) mirror the ledger"` has no bare `"records mirror the ledger"` substring) — leaving it unchanged would have made a previously-passing assertion fail for an unrelated (formatting) reason. This is a necessary consequence of F1, not scope creep.
2. **F5's stale message quote in INDEX.md**: noted above as a finding, not fixed (out of F5's literal scope; F6/close-out territory).
3. No other deviations. Every other edit matches the ruling/task instructions verbatim (message text, regex forms, check names, lock structure, file list).
