# Protected tenants (live-script guard)

A new trial tenant is not "paying" and has no Stripe subscription yet, so the paying and Stripe
arms of `apps/api/scripts/lib/paying-tenant.cjs` cannot protect it. Every script that can write to
a database therefore also honours an operator-supplied list.

## What is protected

A tenant is **protected** when any one of these is true (`protectedArm`):

| Arm             | Rule                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `paying`        | ACTIVE, not deleted, PRODUCTION class, has a plan (the MRR paying set)   |
| `stripe-linked` | not deleted and its subscription carries a Stripe subscription id        |
| `env-listed`    | its slug is in `PROTECTED_TENANT_SLUGS` (matches even when soft-deleted) |

## Setting the list

`PROTECTED_TENANT_SLUGS` is a comma-separated list of slugs, set on the shell or Railway variable
that the script runs under. Never write the slugs into git, a PR, a test or a log.

- Unset, and the database the script will dial is not provably local: the script **refuses to
  start**. State the list, or state `""` to say that none exist.
- `""` (set, empty): explicitly none.
- Set: always applied, even when the target looks local (a tunnel can make production look local).
- An invalid entry, a test-pattern slug (`test`, `qa-*`, `e2e-*`, `ux-audit-*`, the approved test
  tenants) or a duplicate refuses everything. Messages name the entry's position, never the slug.

Scripts that only READ (reports, dry runs) also load the list, so on a non-local database they
need `PROTECTED_TENANT_SLUGS` set too, or `""` to say that none exist. A value that is present but
has no entries (`,` or a blank) is refused as a typo, never read as "none".

Check the list without writing anything:

```bash
node apps/api/scripts/lib/live-target-guard.cjs --check
```

It prints counts only (`N configured · M matched a tenant`) and exits 1 when a configured slug
matches no tenant (a typo protects nothing).

## What the guard does

- Multi-tenant writers skip protected tenants and print a count per arm.
- Single-target writers (the fresh-start wipe, the b294 apply, the subscription reconciliation,
  the Stripe test-id purge) refuse a protected tenant in every mode (the b294 dry run only HOLDS such tenants' rows; it plans
  them only when their id is named with `--allow-protected`). An owner-approved override
  needs all of: `--allow-protected <tenantId>`, `--backup-taken`, a real terminal on **both**
  stdin and stdout, and the typed phrase `ALLOW PROTECTED <tenantId>`. The phrase has no argv or
  environment form. The flag is per tenant and repeatable; there is no bulk form.
- `publish-and-repin.mjs --apply --live` only ADDS grants across every production tenant, so it
  takes ONE confirmation for the whole run: it prints the number of protected tenants per arm
  (never a slug), then needs `--backup-attested` and the typed phrase
  `ALLOW PROTECTED ADDITIVE <count>`. A non-terminal run refuses.
- `--allow-paying-tenant` and `--confirm-paying` are retired and are unknown arguments.
- Destructive local-only scripts (the nuke / reset / cleanup / merge family) trust a host allow-list
  a tunnel can fake, so they ALSO refuse to run when the database holds a protected non-test
  tenant (`assertNoLiveProtectedTenants`; counts only in the message).
- `scripts/repair-integrity.mjs` is retired: it refuses to connect (only `--list` still runs).
- Approved test tenants (`test`, `qa-*`, `e2e-*`, `ux-audit-*`, the approved demo/e2e tenants) need
  no override in the multi-tenant scripts. The fresh-start wipe is stricter: wiping a test tenant
  that is paying-looking or Stripe-linked (even `--local`) still needs the override.
- `apps/api/src/common/scripts-live-target-guard.spec.ts` fails the build when a script that
  opens a database connection neither calls the guard nor is on its exempt list with a reason.

## Reserved slugs

Public self-signup (`/public/tenants/register`) answers 400 for the test-tenant slug patterns
(`test`, `qa-*`, `e2e-*`, `ux-audit-*` and the approved test tenants), so a real tenant can never be
created on a slug the test allow-lists key on, and the availability check reports them taken.
Platform-admin create still allows them (a super admin may create a test tenant on purpose); the
create form and the API response flag them: "This will be a TEST tenant".
