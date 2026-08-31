# Discovery — destructive endpoint guards (B126, B127)

Status: APPROVED
Date: 2026-08-30
Base: master `6c8f1401`
Scale: MAJOR (tenancy + money + irreversible). ui: false.

## 1. The problem, and whose

Two destructive API endpoints are missing guards their own siblings already have.

- **B126 — cross-tenant.** `DELETE /settings/financial-data` (and its alias `/tenant/settings/…`)
  irreversibly empties the financial tables of **every tenant in the database**, callable by any
  `OPERATOR` token in any tenant. Whose problem: every tenant on the platform, including ones whose
  operator never touched the endpoint. Cost: total, unrecoverable loss of invoices, payments, credit
  notes, vendor bills and purchase orders — the system of record for money owed and money paid.
- **B127 — paid-invoice destruction.** `DELETE /customers/all` destroys PAID/SENT invoices that both
  sibling delete paths (`batchDelete`, and the single-customer path it delegates to) explicitly
  refuse to touch. Whose problem: the tenant that calls it — they lose settled financial history
  that the product elsewhere promises to protect.

Frequency: unknown and irrelevant. Both are single-call, irreversible, and silent on success.

## 2. What they do instead today

Nothing — there is no workaround, because neither defect is visible until after the damage. B126 has
**no caller in `apps/web` or `apps/mobile`**: it is reachable only by a direct API call. That removes
accidental-click risk but not the exposure; a token is all it takes.

## 3. Why now

Surfaced by an internal adversarial audit (bug register rounds 4–5), not by a customer complaint or
incident. There is no evidence either has fired in production. We are fixing them _before_ the first
report, which is the only time this class of fix is cheap.

## 4. If we ship nothing

The exposure stays open indefinitely. B126 is the severe one: a single authenticated call from any
tenant destroys every tenant's financial records, with no undo, no audit trail of what was removed,
and — because backups are periodic — an unbounded recovery gap. This repo has already lost production
data once (2026-08-17, Postgres with no volume attached), so "it would be restored from backup" is
not a comfortable answer.

## 5. Success signal

One observable: a test that calls `clearFinancialData` as tenant A and asserts tenant B's rows still
exist. Baseline today: **no such test exists, and it would fail if written.** Secondary: the endpoint
refuses a non-`TENANT_ADMIN` caller, and `deleteAllCustomers` throws `ConflictException` when a PAID
or SENT invoice exists.

## 6. Who else is affected that nobody asked

Support and finance: after a B126 firing there is no record of what was deleted, so no reconstruction
path. Every other tenant on the instance — they are exposed to a defect in a tenant they have no
relationship with. Whoever runs the restore, who would be reconciling money from a periodic backup.

## 7. Is this a symptom?

**Yes, partly, and this is the important finding.** The root cause is not these two handlers — it is
that tenant isolation is enforced _by convention at each call site_ rather than by the datastore.
`prisma.service.ts` provides `forTenant()` and `tenantTransaction()`, but nothing forces their use,
and **21 migration directories contain zero row-level-security policies** — there is no backstop. Any
handler that reaches for the raw client is unscoped, silently.

⚠️ **Sharper still:** `tenantTransaction` is _not_ a guarantee. At `prisma.service.ts:48` it reads
`if (!tenantId) return fn(rawTx)` — when the caller has no tenant (SUPER_ADMIN), it hands back the
**raw, unscoped** transaction. `forTenant()` documents the same behaviour ("SUPER_ADMIN
(tenantId === null): returns unscoped `this` — full DB access"). So a fix that merely swaps
`$transaction` → `tenantTransaction` would leave B126 fully exploitable for a null-tenant caller.
Any correct fix must handle the null-tenant case explicitly.

Fixing the root cause (RLS at the database) would make this entire bug class disappear. That is a
platform-level project, not this PR. This PR fixes the two known instances and records the root cause.

## 8. Are we solving the problem, or building the picked solution?

The register pre-specified "route through `tenantTransaction` or add `where: { tenantId }`". We are
**not** taking that at face value — see #7: that prescription is insufficient on its own. We adopt it
plus an explicit null-tenant refusal.

## Strongest objection, and the answer

> "B126 has no UI caller. Delete the endpoint instead of hardening it — dead code that can destroy
> the database is worse than no code."

Genuinely the better instinct, and it was considered seriously. **Recommendation: harden, do not
delete**, for three reasons. (1) Removing a route is a breaking API change for any operator scripting
against it; we have no telemetry proving nobody calls it, only that our own front-ends don't.
(2) "Clear my financial data for a fresh start" is a legitimate product capability — tenants
onboarding after a bad import genuinely want it; deleting the feature trades a security bug for a
missing feature. (3) Hardening is strictly safer to review than removal: the diff is additive
constraints, and if we are wrong about callers, a hardened endpoint degrades to a 403 rather than a
404 on a path someone depends on.

Recorded as a non-goal: if telemetry later shows zero calls, deleting it becomes the right follow-up.
