# Runbook: flipping `TENANT_CONTEXT_ENFORCE` (SA-619)

`TENANT_CONTEXT_ENFORCE` unset/false = **dark** (a missing tenant context warns and is counted). `true` or `1` =
**enforced** (the same events throw `TenantContextMissingError`). The flip is the owner's, after the evidence below.

## Before the flip (evidence)

1. **72 hours of zero `MISSING` and `SUPER_ADMIN_CREATE` warns, from EVERY replica.** The guard counters are
   per-process: read the `TENANT_CONTEXT_STATS` log line of each replica (default every 15 min;
   `TENANT_CONTEXT_STATS_LOG_MS`, allowed 60000..2147483647, 0 disables) and `GET platform-admin/tenant-context/stats`
   per instance. One quiet replica proves nothing about another.
2. **Blast radius of old NULL-tenant rows:** `node apps/api/scripts/report-619-superadmin-creates.mjs`
   (read-only, count-only; owner-run through `railway run --service postgres`). Rows with `tenantId IS NULL` on the
   nullable-tenant models are what a SUPER_ADMIN or context-less create wrote; the flip does not refuse deliberate
   platform rows (an explicit `tenantId: null`).
3. **Nested writes:** in ENFORCED mode the `NESTED_*` counters undercount (the walker throws before it reports);
   the stats are authoritative for dark mode only.
4. `npm run verify` green on master (the rehearsal spec `apps/api/src/prisma/enforce-flip-rehearsal.spec.ts`,
   the two inventories in `apps/api/src/tenant/base-client-write-inventory.spec.ts`, the `forSystem` /
   `systemTransaction` allow-lists).

## The flip-day casualties (what would 500 once the flag is on)

Each is asserted to throw by the rehearsal spec; none exists in the source today, so a new one is a code review
finding, not a surprise in prod logs:

1. An **anonymous** caller using `forTenant()`.
2. A **context-less** caller using `tenantTransaction(...)`.
3. An **anonymous** caller using the **array-form** `$transaction([...])` (the shape the guard cannot see through;
   the three live anonymous callers moved to `systemTransaction`).
4. A **SUPER_ADMIN** create on a tenant-owned model with **no `tenantId`**.
5. A **`systemTransaction`** create on a tenant-owned model with **no `tenantId`**.

The way out is always the same: pass the explicit `tenantId` (or `tenantId: null` for a deliberate platform row), or
use the explicit door (`forSystem("<reason>")` / `systemTransaction("<reason>", fn)`; the reason is a string literal
on an allow-list). `forTenant().$transaction(...)` always throws: use `tenantTransaction`.

## Array-form callers (classified, no conversion needed)

Seven `$transaction([...])`-shaped callers remain (products, route-optimization x3, routes, suppliers, import). Every
promise in each batch is built with `forTenant()`, inside a request that already passed `forTenant()`'s own context
check. The array override reports only a context-less (ANONYMOUS / no context) caller; TENANT, SUPER_ADMIN and SYSTEM
pass. A scan pins exactly these seven.

## Flip, watch, roll back

The flag is read **ONCE, at process boot** (`readEnforceFlag()` when the guard is constructed). Changing the variable
does nothing until the process restarts, so both the flip and the rollback need a **redeploy / restart**. Railway
environment variables are shared by every replica of a service, so there is no "one replica first": the whole service
flips together.

1. Set `TENANT_CONTEXT_ENFORCE=true`, redeploy, and watch 5xx and the stats line on every replica.
2. Roll back by unsetting it (or `false`) and redeploying; no code change is needed, but it is a deploy, not an instant switch.
3. The shrink-only inventories (base-client creates, raw-SQL writes) are follow-up work, converted one service per
   commit with owner review; they are not flip blockers.
