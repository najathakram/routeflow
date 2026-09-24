# Build plan — policy layer phase 1, API (PR-A)

Status: IMPLEMENTED — built inline in the session (the owner-approved dev-pipeline rule arrived after the
build; the verify/verdict/close-out stages ran on the finished tree — see RUN-LOG Deviation).

Preamble: problem = SA-138 §intro · user = tenant admins (writers), every tenant surface (future readers) ·
workaround = none (SystemConfig free text) · success signal = GET /policies lists 3 keys, 0 rows, nothing
changes · non-goals = spec.md · deploy-day = additive, unread; prod migration BEFORE merge (L-184).

Lessons applied: L-072 (enum mirror pinned by enum-parity), L-151 (api imports @routeflow/types as types
only), L-184 (migration before merge), L-187 (DB-enforced single-active considered; SA-138 chose the lock —
raised as an owner question), L-202 (the concurrency proof was made discriminating), L-204 (every writer
invalidates the cache).

### P1 — registry (R1–R2) · `apps/api/src/policy/policy-registry.ts`, `.spec.ts`

### P2 — storage (R3) · `platform.prisma`, `tenancy.prisma`, `split-prisma-schema.mjs`, migration `20260924060000_policy_value`, `enum-parity.spec.ts`, `packages/types/api/enums.ts`

### P3 — resolver + writes (R4–R11, R14) · `policy.service.ts` (+ unit + db spec), `common/db-locks.ts` (`policy-write` family, pool 4) + spec

### P4 — endpoints + carrier (R12–R13, R15) · `policy.controller.ts`, `dto/policy.dto.ts`, `policy.module.ts`, `app.module.ts`, `tenants.{controller,module}.ts`, `packages/types/api/{policies,features}.ts`, `index.ts`

Dependency added: `zod@^3.25.76` in apps/api (already in the lockfile via web/mobile; the `zod/v4` subpath gives `z.toJSONSchema`).

## Verification commands

- perRound: `npx tsc --noEmit -p apps/api/tsconfig.json`; `npx jest src/policy src/tenants/tenants.controller.spec.ts` (apps/api)
- db: `RUN_DB_SPECS=1 DATABASE_URL=<local> npx jest --config jest.db.config.js src/policy` (apps/api)
- final: `JEST_MAX_WORKERS=3 npm run verify`; `npm run local:validate` against the booted dist
