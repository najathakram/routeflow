# Brief — PR-5 · Item 3B: destructive-migration lint in CI (Squawk) — light loop

Branch `ci/imp-03b-migration-lint-squawk` (after PR-4). Commit type `ci:`. Scale small (one
script, one config, one workflow step, one devDependency). Loop: Sonnet builds → Opus `high`
review → gates. **Owner-visible deviation:** the plan said Atlas; Atlas's `migrate lint` is
Pro-only since v0.38 and cannot read Prisma's migrations layout — Squawk delivers the same intent
free (see the plan, PR-5).

## Verified facts (2026-09-03, scratch probe outside the repo)

`squawk-cli@2.64.0` (npm; `(Apache-2.0 OR MIT)`; optionalDependencies ship `@squawk-cli/linux-x64`
and `@squawk-cli/win32-x64`; `npm i` on Windows succeeded; `npx squawk --help` runs). Parses
Prisma SQL (quoted identifiers, `ALTER TYPE … ADD VALUE`, `ADD CONSTRAINT … FOREIGN KEY`). Exit 0
clean / 1 on any finding. `.squawk.toml`: `excluded_rules = [...]`, `pg_version = "17.0"`.
Per-statement ignore: `-- squawk-ignore <rule>[, <rule>]` on the line above; file-level
`-- squawk-ignore-file`. Flags: `-e/--exclude`, `--pg-version`, `-c/--config`, `--reporter
<tty|gcc|json|gitlab>`, `--no-error-on-unmatched-pattern`. A real repo migration produced 28
advisories, all lock-hygiene (`require-concurrent-index-creation`, `constraint-missing-not-valid`,
`prefer-bigint-over-int`, `prefer-timestamptz`, `require-enum-value-ordering`, …) — Prisma emits
those shapes by design, so they are excluded; the destructive set fires correctly on a synthetic
file (`ban-drop-column`, `require-concurrent-index-creation`, `adding-required-field`).

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Verified by              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| R1  | Root `devDependencies`: `"squawk-cli": "2.64.0"` (exact). Real `npm install`; `node scripts/validate-lock-edges.mjs` → `missing 0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A3                       |
| R2  | `apps/api/.squawk.toml`: `pg_version = "17.0"`; `excluded_rules` = every rule **except** the destructive gate set `ban-drop-table`, `ban-drop-column`, `ban-drop-database`, `changing-column-type`, `adding-required-field`, `renaming-column`, `renaming-table`, `ban-truncate-cascade`, `syntax-error` (the exclusion list is written out explicitly from `squawk --help`/docs at implementation time — 31 names — with a header comment explaining why lock-hygiene rules are advisory here).                                                                                                                                                                                                                                                                                                                              | T1                       |
| R3  | `scripts/lint-migrations.mjs` (node, no deps beyond `squawk-cli`): modes `--base <ref>` (default `origin/master`; files = `git diff --name-only <base>...HEAD -- apps/api/prisma/migrations` filtered to `migration.sql`), `--files <paths…>`, `--all` (every `migration.sql`, informational: prints counts, always exit 0 unless `--strict`). Runs `squawk --config apps/api/.squawk.toml --reporter gcc <files>` via `spawnSync` argv (`shell:false`), passes the exit code through; zero files → prints "no migrations in range" and exits 0. **Reason rule:** before invoking squawk, scans each file: every line matching `^--\s*squawk-ignore` must be immediately preceded by a line matching `^--\s*reason:\s*\S` — otherwise prints `<file>:<line>: squawk-ignore without a "-- reason:" line above it` and exits 1. | T1                       |
| R4  | Root `package.json` scripts: `"lint:migrations": "node scripts/lint-migrations.mjs"`. `.github/workflows/db-migrations.yml`: step **"Destructive-migration lint (squawk)"** before the replay, `run: node scripts/lint-migrations.mjs --base "${{ github.event.pull_request.base.sha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                          | 'origin/master' }}"`, with the checkout `fetch-depth: 0`(or a`git fetch origin master --depth=…`) so the range resolves; `paths`filter gains`scripts/lint-migrations.mjs`, `apps/api/.squawk.toml`, and the workflow. Steps only. | A2  |
| R5  | Docs: `CLAUDE.md` Deployment & DB safety — one line ("destructive migrations are blocked in CI by Squawk; whitelist a statement with `-- reason:` + `-- squawk-ignore <rule>`"); the `db-migration` skill file (`.claude/skills/db-migration/SKILL.md`, if present) gets the same two lines; `docs/IMPROVEMENTS.md` item 3 text: replace the Atlas recommendation with Squawk + the Pro-only reason (2 sentences), row 3 Status `shipped (PR-1 + PR-5)`; code-map root-scripts entry; `_meta.json`; lesson L-055: "a tool recommendation in a review is a claim — verify licensing and format support against current docs before planning around it (Atlas lint went Pro-only; its dir formats never included Prisma)".                                                                                                      | review, validate-lessons |

## Tests

- **T1** `apps/api/src/common/lint-migrations-script.spec.ts` (spawn; fixtures written to a temp
  dir): (a) `--files clean.sql` (`ALTER TABLE "T" ADD COLUMN "c" TEXT;`) → 0; (b) `--files bad.sql`
  (`ALTER TABLE "T" DROP COLUMN "c"; ALTER TABLE "T" ADD COLUMN y text NOT NULL;`) → 1, stdout
  contains `ban-drop-column` and `adding-required-field`, and does **not** contain
  `require-concurrent-index-creation` when the file also has `CREATE INDEX i ON "T"(a);` (proves
  the exclusion list); (c) `bad.sql` with `-- reason: column unused since #123` + `-- squawk-ignore
ban-drop-column` above the DROP and the NOT NULL line removed → 0; (d) the ignore without the
  reason line → 1 with the `without a "-- reason:"` message; (e) `--files` with no args → 0 and
  "no migrations". Before implementation: `spawnSync` status `null`.

## Acceptance

- A1: `npm run lint:migrations -- --all` → prints the count of findings over the 23 existing
  migrations (expected 0 destructive after the exclusions — if non-zero, list them in the PR; they
  are historical and not gated).
- A2: `gh workflow run db-migrations.yml --ref <branch>` (public window) → the lint step runs and
  the job is green; a scratch commit adding a destructive migration on a throwaway branch → the
  step fails with the rule name (log pasted), then the scratch branch is deleted.
- A3: `npm run verify` green; lock-edge `missing 0`.

## Files

`package.json` (root), `package-lock.json`, `apps/api/.squawk.toml` (new),
`scripts/lint-migrations.mjs` (new), `.github/workflows/db-migrations.yml`, one spec, docs,
bookkeeping.
