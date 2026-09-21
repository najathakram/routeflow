# CRM cloud session status

**2026-09-21 ~02:50Z** · session `routeflow-62` · branch `feat/crm-phase1` · run dir
`.claude/pipeline/2026-09-15-crm-core-phase1/`

| Stage | State |
|---|---|
| S0 · S0.5 · S1 · S2 · S3 · S4 | done, all artifacts pushed |
| **S5 build plan** | **done — `build-plan.md`** |
| S6/S7 | **not started, per your pause. Idle.** |

## S5 summary

**9 packages, disjoint by file ownership, in 5 waves**, sized for the lean method you specified
(≤ 2 Sonnet `medium` per wave, `high` on anything writing tenant data, then ONE Opus refute-first
review of the whole slice diff and one Sonnet fix round — no Fable in the build, engine not
launched).

```
W1 P1 schema (alone)   W2 P2 module+gate+rules, P6 seeder   W3 P3 leads, P4 activities/tasks/timeline
W4 P5 convert, P7 import   W5 P8 web, P9 mobile   → Opus review → one fix round
```

Every package names its `satisfies` (R#) and `provenBy` (T#). No two packages write the same file —
`layout.tsx` and the platform-admin page are P8's alone, `enum-parity.spec.ts` is P1's alone,
`addon-gate-registry.ts` is P2's alone. Hard lines are stated exactly where guessing would cost
money or tenancy: `tenantId` NOT NULL on all seven models, conversion through
`customers.service.create()` with the cap-403 body passed through unchanged, one advisory lock and
never a second in-process one, `CrmCoreModule` importing `BillingModule`, typed `where`/`data`
assertions rather than `any`-mocked Prisma, and no money column anywhere.

## The blocker that matters now

**This container cannot run a single gate.** CI pins `NODE_VERSION: "24"` in every workflow,
`package.json` requires `node >=24`, `.npmrc` sets `engine-strict=true` — and the highest Node
here is **v22.22.2**. `npm install` refuses with `EBADENGINE`, so there is no `node_modules`: no
`check-types`, no `lint`, no Jest, no `verify`.

I did not force it past `engine-strict`. CI resolves its tree on Node 24; a tree resolved here on
22 may differ, so a green `verify` from it would be a false assurance about what CI will do —
exactly what the owner's law rules out. **Your rule that code pushes carry pasted
check-types/lint/jest output cannot be satisfied from this container at all.** Phase 1 needs a
Node ≥24 host, or another session.

## Still needing your word

- **#13 advisory-lock family — blocks P5 (convert).** `withAdvisoryLock` throws on an unregistered
  family. Borrow `order-merge` keyed on lead id (my recommendation; `customers.service.ts:1374`
  already borrows it for advance payments), or approve a `crm` entry in `LOCK_FAMILIES`.
- **Q4** owner-on-unassign — T27 has the one `toBe(userC.id)` line named as the flip point.
- **#12** phone-normaliser placement — none exists in the repo; T6 assumes `digitsOnly` in
  `lead-rules.ts`.
- **Q1** has `routeflow-hq` merged · **Q2** the off-system prospect count N for the §6 baseline.
- Recorded as your defaults, owner-overridable: **Q5** cap-403 uses the existing plain upgrade copy
  with a follow-up row; **Q6** CALL outcomes reuse mobile's Reached / No answer / Left voicemail.

## Detour, now closed

Between 01:00Z and 02:40Z a second fleet lead re-tasked this session onto B619 and B623, then
retracted it ("misaddressed; a PC builder owns both"). Nothing was pushed and no branch of mine
reached origin, so there is nothing to collide with. Two findings worth keeping:

- **B623 is already fixed on `f3f8dab4`.** Line 1103's `items` is built 17 lines above with
  `tenantId` as its first property under a `B571:` comment, and `inventory.service.ts` is unchanged
  since `4cd486d1`. The T6 CHECK constraint will pass. Whoever owns it should not re-fix it.
- **B619 is real**, and its fix fits entirely inside `merge-items.ts` — `create-order.dto.ts:45`
  already carries `unitLabel` and `findActiveOrder` includes full `lineItems` rows, so
  `orders.service.ts` needs no edit and its size ratchet is safe. There is a second caller the
  brief missed, `buyer.controller.ts:617`.

## Compliance

No code written for CRM. No bug or lesson id minted. No host-heavy step attempted. No PR. Docs-only
pushes. Test tenants and `acme` placeholders throughout. Idle at S5 as instructed.
