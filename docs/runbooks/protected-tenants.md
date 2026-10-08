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

Check the list without writing anything:

```bash
node apps/api/scripts/lib/live-target-guard.cjs --check
```

It prints counts only (`N configured · M matched a tenant`) and exits 1 when a configured slug
matches no tenant (a typo protects nothing).

## What the guard does

- Multi-tenant writers skip protected tenants and print a count per arm.
- Single-target writers (the fresh-start wipe, the b294 apply, the subscription reconciliation)
  refuse a protected tenant in every mode. An owner-approved override needs all of:
  `--allow-protected <tenantId>`, `--backup-taken`, a real terminal on **both** stdin and stdout,
  and the typed phrase `ALLOW PROTECTED <tenantId>`. The phrase has no argv or environment form.
- `--allow-paying-tenant` and `--confirm-paying` are retired and are unknown arguments.
- `apps/api/src/common/scripts-live-target-guard.spec.ts` fails the build when a script that
  opens a database connection neither calls the guard nor is on its exempt list with a reason.

## Reserved slugs

Self-signup and platform-admin create answer 400 for the test-tenant slug patterns, so a real
tenant can never be created on a slug the test allow-lists key on.
