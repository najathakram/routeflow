# Build plan — PR-1 · Retire boot-time DDL; Prisma drift gate; DB-backed spec lane

Status: APPROVED · scale: major · ui: false · branch `fix/imp-03a-ddl-to-migrations-drift-gate`
Discovery `./discovery.md` · Spec `./spec.md` · Test plan `./test-plan.md` · Lessons
`.claude/lessons/LESSONS.md` (carry L-011, L-021, L-027, L-034, L-039).

Repo: RouteFlow monorepo (npm workspaces + Turbo). API = NestJS 11 + Prisma 7.10 (`apps/api`,
`prisma.config.ts` reads `DATABASE_URL`; the Prisma client is built over `@prisma/adapter-pg` +
`pg` `Pool` in `apps/api/src/prisma/prisma.service.ts`). Jest for the API is configured under the
`"jest"` key of `apps/api/package.json` (ts-jest, `rootDir: "src"`, `testRegex: ".*\\.spec\\.ts$"`,
`testEnvironment: node`). Prettier: `npx prettier --write <files>` (root config). Test tenants
only; never a live tenant identifier anywhere.

**Rules for every package:** targeted edits, never whole-file rewrites; ground every claim in a
tool result; a gap in this plan is a **finding** reported back, never a guess; do not touch files
outside the package's `files`; do not touch `apps/api/prisma/**` or any other worktree.

## Test packages (authored BEFORE implementation; Sonnet 5 @ medium)

| id                   | files                                                        | brief                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tp-tripwire`        | `apps/api/src/common/no-runtime-ddl.spec.ts`                 | Implement T1 exactly (walk `src` recursively with `fs.readdirSync`/`statSync`; skip `node_modules`; exclude `*.spec.ts`; POSIX-relative sorted offenders; `toEqual([])`).                                            |
| `tp-platform-config` | `apps/api/src/platform-admin/platform-config.no-ddl.spec.ts` | Implement T2. Read `platform-config.service.ts` first: mock every constructor dependency and every Prisma member `onModuleInit` touches. Do not modify the existing `platform-config.service.spec.ts` if one exists. |
| `tp-drift-script`    | `apps/api/src/common/schema-drift-script.spec.ts`            | Implement T3 (a)(b)(c) with the scrubbed env and the exact strings in the test plan. Use `spawnSync(process.execPath, …)` — never a shell string.                                                                    |
| `tp-db-guard`        | `apps/api/src/common/testing/db-spec.spec.ts`                | Implement T4 with the guarded-require rule; restore `describe` spies in `afterEach`.                                                                                                                                 |

## Red gate

```
cd apps/api && npx jest src/common/no-runtime-ddl.spec.ts src/platform-admin/platform-config.no-ddl.spec.ts src/common/schema-drift-script.spec.ts src/common/testing/db-spec.spec.ts
```

expect: **fail** (every test on an assertion — T1 on the two offender paths, T2 on 3 ≠ 0, T3 on
`null` status, T4 on `"undefined"` ≠ `"function"`).

## Implementation packages (disjoint by file ownership)

| id                        | model @ effort           | files                                                                                                                                                     | dependsOn       | satisfies                      | provenBy                 |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------ | ------------------------ |
| `p1-delete-runtime-ddl`   | claude-opus-5 @ high     | `apps/api/src/main.ts`, `apps/api/src/platform-admin/platform-config.service.ts`                                                                          | —               | R1, R2                         | T1, T2                   |
| `p2-drift-script`         | claude-sonnet-5 @ medium | `apps/api/scripts/schema-drift.mjs`, `apps/api/scripts/lib/railway-db-url.mjs`                                                                            | —               | R3                             | T3                       |
| `p3-prod-migrate`         | claude-opus-5 @ high     | `apps/api/scripts/prod-migrate.mjs`                                                                                                                       | p2-drift-script | R4                             | T3, A4                   |
| `p4-db-lane`              | claude-sonnet-5 @ medium | `apps/api/jest.db.config.js`, `apps/api/src/common/testing/db-spec.ts`, `apps/api/src/common/testing/db-lane.db.spec.ts`, `apps/api/package.json`         | p2-drift-script | R6 (+ `db:drift` script of R8) | T4, A3                   |
| `p5-root-scripts-compose` | claude-sonnet-5 @ medium | `package.json` (root), `docker-compose.yml`                                                                                                               | p4-db-lane      | R5                             | A2                       |
| `p6-ci-workflow`          | claude-sonnet-5 @ medium | `.github/workflows/db-migrations.yml`                                                                                                                     | p4-db-lane      | R7                             | A5                       |
| `p7-docs-map-lesson`      | claude-sonnet-5 @ low    | `CLAUDE.md`, `.claude/code-map/api.md`, `.claude/code-map/_meta.json`, `docs/IMPROVEMENTS.md`, `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json` | p1…p6           | R8                             | validate-lessons, review |

### p1 — delete the runtime DDL (Opus, HIGH risk: schema)

- `main.ts`: delete `runStartupMigration()` (the whole function, ~~:69-105) and the
  `if (process.env.RUN_STARTUP_DDL !== "false") { await runStartupMigration(); }` gate
  (~~:111-115). Remove imports that become unused. Nothing else in bootstrap moves.
- `platform-config.service.ts`: in `onModuleInit` (~:44-78) delete the `CREATE TABLE IF NOT
EXISTS "PlatformConfig"`, `CREATE TABLE IF NOT EXISTS "AiUsageEvent"`, and `CREATE INDEX IF NOT
EXISTS "AiUsageEvent_createdAt_idx"` statements and their `$executeRaw` (tagged-template) calls. **Read the
  whole method first**: keep every non-DDL statement (row seeding / defaults / logging) exactly.
  If nothing remains, remove `onModuleInit` and the `OnModuleInit` implements clause. Report in
  the deviation note what (if anything) non-DDL was retained.
- Do not add a replacement flag, comment-out, or "TODO". Deletion is the change.

### p2 — the drift script and the shared URL helper (Sonnet)

`apps/api/scripts/lib/railway-db-url.mjs` — **copy the construction from
`apps/api/scripts/prod-migrate.mjs:22-41` verbatim** (same `need` list, same encoding, same
suffix), then:

```js
// apps/api/scripts/lib/railway-db-url.mjs
export const RAILWAY_PROXY_VARS = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];
/** Proxy vars win over DATABASE_URL: under `railway run --service postgres` DATABASE_URL is the
 *  unreachable *.railway.internal host. Mirrors prod-migrate.mjs. */
export function resolveDatabaseUrl(env = process.env) {
  const missing = RAILWAY_PROXY_VARS.filter((k) => !env[k]);
  if (missing.length === 0) {
    // encoding matches prod-migrate.mjs exactly: the username is NOT encoded, only the password.
    return `postgresql://${env.POSTGRES_USER}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}/${env.POSTGRES_DB}`; // + the exact suffix prod-migrate.mjs appends, if any
  }
  if (env.DATABASE_URL) return env.DATABASE_URL;
  throw new Error(
    `No DATABASE_URL and missing Railway variables: ${missing.join(", ")} — run under 'railway run --service postgres' or set DATABASE_URL`,
  );
}
export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}:***@` : ""}${u.host}${u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}
export function scrubSecrets(text, url) {
  try {
    const p = new URL(url).password;
    if (!p) return text;
    return text
      .split(p)
      .join("***")
      .split(encodeURIComponent(p))
      .join("***")
      .split(decodeURIComponent(p))
      .join("***");
  } catch {
    return text;
  }
}
```

`apps/api/scripts/schema-drift.mjs`:

```js
#!/usr/bin/env node
// Read-only schema drift check. Exit 0 = no drift, 2 = drift (SQL printed), 1 = error.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js", { paths: [apiRoot] });
const argvFlags = new Set(process.argv.slice(2));
if (argvFlags.has("--help")) {
  console.log(HELP);
  process.exit(0);
}
const dryRun = argvFlags.has("--dry-run");

let url;
try {
  url = resolveDatabaseUrl(process.env);
} catch (e) {
  console.error(`schema-drift: ${e.message}`);
  process.exit(1);
}
console.log(`schema-drift: target ${redactUrl(url)}`);

const STATUS = ["migrate", "status"];
const DIFF = [
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  "prisma/schema.prisma",
  "--script",
  "--exit-code",
];

function run(args) {
  if (dryRun) {
    console.log(`[dry-run] node prisma ${args.join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const r = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: apiRoot,
    shell: false,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
  });
  if (r.stdout) process.stdout.write(scrubSecrets(r.stdout, url));
  if (r.stderr) process.stderr.write(scrubSecrets(r.stderr, url));
  return r;
}
const status = run(STATUS);
if (status.status !== 0) {
  console.error("schema-drift: migrate status failed");
  process.exit(1);
}
const diff = run(DIFF);
if (diff.status === 0) {
  console.log("schema-drift: NO DRIFT — database matches prisma/schema.prisma");
  process.exit(0);
}
if (diff.status === 2) {
  console.error(
    "schema-drift: DRIFT DETECTED — SQL above shows what the database is missing/extra",
  );
  process.exit(2);
}
console.error(`schema-drift: prisma exited ${diff.status}`);
process.exit(1);
```

(`HELP` is a short string documenting flags, env resolution and exit codes. Under `--dry-run`
the target line and the two `[dry-run]` lines are the whole output; nothing spawns.)

### p3 — prod-migrate.mjs (Opus, HIGH risk: the prod deploy script)

- Replace the inline URL construction (:22-41) with `import { resolveDatabaseUrl } from
"./lib/railway-db-url.mjs"` and a single call; keep the `need`/error semantics identical (the
  helper was copied from here). Verify by reading both that the resulting URL is byte-identical.
- After the existing `prisma migrate deploy` succeeds, spawn
  `node scripts/schema-drift.mjs` (same `cwd`, same env, argv array, `shell:false`); if its
  status is not 0, print `post-deploy drift check FAILED` and exit with that status. Nothing else
  in the file changes. This is a deploy script: no experiments, no refactors beyond the two edits.

### p4 — DB-backed spec lane (Sonnet)

```js
// apps/api/jest.db.config.js
const base = require("./package.json").jest;
module.exports = {
  ...base,
  testRegex: ".*\\.db\\.spec\\.ts$",
  testPathIgnorePatterns: ["/node_modules/"],
  testTimeout: 30000,
};
```

`apps/api/package.json`: add `"\\.db\\.spec\\.ts$"` to `jest.testPathIgnorePatterns` (create the
array with `"/node_modules/"` if absent); scripts `"test:db": "jest --config jest.db.config.js"`
and `"db:drift": "node scripts/schema-drift.mjs"`.

```ts
// apps/api/src/common/testing/db-spec.ts
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);
export function requireLocalDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DB-backed specs need DATABASE_URL — run `npm run local:test:db`");
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && env.RUN_DB_SPECS !== "ci") {
    throw new Error(
      `Refusing to run DB-backed specs against non-local host ${host} (set RUN_DB_SPECS=ci only in CI)`,
    );
  }
  return url;
}
export function describeDb(name: string, fn: () => void): void {
  (process.env.RUN_DB_SPECS ? describe : describe.skip)(name, fn);
}
```

`db-lane.db.spec.ts`: `describeDb("db lane", …)`; build the client exactly as
`prisma.service.ts` does (`new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString })) })`
— read that file for the precise imports/options); `$queryRaw` `SELECT 1::int AS one` →
`toEqual([{ one: 1 }])`; `afterAll` disconnects the client and ends the pool.

### p5 — root scripts + compose comment (Sonnet)

Root `package.json`: read how `local:seed` composes `DATABASE_URL` for the compose Postgres and
reuse that exact expression: `"local:drift": "<same env prefix> npm run db:drift -w apps/api"`,
`"local:test:db": "<same env prefix> cross-env-or-same-mechanism RUN_DB_SPECS=local npm run test:db -w apps/api"`
(use whatever mechanism `local:seed` uses for env on Windows/POSIX — do not introduce a new
dependency; if `local:seed` uses a node wrapper script, extend that pattern). Append
`&& npm run local:drift` to `local:validate`. `docker-compose.yml`: one comment line on the `api`
service: `# Schema is applied only by the one-shot 'migrate' service — the API never runs DDL.`

### p6 — CI workflow (Sonnet)

`.github/workflows/db-migrations.yml`: after the `prisma migrate deploy` step add
`- name: Schema drift (history → datamodel)` running `node apps/api/scripts/schema-drift.mjs`
with `env: DATABASE_URL: <the same service URL the deploy step uses>`; then
`- name: DB-backed specs` running `npm run test:db -w apps/api` with the same `DATABASE_URL` and
`RUN_DB_SPECS: ci`. Extend `on.pull_request.paths` with the six patterns in R7; add
`workflow_dispatch:` if missing. Steps only — no new job.

### p7 — docs, code map, IMPROVEMENTS status, lesson (Sonnet @ low)

Exactly the edits in R8. For the lesson use the register's existing entry format (read two
neighbouring entries first), id `L-052`, the draft text in `spec.md` tightened to ≤ 1,000 bytes,
category `process`; update `_meta.json` (`nextId: 53`, `activeCount: 30`, `updatedAt` ISO now).
Code-map: surgical entry edits + `_meta.json` `mappedSha` = current HEAD short SHA,
`generatedAt` = now; never regenerate the map.

## Verification commands

- `perRound`: `npx tsc -p apps/api/tsconfig.build.json --noEmit` · `npm run lint -w apps/api`
- `final`: `npm run verify`

## Mutation probe

See the table in `./test-plan.md` (four targets; every target probed — R1/R2/R3 are HIGH-risk).

## Deviation policy

A package that finds the plan wrong (a third DDL site, a `prod-migrate.mjs` shape that differs
from :22-41, a `local:seed` mechanism the plan did not anticipate, a missing `workflow_dispatch`)
stops at the gap and reports it as a finding with file:line — it does not improvise.

## Post-run fix round (Fable rulings, 2026-09-03)

- F1 schema-drift.mjs: `underTest` keys on `JEST_WORKER_ID` + `SCHEMA_DRIFT_PRISMA_CLI`, never `NODE_ENV` (CI job env `NODE_ENV: test` armed the stub); new `--local` mode (DATABASE_URL only, non-local hosts refused) so `local:drift` cannot inherit Railway proxy vars.
- F2 railway-db-url.mjs: `resolveDatabaseUrl(env, { requireProxy })`.
- F3 prod-migrate.mjs: `requireProxy: true` (hard-fail restored on a partial proxy env); post-apply drift failure message states migrations were APPLIED.
- F4 db-spec.ts: `RUN_DB_SPECS=ci` bypass deleted (dead — CI's host is localhost); `describeDb` throws when `RUN_DB_SPECS` is unset instead of skipping (steps>0).
- F5 root scripts: `local:drift` uses `--local`.
- F6 legacy raw-DDL scripts under `apps/api/scripts` deleted when unreferenced (deprecation header otherwise).
- F7 no-runtime-ddl.spec.ts: comments stripped before matching; scan extended to `apps/api/scripts/**`.
- F8 T3(h) made network-free (≤ 10 s).
- F9 schema.prisma "Runtime-provisioned tables" comment corrected (comment-only; released from the run's prisma/** constraint by the planner).
- F10 root `local:*` scripts made cross-platform via `scripts/local-env.mjs` (npm runs scripts under cmd.exe on Windows; `VAR=val sh -c` prefixes failed for seed/validate/validate:features/test:db/drift — verified by execution); `docker-compose.yml` gives `REDIS_COMMANDER_PASSWORD` a throwaway default; ADR 0001 runbook note corrected. Scope note: pre-existing #606 defect that the new scripts inherited by design; fixed here because the local gate is the program's pre-PR gate on the owner's machine (L-008 surfaced, owner authorization stands).
- Dismissed: `(gate-command)` "npm run verify red on baseline" — environmental (turbo replayed `test` without regenerating `.campaign/runs/*.json`; the final gate executed 5,012 tests green). Not this PR's defect; noted in the PR body as a local trap.
