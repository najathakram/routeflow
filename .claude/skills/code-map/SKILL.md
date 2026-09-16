---
name: code-map
description: >
  Maintain and consult a persistent, surgically-updated map of a codebase under
  `.claude/code-map/`. Auto-load when orienting in an unfamiliar or large repo, at the
  start of a session, when answering "where is X / how does Y work", when planning or
  making a code change, or right after editing code (to update the map). Keywords: "code
  map", "understand the codebase", "where is", "how does", "orient in the codebase"
  (the session-start brief is /orient), "navigate the repo", "onboard", "what changed".
---

# Skill: Code Map

A **code map** is a durable, signature-level index of a repository kept at
`.claude/code-map/`. It exists so you can orient and plan **without reading the whole
codebase**: read the map, decide which few files actually matter, open only those. The map
indexes _structure, signatures, and relationships_ — never copies of code.

**This is progressive disclosure applied to a codebase.** `INDEX.md` carries only names,
one-line purposes and pointers; the next level of detail — exports, deps, 1-hop
callers/callees — is exactly one hop away in the area file, never inlined where a pointer
would do. A reader who needs more than the pointer follows it; nothing is duplicated at two
altitudes.

Three workflows: **Consult** (read it to act), **Update** (keep it true after every change),
**Bootstrap** (build/re-map it). The exact file format is in
[`reference/map-format.md`](reference/map-format.md).

## The artifact — `.claude/code-map/`

- **`INDEX.md`** — orientation: stack, entry points, build/test commands, the global
  **where-to-find** table (feature/symptom → file), and links to each area file. **Hard cap:
  ≤ 20,000 bytes, no table row over 200 bytes.** A where-to-find row is
  `| topic | <area>.md#anchor — one clause |` — the prose itself lives in the area file under
  that anchored heading, never inlined in the cell. Approaching the cap, **trim by reference
  count**: drop or fold the where-to-find rows a session has actually needed least (a row no
  session has followed in a long while is the first cut), never the newest rows on principle.
- **`<area>.md`** — one per workspace/app/major module (e.g. `api.md`, `web.md`). Lists each
  significant file → one-line purpose, key exports with signatures, internal deps, notable
  side effects (DB models, network, events), and **direct 1-hop callers/callees/imports**
  where known — enough to answer "what breaks if I change this" without opening a second file.
  Keep entries terse — **~200–300 bytes each, signatures, never bodies.** **Hard cap: ≤ 100,000
  bytes total per area file** — an area that outgrows this splits into `<area>/<module>.md`
  parts, with `<area>.md` itself kept as a ≤ 8,000-byte table of contents whose rows point at
  each part; `INDEX.md`'s where-to-find rows then point at the part file's anchor, not at
  `<area>.md` directly. **Large-repo pattern:** next to a split area, a nested
  `<area>/CLAUDE.md` (≤ 1 KB) pointing at that area's part files is the official way to keep a
  sub-team oriented without growing `INDEX.md` — not a substitute for the part files.
- **`CHANGELOG.md`** (recommended once a project is active) — dated session notes, newest
  first, so `_meta.json` never has to carry history. **Hard cap: ≤ 40,000 bytes / ≤ 30
  entries** — trim older entries to `git log -- .claude/code-map` when hit.
- **`_meta.json`** — bookkeeping: `{ mappedSha, generatedAt, areas[], fileCount,
schemaVersion }`. `mappedSha` is the git commit the map was last reconciled against — it is
  what makes surgical updates and drift detection possible.

**Why the caps:** one project let `INDEX.md` grow to 572 KB of inlined prose, which cost every
session ~143K tokens before its first tool call. The caps make that failure mode structurally
impossible instead of relying on discipline.

## 1. Consult — the default read path

**The ladder: map → grep → agentic exploration.** Try the map first; fall back to a targeted
`grep`/`Grep` across the tree only when the map doesn't cover the area or is stale there; reach
for a broad agentic exploration (an `Explore` subagent reading widely) only when both come up
short. Each rung is more expensive than the last — do not skip straight to the top rung out of
habit.

Do this **before** grepping broadly or reading source to understand existing code:

1. **Read `INDEX.md`.** If `INDEX.md` is missing (not merely the directory — a partial
   `.claude/code-map/` with no INDEX.md is still "no map"), offer to **Bootstrap** (§3).
2. **Check drift** (cheap): compare `_meta.json.mappedSha` to `git rev-parse HEAD`.
   - `git diff --name-only <mappedSha> HEAD` plus `git status --porcelain` = files changed
     since the map. If any overlap your task, read those specific files fresh (the map may be
     behind for them) and refresh their entries as you go.
3. **Navigate INDEX → area → file.** Use the where-to-find table and the relevant `<area>.md`
   to pin the exact files/symbols involved. Open only those. Expand outward only where the
   map's cross-refs say a change ripples.
4. **Read the section, not the file**, once an area has been split into parts (an area file over
   the 100,000-byte cap — see "The artifact" above): locate the anchor with `Grep` first, then
   `Read` with an offset/limit of ~120 lines around it. Do not read a whole multi-hundred-KB
   part file to get one entry.
5. You now have a plan having read ~2–3 map files instead of scanning the tree. Act.

> The map is an aid, not ground truth. If it contradicts the code, **trust the code** and fix
> the map entry (§2) as part of your change.

## 2. Update — surgically, after every change

**Trigger:** you created, edited, renamed, or deleted any source file this session. Updating
the map is part of finishing the task, like updating a test.

For each touched file, edit **only** its entry in the right `<area>.md` (use `Edit`, never
rewrite the file):

- **New file** → add an entry: path, one-line purpose, key exports, internal deps.
- **Changed signature/exports/purpose** → edit just those lines.
- **Deleted / renamed** → remove or move the entry; fix inbound cross-refs that named it.
- **New module / app / package** → add a section (or a new `<area>.md`), link it from
  `INDEX.md`, and add where-to-find rows.

Then update **`_meta.json`**: set `mappedSha` to the new commit SHA once committed (if still
uncommitted, leave the prior SHA — the next session's drift check will catch the working-tree
delta), and adjust `fileCount` if it changed.

**Diff-sized discipline:** a one-file code change is a few-line map edit. Never regenerate the
whole map for a small change.

**Same-PR rule:** land the map edit in the same PR/commit as the code change — bookkeeping is
part of the change, not a follow-up. Reserve a `Bookkeeping-Follow-Up: pending` trailer (and a
deferred edit) for public-window deploys only.

## 3. Bootstrap / re-map — generate it

When no map exists, or an area has drifted structurally:

1. **Scope.** Respect `.gitignore` / `.claudeignore`; skip `node_modules`, build output
   (`dist`, `.next`, `build`, `.turbo`), lockfiles, generated code, vendored assets.
2. **Partition.** One `<area>.md` per workspace (monorepo: a `package.json` per app/package) or
   per major top-level module. A single small app → one area file or sections in `INDEX.md`.
3. **Extract signatures cheaply — do not read whole bodies.** Prefer
   [`reference/extract-signatures.mjs`](reference/extract-signatures.mjs) where the repo is
   TypeScript: it uses the TypeScript compiler API (or `ts-morph` when present) to derive
   exports, imports and direct importers **deterministically**, so the model's only job is to
   write the one-line purpose per file — never to transcribe a signature list by hand. Elsewhere,
   `grep` for `export`, `class`, `function`, default exports, and framework markers (route files,
   `@Controller`/`@Injectable`, React components, CLI entry points). Read file headers and
   signatures, not implementations.
4. **Fan out for scale.** For a large repo, spawn one read-only Sonnet subagent (e.g.
   `Explore`) per area, each returning a structured area map; assemble their results into the
   files yourself. This keeps your own context lean — the whole point of the map.
5. **Write** `INDEX.md`, the `<area>.md` files, and `_meta.json` (`mappedSha` = current `HEAD`
   from `git rev-parse HEAD`). Keep `INDEX.md` ≤ 20 KB **from day one** — a first pass still
   respects the cap; it is never a placeholder to fix later. Target: a newcomer orients from
   `INDEX.md` in a single read.
6. Copy [`reference/validate-code-map.mjs`](reference/validate-code-map.mjs) into the project's
   `scripts/` and wire it into the verify chain (`npm run verify` or the project's equivalent
   gate); run it once to confirm it passes against the map just written ("Per-project
   enforcement" below has the exact contract). Without this step the caps above are a
   convention, not a gate.

## Drift detection

`_meta.json.mappedSha` vs `git rev-parse HEAD` is the truth source. Small drift → surgical
refresh of the listed files (§2). Large or structural drift → re-map the affected areas (§3,
subagent per area). Surface large drift to the user rather than silently trusting a stale map.
When a `typescript-lsp` plugin/MCP is connected, its live symbol index is the ground truth for
exports and references in TypeScript areas — reconcile the map's entry against it rather than
re-deriving from grep, and prefer the LSP's answer over a stale map entry when the two disagree.

## Learning clause — mandatory (owner ruling 2026-09-10)

The map is the orientation half of the house learning loop, and it is measured: every session starts from
`INDEX.md` (≤ 20 KB) → one area file, and the tokens a session spends before its first tool call are the
metric (`session-usage.mjs` shows it; a 572 KB INDEX cost ~143K per session). Every change **records** its
map entries in the same PR; the validator **proves** the caps on every verify; when the map and the code
disagree the map is fixed the same day. A repeated "where is X" that the map could not answer is a lesson
candidate for the register, not a shrug. Canonical text:
`~/.claude/skills/dev-pipeline/references/LEARNING-CLAUSE.md`.

**TRIAL, not enabled:** AWM-style **procedure entries** — a map entry that captures a reusable
multi-step _procedure_ ("how we add a new route here"), not just structure — for a task shape
that has recurred 3+ times in this repo. Not adopted; a candidate procedure worth trying stays a
proposal until the owner says yes, same bar as any other trial in this house.

## Guardrails — do NOT

- Copy code bodies into the map. Index signatures, purpose, and relationships only.
- Read entire files to update it — grep for signatures.
- Regenerate the whole map for a small change.
- Let an area file grow unbounded — once it passes the ≤ 100,000-byte cap, split it into
  `<area>/<module>.md` parts and keep `<area>.md` itself as a ≤ 8,000-byte table of contents
  whose rows point at each part's anchor; `INDEX.md` rows then point at the part file, not
  `<area>.md`. Never let the split itself become an excuse to inline prose back into INDEX.md.
- Put secrets, tokens, or env **values** in the map (names/structure only).

## Per-project enforcement (required for the caps to exist)

Two mechanisms make the caps and freshness a build gate instead of relying on discipline alone.
Neither is truly optional: skip the validator and every cap in this file — INDEX.md, row size,
CHANGELOG.md, the 100,000-byte area-file cap — is a number in a doc nobody checks.

- **Size validator** — [`reference/validate-code-map.mjs`](reference/validate-code-map.mjs)
  fails the build when `INDEX.md`, a row, `CHANGELOG.md`, or any area/part `.md` file (other
  than `INDEX.md`/`CHANGELOG.md` themselves) is over cap, or `_meta.json` is missing/invalid; it
  prints every area file's byte size and warns (non-blocking) when `mappedSha` is stale. Copy it
  into the project's `scripts/` (§3 Bootstrap step 6) and wire it into `npm run verify` (or the
  project's equivalent gate); run it once.
- **Stop hook** — [`reference/stop-hook.mjs`](reference/stop-hook.mjs) reminds you when tracked
  source changed but `.claude/code-map/` was not touched. This one stays genuinely optional —
  the global routine in `~/.claude/CLAUDE.md` is the primary, model-driven mechanism.

Both are copied into the project (wire into `.claude/settings.json` / the verify chain), not
installed globally.
