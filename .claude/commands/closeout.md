---
description: Close out a finished pipeline or light-loop run — ledger row, RUN-LOG stub, handoff card — then walk the manual items closeout only stubs. Say "/closeout <runDir>", "close out this run", "wrap up the pipeline run".
---

Run:

```
node .claude/skills/dev-pipeline/scripts/closeout.mjs <runDir> [--light [--scale small|major]]
    [--branch <name>] [--pr <n>]
```

Use `--light` when `<runDir>` has no `result.json`, or the run was a light loop, or you want a
`--findings` JSON summary attached (`closeout.mjs` auto-detects the missing-`result.json` case anyway
— pass the flag explicitly to force reconstruction or unlock the RUN-LOG stub for that case). Pass
`--dry` first if you're unsure the run/branch/PR values are right — it previews every write as a diff
without touching anything.

If it exits non-zero, read the stderr message and fix the actual cause (usually: wrong `<runDir>`, no
git repo above it, or an idempotency conflict from a prior partial close-out) — don't retry blindly or
add `--force`-style flags that don't exist on this script.

Once it succeeds, walk the MANUAL items yourself — `closeout.mjs` only inserts stubs for these, it
never fills them in:

1. **Coverage-matrix walk** — confirm every test/assertion the run's plan called for actually landed;
   note any gap plainly (don't paper over it).
2. **Artifact status lines** — update the project's own status doc (e.g. this project's `CLAUDE.md`
   "Build progress" checklist, or equivalent) to reflect what this run actually shipped.
3. **RUN-LOG knob line** — open `.claude/skills/dev-pipeline/references/RUN-LOG.md`, find the stub
   entry closeout just inserted (top of file, this run's slug), and fill in the ONE candidate knob
   change with evidence from this run, plus any deviation the run forced. A run with no transferable
   knob leaves that line honestly blank — never invent one to fill the slot.
4. **Lesson body** — if this was a bugfix run, `.claude/lessons/LESSONS.md` got a stub too; write its
   Symptom / Root cause / Lesson / Guard body. A fix with no generalizable lesson (typo-class) just
   needs `.claude/lessons/_meta.json.updatedAt` bumped — never force a junk entry to fill the cap.

Finish with `/handoff` so the next session (or a resumed one) starts cold without re-reading this one.

5. **Plane update (projects with `scripts/campaign/plane-apply.mjs`)** — one reviewed ops file per landing,
   never ad-hoc MCP writes (MCP `workitem update` is classifier-blocked in auto mode; the scripted path is
   budgeted, denylisted and ledgered): write `local-assets/plane/ops/<date>-<slug>.json` (state moves by
   identifier, the OPS window item, comments with PR/sha), run `node scripts/campaign/plane-apply.mjs <file>
--dry-run`, review the plan, then apply. Then `npm run plane:sync` (registry → BUGS mirror, comment-on-close)
   and `npm run plane:check` (must exit 0 = no drift). Bugs the owner filed in Plane come back through
   `npm run plane:intake` on a master-merged tree. Manual budget: ≤ 20 writes/day (`--over-budget "<reason>"`
   to exceed, reason ledgered).
