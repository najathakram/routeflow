# Disk cleanup — `scripts/janitor.mjs`

The RouteFlow host runs many `git worktree`s at once (the local build fleet), and each one can
carry its own `node_modules`, Docker build layers, and local proof/handoff folders. `janitor.mjs`
reclaims that space in a fixed, safety-first order — report-only by default.

## Usage

```bash
npm run janitor                    # report-only: prints the plan, changes nothing
npm run janitor:apply              # reclaims for real, stops once free space >= target (default 10 GB)
node scripts/janitor.mjs --apply --target 15
npm run janitor:preflight -- 6     # exits 1 if free space < 6 GB — gate an `npm ci` on it
npm run janitor:stale-branches     # report merged branches still on origin (never deletes one)
npm run janitor:self-test          # classification tests + throwaway-repo merge scenarios (also run by Jest in verify)
```

## Worktrees only, and a reviewed list (`--worktrees-only`, `--paths`)

```bash
node scripts/janitor.mjs --worktrees-only            # steps 1-3 only; never docker, npm cache, proofs or Jest
node scripts/janitor.mjs --paths drop-safe.txt       # report: what it would do to the LISTED trees only
node scripts/janitor.mjs --paths drop-safe.txt --apply
```

- `--worktrees-only` runs steps 1-3 and nothing else. A scoped run has no free-space target
  unless you pass `--target`, so a roomy disk does not stop it before the first tree.
- `--paths <file>` (one worktree path per line, column 1; `#` comments allowed; a relative path is
  read against the repo root, not the current directory) acts **only** on the
  listed trees. Every other tree, and every non-worktree step, is printed as report-only. It implies
  `--worktrees-only`. The file is meant to be the DROP-SAFE list from a review, not a guess.
- A listed **detached** tree may go when ALL hold: HEAD is in `origin/master`, or is (or is behind)
  a merged PR head, or has the same tree as a merged PR head, or its diff is patch-id-equal to a
  squash on master; `git status` is clean; no ignored files except regenerable caches
  (`node_modules`, build output, `.jest-cache`, `.turbo`, `.next` …); HEAD has not moved in 24 hours;
  no other tree links into it. Unlisted detached trees are never acted on.
- A listed tree whose **index is missing or damaged, or has a stale `index.lock`** (untouched for 24
  hours) may go when its HEAD is on origin or in master and has not moved in 24 hours. With a stale
  lock `git status` is still readable, so it must also be clean with no ignored files except caches
  (checked at plan time and again at delete time). A fresh
  `index.lock` (a git command may be running) is always refused. At delete time HEAD must still be
  the HEAD the plan proved.
- A listed orphan dir or stray file is reported, never removed (its removal is a recursive delete).
- Every `--worktrees-only` or `--paths` removal is the junction unlink + rescan-to-0 (B817/B818), then a **plain**
  `git worktree remove`. Never `--force`, never a recursive delete: a tree git refuses stays, and the
  run reports it as FAILED.
- Before **anything** under a listed tree is touched (local-assets salvage, link unlink, `git worktree
remove`, a `node_modules` clear), `--apply` checks that no running process names the tree (command line
  or executable path, any path form; the process list is read once per run; an unreadable list refuses),
  then renames the root to `<tree>.janitor-probe` and straight back (see "The rename probe" below). Either
  check refuses just that tree, which stays complete.

### Clearing only `node_modules` (`--paths <file> --modules-only`)

```bash
node scripts/janitor.mjs --paths trees.txt --modules-only            # report: files per tree, seconds, refusals
node scripts/janitor.mjs --paths trees.txt --modules-only --sizes    # same, plus exact GB (slow: one stat per file)
node scripts/janitor.mjs --paths trees.txt --modules-only --apply    # clear tree by tree, GB freed per tree
```

Clears only the **real** `node_modules` folders (root, `apps/*`, `packages/*`) of each listed tree,
whatever its git state; never source, uncommitted work, `local-assets`, `.env` or the worktree
registration. A `node_modules` that is itself a link is left alone; links inside one are unlinked
(proven gone by the rescan-to-0) and never followed. A tree is **refused**, and the run moves on, when:
it is the main checkout, a protected name or a locked worktree; another tree's `node_modules` links into
it (one scan of every worktree; a failed scan refuses); a running process names it on its command line
or executable path, in any path form including Git Bash `/c/...` (an unreadable process list refuses
every tree); HEAD or the index moved in the last 24 hours (the janitor's one idle number,
`RECENT_ACTIVITY_HOURS`) or is unknown; any `node_modules` path cannot be read; or the rename probe
finds it in use. One failed tree is reported and the next still runs; the exit code is 1 if any failed.

### The rename probe

Windows has no per-process working-directory API, so a shell or `node dist/main.js` started from inside
a tree names nothing in it on the command line. But Windows refuses to rename a folder something holds.
At `--apply` time, immediately before a tree is cleared (`--modules-only`) or removed (`--paths`), its
root is renamed to `<tree>.janitor-probe` beside it and back:

- renaming away fails (EBUSY and the like): the tree is **in use**, refused, the run moves on;
- renaming back fails: the tree is sitting under the probe name. The whole run **stops**, loudly, naming both paths
  to rename by hand; no later tree is touched;
- a `.janitor-probe` name already beside any registered worktree at the start (a run died between
  its renames) is reported as `LEFTOVER PROBE`, and an `--apply` run changes nothing until it is dealt with;
- on macOS/Linux a rename never fails for a held cwd, so only the `lsof` cwd list and the 24h rule guard there.

## What it reclaims, in order

Each step re-checks free space first and stops as soon as the target is met, so a light
shortfall never triggers the more aggressive later steps.

1. **`node_modules`** in worktrees whose branch is **merged** (below), that have no uncommitted
   changes and whose HEAD has not moved in the last 24 hours — the checkout itself is kept
   (reinstall with `npm ci` when you're back on that branch).
2. **Whole worktrees** that meet step 1's conditions AND have no unpushed commits — first every
   symlink/junction inside is unlinked (B817), then `git worktree remove --force`, then a fallback recursive delete if Windows left files behind
   (file locks are common), then `git worktree prune`.
3. **Orphan directories** under `.claude/worktrees/` that `git worktree list` no longer
   recognizes (left behind by a worktree removed outside this tool) — only when they hold no `.git`
   entry and nothing in them changed in the last 24 hours (B820).
4. **Docker BUILD CACHE only** — `docker builder prune -a -f`.
5. **npm cache** — `npm cache clean --force`.
6. **Proof/audit folders** under `local-assets/proofs/` and `local-assets/handoff/` older than
   7 days (owner's retention choice).

## What "merged" means (B800)

Ancestry alone is not proof: a branch just created from master, with **zero commits of its own**, points at a mainline master commit and is trivially an ancestor
of `origin/master` — it used to count as merged, so an active lane's fresh worktree could lose its
`node_modules` or be removed. A branch is merged only when

- its tip is in `origin/master` but **not on master's first-parent mainline** (its work arrived
  through a merge), or
- `gh` reports its PR **MERGED with the PR head equal to the local tip** (this also covers squash
  merges; any `gh` failure means "not proven").

A fast-forwarded branch is indistinguishable from a fresh one and is left alone — a safe false
negative.

Known residual (safe in practice): a branch with zero commits of its own, cut from the **tip of an
old `--no-ff`-merged feature branch** (off the mainline), still reads as merged. master has been
squash-only since 2026-07-30 and lanes branch from the mainline, and the uncommitted-changes and
24-hour guards come first, so the realistic worst case is losing `node_modules` after a day idle.

## What it never touches

- The **main checkout** (never removed, never has its `node_modules` cleared).
- Any worktree named in `PROTECTED_WORKTREE_NAMES` (currently `rf-migrate`, `rf-crm-cloud`).
- Any worktree whose branch this tool cannot **prove** is merged (above) — including a fresh
  branch with no commits of its own, a fast-forwarded one, and a squash-merged one when `gh` is
  unavailable. Verify those by hand.
- Any worktree with **uncommitted changes**, or whose **HEAD moved in the last 24 hours** (or whose
  activity cannot be read) — neither its `node_modules` nor the worktree is touched. "Uncommitted"
  (B819) also means: `git status` could not be read, or an **ignored** path other than build output
  exists (a `.env`, `local-assets/`, a scratch file). The only ignored paths treated as disposable are `node_modules`; `dist`, `build` and
  `coverage` at the repo root or a package root (never deeper, where they may be source); `.next`, `.turbo`, `.expo`, `test-output`, `*.tsbuildinfo`, `.DS_Store`,
  `.campaign/`, `next-env.d.ts`, everything under `.husky/_/` and `.claude/settings.local.json`.
- An orphan dir under `.claude/worktrees/` that holds a `.git` entry or changed in the last 24 hours.
- A **locked** worktree (`git worktree lock`).
- Any merged, clean, idle worktree with unpushed commits — its `node_modules` may be cleared, but
  the worktree itself is kept.
- **Docker volumes** and `docker system prune` — never run. Only `docker builder prune -a -f`.
- Remote branches — `--stale-branches` only ever reports, never deletes one; a branch whose tip is
  on master's mainline (a fresh, zero-commit branch) is never reported as merged.

## The junction rule (L-180 / L-193)

A Windows directory junction must never be deleted with a recursive delete that can follow it
into its target — that is exactly how a scratch worktree's `node_modules` junction once cascaded
into a sibling worktree and destroyed thousands of its tracked files in a single command. This
tool never uses PowerShell's `Remove-Item -Recurse` or Node's `fs.rmSync(..., {recursive:true})`
for anything that might contain a junction. Before any recursive delete, it enumerates junctions
under the target (read-only `Get-ChildItem`) and unlinks each one individually with a **bare**
`cmd /c rmdir "<path>"` (no `/s`, which is the flag that can follow a reparse point) before running
`cmd /c rmdir /s /q` on what remains. Every step fails **closed** (B818): if the junction scan itself
fails, the delete is refused (never read as "no junctions"); each unlink is verified; and the tree is
re-scanned, and must be junction-free, before `rmdir /s` runs. The scan itself fails (exit 3) when any subtree could not be read, since an unreadable folder could hide a junction. One failed or refused action is reported as `REFUSED` and skipped; the run continues with the next one. Paths are passed to PowerShell as
properly quoted literals, so a `'` in a path can no longer break the scan.

On macOS and Linux (B815) the same rule applies to symlinks: the tool walks the tree itself and
`lstat`s every entry. A symlink, whether to a file or a directory, is **unlinked, never followed**;
only real directories are descended into. This matters because a lane worktree's `node_modules` can
be a symlink into the MAIN checkout (the MacBook's per-worktree overlay). Before B815, `--apply`
could not delete anything on macOS/Linux at all: it shelled out to Windows-only `cmd /c rmdir`.

Walking a tree with `lstat` cannot see a symlink in a **parent** folder (a lane whose `apps/` is a
link to `main/apps/` makes "the lane's `apps/api/node_modules`" really be the main checkout's). So
every delete first passes a **containment guard** on the target's real path: the main checkout is
never a target; nothing inside it may be deleted except under `.claude/worktrees/` and
`local-assets/`; and a `node_modules` target must resolve inside its own worktree. A refused delete
is skipped and printed as `REFUSED`, never forced.

**Windows, since the #1326 review.**

- A delete path containing a cmd metacharacter (`& | < > ^ % ! " ( ) , ; =`; the last three split arguments like a space) is **refused**, not
  deleted. `cmd /c rmdir` receives the path unquoted, and cmd splits on `&`: a probe deleting
  `wt\a&b` removed the SIBLING `wt\a`. Such a folder is left for a human to delete by hand.
- A delete target that **is itself** a junction (a lane's `node_modules` pointing at the main
  checkout's) is unlinked alone with a bare `rmdir`, verified gone, and never scanned. A recursive
  scan of a junction walks into its target and would unlink the main checkout's own links.
- Path comparisons in the containment guard are case-insensitive and ignore the `\\?\` prefix.
- Every path handed to cmd is **absolute and backslashed** first, and a drive or share root is
  refused. `git worktree list` prints `C:/...` paths, and cmd reads a `/segment` as a switch, so an
  unnormalised `rmdir /s /q C:/.../s/q` could have turned into `rd /s /q C:`.
  A `\\?\` or `\\.\` device prefix, a UNC path without a share, a `.` or `..` segment, a segment
  ending in a dot or a space (Win32 strips those, so cmd would act on a different folder than the
  guard approved), and control characters (cmd stops reading at a newline) are all refused.
- "Did the link go?" is checked with `lstat`, never `existsSync`. `existsSync` follows the link, so a
  link that survived its unlink but points at a missing target would read as removed.

## Where it runs from (B816)

The janitor always acts on the repo's **main checkout** (the first entry of `git worktree list`; if that cannot be read it refuses to run rather than guess) and
its `.claude/worktrees/`, whichever worktree you run it from. Before B816 it used
`git rev-parse --show-toplevel`, so a run from inside a lane worktree treated the real main checkout
as an ordinary worktree that could be cleaned.

## Preflight thresholds (guidance for callers, not enforced by the tool)

`--preflight <gb>` is a generic "is free space >= this number" check; a lane decides what number
to pass. Suggested tiers for this host:

| Free space | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| > 10 GB    | Normal — proceed with anything, including `npm ci`.                                     |
| 6–10 GB    | Reclaim first (`npm run janitor:apply`) before an `npm ci`.                             |
| < 6 GB     | Refuse installs until `janitor:apply` has run.                                          |
| < 3 GB     | Stop everything and alert a human — do not attempt to reclaim unattended at this level. |
