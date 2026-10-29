# House seams to reuse, cheap seam patterns, and plaster anti-patterns

Paths were verified on origin/master at `1bf58be42` on 2026-10-08. Trust the code over this file, and fix
this file when the two disagree.

## Reuse these before adding anything

| Need | Reuse | Where |
| --- | --- | --- |
| Behaviour that differs by tenant type | One derived capability answer, read by every rule. Free config modes feed it, and profiles bundle them. | `packages/types/api/fulfilment.ts` (`capabilities.fulfilment`), `apps/api/src/billing/feature-registry.ts`, `apps/api/src/billing/business-profiles.ts`, `packages/types/api/profiles.ts` (`BUSINESS_PROFILE_KEYS`) |
| A new tenant type (for example, jobber) | A new profile row and key, with parity. Never a branch in feature code. | the same two profile files |
| A tenant or user setting | `SETTINGS_REGISTRY`, which has four homes by kind: `policy` (behaviour switches), `systemConfig` (config data only), `userPref` (per user) and `featureConfig` (behaviour modes). A key that is written without a row turns the spec red. | `packages/types/api/settings-registry.ts`, `apps/api/src/system-config/settings-registry.spec.ts` |
| An entitlement gate | The addon gate registry: ships dark, and is enforced only after the blast-radius report. Plan flags go in `DARK_PLAN_FLAGS`. | `apps/api/src/billing/addon-gate-registry.ts`, `apps/api/src/billing/plan-flag.guard.ts` |
| Shared shapes, enums and error codes | `@routeflow/types`: one `X_VALUES` array per enum, pinned by a parity spec (L-072); clients show mapped codes. | `packages/types/api/*.ts`, `packages/types/api/enums.ts`, `apps/api/src/common/enum-parity.spec.ts`, `packages/types/api/error-codes.ts` |
| Money | `@routeflow/pricing` (`computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`); new money helpers go here too | `packages/pricing` |
| The business day and time zone | one resolver, one fallback (SA-738) | `apps/api/src/common/tenant-time-zone.ts` |
| Email kinds | `EMAIL_KINDS` | `apps/api/src/email/email-kinds.ts` |
| Serializing per customer or per key | `withAdvisoryLock`. Never add a second in-process lock. | `apps/api/src/common/db-locks.ts` |
| Scheduled jobs | `@LeaderCron`. Never a bare `@Cron`. | `apps/api/src/common/cron-lock.ts` |
| A structural or inventory pin | the `no-bare-cron` spec pattern, and the size ratchet | `apps/api/src/common/no-bare-cron.spec.ts`, `apps/api/src/common/size-ratchet.spec.ts`, `scripts/size-ratchet-gate.mjs` |
| Tenant scoping and test tenants | `forTenant()`, and the `assertTestTenant` guard | `apps/api/src/prisma/prisma.service.ts`, `scripts/lib/test-tenants.cjs` |
| Schema | the domain files plus `MODEL_DOMAIN`; additive folders, applied in owner sittings | `apps/api/prisma/schema/*.prisma`, `apps/api/scripts/split-prisma-schema.mjs` |

## Where the planned programs live (for G1 and G3)

- The newest `.claude/handoffs/*-WORK-PLAN.md` (§C trains, §D programs, §H Later) and
  `*-BUG-FEATURE-STRATEGY.md` (the clusters to fix as a class). Both are machine-local.
- `docs/product/`: 15 domains, with P0/P1/P2 capabilities. P1 and P2 rows are the future requirements that
  this work may need to fit.
- `.claude/sa/RULINGS.md`, plus the owner-decisions handoff for each round of R rulings.
- `.claude/apple-ux.md`: the UX adapter (jobs and personas) that G7 reasons with.

## Cheap seam patterns: small now, small later

1. **Put the scope key in the unique index.** Make it NOT NULL with a default (for example `'main'`),
   never nullable, because Postgres treats NULLs as distinct in a unique index. A second till, branch or
   surface then needs no key change.
2. **Add an optional parameter that defaults to today's behaviour** (a scope or surface), so existing
   callers do not change.
3. **Namespace keys by context** (for example `quickKeys.counter`), rather than naming a key after a
   feature.
4. **Map behaviour per mode exhaustively over the shared union**, as a `Record` of mode to handler. A new
   mode is then a compile error until it is handled.
5. **Snapshot on the record** the label, price, rate and zone that a past document must show. Write the
   snapshot at creation. Readers never fall back to live data for a past record.
6. **Build identities on the server** (for example, a UUIDv5 of the owning ids) for anything that replays,
   storage or another system keys on.
7. **Route every state transition through one function** that sets and clears the dependent fields in
   the same transaction, with a pin over every writer of that status.
8. **Give a list endpoint pagination and server search from day one**, so no picker has to fetch
   everything.
9. **Keep every cap as one named constant**, in one module, with its reason. It becomes a setting when a
   real tier needs it.
10. **Make a server-ready record shape** (an id, the owner ids, timestamps and an actor) for state that
    starts on one device, so moving it to a table later is an S change.

## Plaster anti-patterns (each is a FAIL in review)

- **Branching on identity.** Code like `if (profile === …)` or `if (slug === …)`, or a raw mode read at a
  call site.
- **Copies that drift.** A predicate copied to a second call site (L-167). One figure computed from two
  different collections (L-119).
- **Unregistered values.** A literal cap repeated in several places. A setting written without a
  `SETTINGS_REGISTRY` row.
- **Device-local business state.** Business state in `localStorage` or `sessionStorage` without an
  owner-approved expiry. Per-device UI chrome, such as a collapsed panel, is fine there.
- **A second writer.** A backfill SQL or a script UPDATE beside the service function (SA-736).
- **Trusting the client.** Trusting an identity or figure the client supplied; the server recomputes
  (SA-749, SA-750).
- **Unsafe defaults.** An environment fallback applied at the call site; an unknown outcome or zero
  targets counting as a pass (SA-756, security spec (private); L-202).
- **Rules keyed on a label.** A rule keyed on a reason string or a label instead of the state of record
  (SA-733r).
- **Interims with no expiry.** A display-only interim with no expiry and no follow-up row.
- **Redeclared shapes.** An enum or DTO redeclared in a client (L-072).
