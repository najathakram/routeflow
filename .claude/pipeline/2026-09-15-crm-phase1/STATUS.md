# CRM cloud session status

**2026-09-15 ~21:10Z** · session `routeflow-62` · branch `feat/crm-phase1` · run dir
`.claude/pipeline/2026-09-15-crm-core-phase1/`

**Engine: `02d58b81…`, 224,133 B, `node --check` passes, worktree clean.** Not `b71f6c8e`.

| Stage | State |
|---|---|
| S0 triage · S0.5 pack · S1 discovery | done |
| **S2 spec** | **done — 33 requirements, PASS** |
| S3 UX + design-system derivation | next |
| S4 test plan · S5 build plan | after S3 |
| S6 approval | **your "S5 approved" gates every code push** |

## S2 outcome

33 requirements (32 MUST, 1 SHOULD), each with a priority and a verification method, six of them
negative. Full lifecycle sweep, nine states across three surfaces, a deploy-day gate table and a
rollback story. **One material correction and one new ruling needed.**

### A4 is REFUTED — conversion CAN 403, and I verified it myself

S1 assumed, and the plan implied, that the customer soft-cap gate always fails open. It does not.
`assertCustomerCapNotExceeded()` (`customers.service.ts:625-664`) fails open on lookup errors and
on the breaching create — but when the tenant is **over cap and `graceStartedAt` is older than
`GRACE_DAYS`**, it throws `ForbiddenException(buildPlanGateBody("meter.customers"))`.

So `POST /crm/leads/:id/convert` can return 403 on a cap a rep has no visibility into. R20 requires
the plan-gate body to pass through **unchanged**, with the lead untouched and no `User` minted, so
the rep sees the real upgrade prompt rather than a generic failure. The gate is customer-only, so
CSV lead import (R22) runs none of it. **This is a behaviour change you should be aware of, not a
footnote.**

### The grant-path trap is real

`AddonGuard` reads the raw `TenantAddon.addonKey` and `enableAddon` upserts it raw, with no SKU
check for `crm_core` — so the key the gate reads is the key the grant writes. **But** the
platform-admin panel offers a hardcoded `AVAILABLE_ADDONS` list
(`apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx:103`) and `crm_core` is not in it —
nor, as it happens, is `crm_gohighlevel`. Without R28 the addon is grantable **by API only**.

### A3 confirmed — convert takes no body

`CreateCustomerDto` requires only `username`, `businessName`, `contactName`; everything else is
optional. A lead satisfies all three (`username` derived server-side the way `CustomerFormModal`
already does it), so no fill-in-the-gaps modal is needed. The only optional body is
`{existingCustomerId}` for the dedup "link to existing" path.

### Two assumptions killed at S2 review (I verified both)

- **A10** — `RolesGuard` honours a two-role `@Roles`: `auth/guards/roles.guard.ts:50` is
  `requiredRoles.some(r => satisfied.includes(r))`, and `users.controller.ts:34` already ships
  `@Roles(OPERATOR, TENANT_ADMIN)`. R23/R24 are safe. (Note the guard is under `auth/guards/`, not
  `auth/` — the spec cited the wrong path and it is fixed.)
- **A9** — web nav can read active addons: `useHasAddon`/`useTenantAddons` are already imported in
  `app/(dashboard)/layout.tsx:73-74` and used at `:1060` for sales agents. React-query dedupes on
  queryKey, so CRM adds no extra fetch. R27 now also requires the **existing skeleton-placeholder
  pattern** while the addons query is in flight or errored — a gated nav entry must never pop in
  or out.

## Q4 — a new ruling I need from you

Your #6 ruling was "clear `ownerUserId` only when the owner's own assignment is cancelled,
re-derive otherwise". That is unambiguous for a **non-owner** unassign. It is ambiguous for the
case it names: **the owner's own assignment is cancelled while other assignees remain.**

I encoded **re-derive to the newest remaining assignee, else null** (R10), because it follows from
"owner is a projection of most-recently-assigned" and it avoids a lead silently losing its owner
while people are still on it. R9 separately pins the upstream wrinkle test by name. **One assertion
flips if you rule null instead.** Please rule.

## Still open

- **#12** phone normaliser placement — none exists; R21 normalises both sides at query time either
  way, since stored `Customer.phone`/`mobile` are raw.
- **#13** advisory-lock family name — **R19 cannot ship without it**: `withAdvisoryLock` throws on
  an unregistered family, so "name pending" is a real blocker by S5, not a nicety.
- **Q1** has `routeflow-hq` merged · **Q2** prospect count N · **Q3** second gate for nav.

## Compliance

No code written. No bug or lesson id minted. No host-heavy step attempted. No PR. Docs-only pushes.
Test-tenant policy and the no-live-client-identifier rule observed.

`spec.md` is 16,429 B against a 16 KiB target I set myself — 45 bytes over, left alone rather than
cutting content to hit a number I invented.
