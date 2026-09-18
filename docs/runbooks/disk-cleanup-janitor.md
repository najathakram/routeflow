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
npm run janitor:self-test          # fixture-only unit tests of the classification logic
```

## What it reclaims, in order

Each step re-checks free space first and stops as soon as the target is met, so a light
shortfall never triggers the more aggressive later steps.

1. **`node_modules`** in worktrees whose branch is merged into `origin/master` — the checkout
   itself is kept (reinstall with `npm ci` when you're back on that branch).
2. **Whole worktrees** whose branch is merged AND have no uncommitted changes AND no unpushed
   commits — `git worktree remove --force`, then a fallback recursive delete if Windows left
   files behind (file locks are common), then `git worktree prune`.
3. **Orphan directories** under `.claude/worktrees/` that `git worktree list` no longer
   recognizes (left behind by a worktree removed outside this tool).
4. **Docker BUILD CACHE only** — `docker builder prune -a -f`.
5. **npm cache** — `npm cache clean --force`.
6. **Proof/audit folders** under `local-assets/proofs/` and `local-assets/handoff/` older than
   7 days (owner's retention choice).

## What it never touches

- The **main checkout** (never removed, never has its `node_modules` cleared).
- Any worktree named in `PROTECTED_WORKTREE_NAMES` (currently `rf-migrate`, `rf-crm-cloud`).
- Any worktree whose branch this tool cannot **prove** is merged into `origin/master` — the check
  is plain ancestry (`git merge-base --is-ancestor`), so a **squash-merged** branch will not be
  detected as merged and is left alone (a safe false-negative, not a bug — verify those by hand).
- Any merged worktree with uncommitted changes or unpushed commits — its `node_modules` may still
  be cleared, but the worktree itself is kept.
- **Docker volumes** and `docker system prune` — never run. Only `docker builder prune -a -f`.
- Remote branches — `--stale-branches` only ever reports, never deletes one.

## The junction rule (L-180 / L-193)

A Windows directory junction must never be deleted with a recursive delete that can follow it
into its target — that is exactly how a scratch worktree's `node_modules` junction once cascaded
into a sibling worktree and destroyed thousands of its tracked files in a single command. This
tool never uses PowerShell's `Remove-Item -Recurse` or Node's `fs.rmSync(..., {recursive:true})`
for anything that might contain a junction. Before any recursive delete, it enumerates junctions
under the target (read-only `Get-ChildItem`) and unlinks each one individually with a **bare**
`cmd /c rmdir "<path>"` (no `/s`, which is the flag that can follow a reparse point) before running
`cmd /c rmdir /s /q` on what remains.

## Preflight thresholds (guidance for callers, not enforced by the tool)

`--preflight <gb>` is a generic "is free space >= this number" check; a lane decides what number
to pass. Suggested tiers for this host:

| Free space | Meaning |
| --- | --- |
| > 10 GB | Normal — proceed with anything, including `npm ci`. |
| 6–10 GB | Reclaim first (`npm run janitor:apply`) before an `npm ci`. |
| < 6 GB | Refuse installs until `janitor:apply` has run. |
| < 3 GB | Stop everything and alert a human — do not attempt to reclaim unattended at this level. |
