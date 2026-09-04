# Brief — PR-15 · Item 10a: `schema.prisma` → `prisma/schema/` domain folder (pipeline major)

Branch `refactor/imp-10a-schema-folder-split` (after PR-14). Commit type `refactor:`. Scale major
(schema refactor; every path reference). Depends on PR-1's drift gate (the lossless proof).

## Facts (surveyed)

`apps/api/prisma/schema.prisma`: 4,438 lines, 125 models, 80 enums. Prisma 7.10:
`apps/api/prisma.config.ts:7` sets `schema: path.join("prisma","schema.prisma")`; `@prisma/config`
types accept a folder (`schema` = "path to a folder that shall be recursively searched for
*.prisma files") and `migrations.path`. Path references that break on a split:
`apps/api/Dockerfile:19` (`COPY apps/api/prisma/schema.prisma …` — feeds the postinstall
`prisma generate` at :23, so a missed edit fails at `npm ci`), `prisma.config.ts`,
`apps/api/scripts/schema-drift.mjs` (PR-1: `--to-schema prisma/schema.prisma`),
`.claude/skills/bug-hunt/scripts/scan-signatures.mjs:1630-1633` (reads the single file inside a
silent `try {} catch {}` — after a split the enum-vocabulary signature finds nothing and `npm run
scan` stays green), `db-migrations.yml` (`paths: apps/api/prisma/**` still matches), any
`scripts/**` or `docs/**` mention. Relations cross domains freely (Prisma multi-file allows
that; names must be unique repo-wide).

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Verified by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| R1  | `apps/api/prisma/schema/` holds: `_base.prisma` (datasource + generator blocks, verbatim), `tenancy.prisma`, `catalog.prisma` (products/inventory/suppliers/pack sizes), `sales.prisma` (customers/orders/order templates/routes/drivers/returns/trips), `finance.prisma` (invoices/credit notes/vendor bills/estimates/recurring invoices/bookkeeping/payments/billing/plans), `platform.prisma` (tenants' platform config, users/auth/sessions, uploads, notifications, messages, audit, import, system config, AI usage, idempotency), `compliance.prisma` (regulated/tobacco/authorizations/filings). Every model and enum appears exactly once; each enum sits in the file of its primary owner. The split is produced by a committed script `apps/api/scripts/split-schema.mjs` driven by an explicit `name → file` map (models and enums listed by name; an unmapped name fails the script) so the operation is reviewable and repeatable. | T1, T2      |
| R2  | `schema.prisma` is deleted. `prisma.config.ts`: `schema: path.join("prisma","schema")`, `migrations: { path: path.join("prisma","migrations") }` (explicit); the `earlyAccess as any` cast is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | T2, A1      |
| R3  | Every path reference updated: `apps/api/Dockerfile:19` copies the folder (`COPY apps/api/prisma/schema apps/api/prisma/schema`); `schema-drift.mjs` uses `--to-schema prisma/schema` (verify against `prisma migrate diff --help` that the flag accepts a folder; else `--to-config-datamodel` — whichever the installed CLI documents); `scan-signatures.mjs` reads every `prisma/schema/*.prisma` concatenated and its `catch` now **throws** (a missing schema is an error, never a silent empty signature) — `npm run scan --self-test` green; `db-migrations.yml` comment; `apps/api/package.json` scripts mentioning the file; docs/code-map mentions. A grep `schema\.prisma` over the repo (excl. node_modules, migrations, CHANGELOGs, lessons) returns only historical prose.                                                                                                                                                           | T2, A2      |
| R4  | **Lossless:** `npx prisma validate` and `npx prisma format --check` clean; `prisma generate` output identical (diff the generated `index.d.ts` before/after — byte-identical); PR-1's drift gate against the compose DB (`local:drift`) reports no diff; **no migration is generated** (`prisma migrate diff --from-migrations … --to-schema prisma/schema --shadow-database-url <local>` empty, or the replayed-DB check in `db-migrations.yml` green).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A1, A2      |
| R5  | Pre-merge prod check (the `rebuild` schema gate won't fire — no new migration): `railway run --service postgres node apps/api/scripts/schema-drift.mjs` → `migrate status` 23 applied, diff empty, **after** the config change. Attached to the PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A3          |
| R6  | Bookkeeping: code-map `api.md` (schema section → per-file entries), INDEX, `_meta.json`; `CLAUDE.md` db-migration skill/preamble mentions; `docs/IMPROVEMENTS.md` row 10 `partial (PR-15 split; DTOs PR-16)`; lesson only if a surprise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | review      |

## Tests

- **T1** `apps/api/src/common/schema-folder.spec.ts` (static): the folder contains exactly the 7
  files; the multiset of `^model ` names across them has 125 unique entries and `^enum ` 80 (the
  numbers are taken from `git show master:apps/api/prisma/schema.prisma` at authoring time and
  pinned as literals); no name appears twice; `_base.prisma` contains `datasource` and
  `generator` and no `model`. Before: folder absent → counts 0.
- **T2** `apps/api/src/common/no-single-schema-path.spec.ts` (static): `schema.prisma` does not
  exist; `prisma.config.ts` text contains `"schema")` and `migrations`; `Dockerfile` contains
  `prisma/schema ` (folder COPY) and not `schema.prisma`; `scan-signatures.mjs` contains no bare
  `catch {}` around the schema read (assert the throw). Before: all invert.

## Acceptance

- A1: `cd apps/api && npx prisma validate && npx prisma format --check && npx prisma generate`
  green; generated client `.d.ts` diff vs master empty.
- A2: `npm run local:drift` → no drift; `npm run scan` and `npm run scan:self-test` green; `npm
run verify` green; `local:up` image builds (Dockerfile COPY) and boots.
- A3: the prod `migrate status`/diff output (R5) pasted in the PR.

## Files

`apps/api/prisma/schema/*.prisma` (7 new), `apps/api/prisma/schema.prisma` (deleted),
`apps/api/scripts/split-schema.mjs` (new), `apps/api/prisma.config.ts`, `apps/api/Dockerfile`,
`apps/api/scripts/schema-drift.mjs`, `.claude/skills/bug-hunt/scripts/scan-signatures.mjs`,
`.github/workflows/db-migrations.yml` (comment), two specs, bookkeeping.
