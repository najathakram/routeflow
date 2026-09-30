# Glossary

Terms briefs keep re-explaining, one line each.

- **T1/T2/T3** — proof tiers: T1 Jest, T2 Playwright vs. deployed build, T3 manual row in the
  batch build-plan. [`bug-registry/SKILL.md`](.claude/skills/bug-registry/SKILL.md).
- **REG pin** — the `REG-B###` token a test title must carry verbatim; required to close a bug.
- **prove / discharge** — `prove` closes one bug (merged PR + test); `discharge` closes a batch
  (green deploy) — kept separate, enforced by `campaign-check`.
- **campaign-check** — `scripts/campaign-check.mjs`: verifies REG- tokens/evidence/freshness before
  a state change; `--freshness-only` runs FIRST in `npm run verify`, the full REG-evidence gate LAST.
- **batch F##** — a `.claude/campaign/status/F##.jsonl` shard of bugs sharing files, one PR/board
  card; `bugs.mjs move <B###> --to <F##>` re-homes one.
- **radius pack** — Sonnet-built diff hunks + call sites a review reads instead of the whole diff;
  an out-of-radius finding needs its own reachability evidence.
- **light loop** — an ad-hoc, lighter stand-in for a full engine run (Fable ruling, Sonnet/Opus
  build, one re-verify round) — a logged deviation, never the default.
- **Bookkeeping Option B** — docs-only follow-up PR for map/lesson/registry edits after the code
  PR; now the **exception** (public-window deploys only) — same PR by default.
- **red gate** — bugfix bar: a REG- test must fail on its own wrong value (reproduce, not merely
  fail); reads test **titles**, not prose.
- **refutation vote** — Opus adversarially challenges a proposed root cause/finding; a split vote
  is tie-broken by Fable from the refuters' cited evidence.
- **fix card** — a per-batch brief under `.claude/pipeline/fix-cards/` (root cause, files,
  proof-tier table).
- **lessons digest** — `LESSONS-DIGEST.md`: id · category · **Lesson** sentence only, per active
  lesson, from `validate-lessons.mjs --digest`. Read first; `LESSONS.md` only for ids in a plan.
- **approach** — which methodology executes a task: `dev-pipeline` / `superpowers` / `raw` / `bug-pipeline`.
  Pinned before a session launches via `approach.mjs next`; see
  `~/.claude/skills/model-routing/references/EVAL-PROTOCOL.md`.
- **arm** — one `approach` as tracked in the evaluation ledger/comparison
  (`~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs compare`); dev-pipeline arms sub-split by
  `profile`. Needs n ≥ 10 telemetry rows before it's ranked.
- **profile** — `lean` / `standard`: the dev-pipeline engine's own depth setting, orthogonal to `approach`
  (a `dev-pipeline` run always has a profile; `superpowers`/`raw` runs never do).
- **R10 / #704** — `bugs.mjs --tag <tag>` filter batching security re-verification (F48) and audit
  backfill (F49) work, ids B355–B393.
