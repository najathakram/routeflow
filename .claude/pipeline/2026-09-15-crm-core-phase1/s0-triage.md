# S0 — Triage: CRM core Phase 1 (leads, timeline, tasks, convert)

Run dir: `.claude/pipeline/2026-09-15-crm-core-phase1/`
Coordination folder (lead's channel): `.claude/pipeline/2026-09-15-crm-phase1/`
Branch: `feat/crm-phase1-core`, cut from `feat/crm-phase1` @ `ad71b74c` (which already has `origin/master` as an ancestor).
Session: cloud session `routeflow-62`. Date: 2026-09-15.

## Engine verification (CLOUD-BRIEF requirement)

| Check | Expected (CLOUD-BRIEF.md) | Measured | Verdict |
|---|---|---|---|
| `.claude/skills/dev-pipeline/pipeline.js` sha256 | `b71f6c8e2a4a4c93fe937e76b7d72d56b3f429a10d49c23aecefe32d7693e789` | `b71f6c8e2a4a4c93fe937e76b7d72d56b3f429a10d49c23aecefe32d7693e789` | **MATCH** |
| size | 212,738 B | 212,738 B | **MATCH** |

> **SUPERSEDED — see the addendum at the foot of this file.** The engine changed after S0 ran;
> the live value is `02d58b81…` / 224,133 B. The table above is the historical record of what S0
> measured at 19:49Z, not a live check.

`local-assets/tooling/STAGED-ENGINE.md` is **not reachable from this session** — `local-assets/` is
gitignored and machine-local, and this cloud container only has `local-assets/plane/`. The sha was
therefore verified against the value the lead published in `CLOUD-BRIEF.md`, which is the same
value the staged-engine doc is supposed to carry. Flagged to the lead in `LEAD-REQUESTS.md`.

The `Workflow` tool **is** available in this environment, so S7 can run `pipeline.js` rather than
a hand-driven subagent fallback.

## Route

`node .claude/skills/model-routing/scripts/route-task.mjs --json` →
`route: "dev-pipeline"`, reason `"non-trivial dev work, no matching lesson/fix-card"`;
`ultracode: off` ("no wide-breadth signal (or bounded)"). Triage default accepted, no override.

Not a bug: there is no observable wrong behaviour, no registry id, no repro. This is new
capability, so `dev-pipeline`, not `bug-pipeline`. Confirmed against the S0 routing rule.

## Classification

| Knob | Value | Why |
|---|---|---|
| `scale` | **`major`** | 7 new Prisma models + 2 column additions, a new Nest module, 3 web routes + a customer-page tab, Expo operator screens, a new entitlement gate, and a migration. Far past the 3-file / new-feature line, and it is irreversible (a migration) and touches tenancy. |
| `ui` | **`true`** | New web screens (`/crm/leads`, `/crm/leads/[id]`, `/crm/tasks`), a new tab on an existing screen, and new Expo screens. ⇒ **S3 mandatory**, `uxSpecPath` + `designSystemPath` both passed, `design-system` lens on. |
| `uiVerify` | **`true`** (object to be filled at S5) | Binding owner ruling 2026-09-15: Playwright proof at 1440/768/390, every state (empty/loading/error/populated), key interactions driven, side-by-side against a neighbouring RouteFlow screen, then an independent visual review. Expo screens get Jest + design review, stated honestly as not browser-proven. |
| `profile` | **`standard`** | `scale: major` alone forces it, and at least one task will declare `risk: 'HIGH'` (see below). `lean` is not available here. |
| `mode` | `feature` | Per `plan.md` §8. |

## Risk register (drives per-task `risk` at S5)

**HIGH-risk** (Opus reviewer + UI judge, `implementHigh` effort, probes on):
- **Tenancy.** Seven new models, every one `tenantId String` NOT NULL (`plan.md` §3 makes the
  invariant hard for new models). Cross-tenant read must be a 404, proven per entity.
- **Lead → Customer conversion.** One transaction, idempotent, advisory-locked on the lead id,
  and it must go through `customers.service`'s create path rather than a raw insert — that path
  owns tier, terms, consent, address. `Customer.userId` is required and `@unique`, so conversion
  creates a `User` too. This is the single densest correctness surface in the slice.
- **The migration.** Additive only; the owner applies it to prod. Squawk (`npm run lint:migrations`)
  gates destructive statements.
- **The `crm_core` addon gate.** Ships `dark`. An unregistered key is treated as `enforced` at
  runtime (fail closed), and `addon-gate-registry.spec.ts` reds `npm run verify` on a missing row.

**Routine** (Sonnet reviewer): list/detail read paths, the tasks CRUD, the timeline read union,
web forms, Expo screens.

## Non-negotiables carried into S1–S5

From `CLOUD-BRIEF.md` and the owner rulings appended to `plan.md`:

1. Behaviour translation **from Frappe CRM source** (supersedes the plan's own clean-room-from-docs
   rules). Licensing is the owner's. Never copy Frappe's look; never vendor frappe-ui.
2. **RouteFlow's existing design system is binding** — no visible style change anywhere. Builders
   map behaviour patterns onto components the repo already has; inventing a token is a defect.
3. Playwright proof + independent visual review for every web UI change; Expo gets tests + design
   review, described as exactly that.
4. Revenue is **accrual net sales**. A deal is a forecast, CRM writes no money fields. Phase 1 has
   no deals, so this binds insofar as nothing in this slice may write a money column.
5. No production anything. Test tenants only (`test`, `e2e-routeflow`, `routeflow-demo`, `qa-*`,
   `e2e-*`, `ux-audit-*`). No live client identifiers — `acme`-style placeholders.
6. New Nest module must import the modules its providers need (lesson on boot crashes) and must not
   collide with the existing GoHighLevel `crm` module.
7. Bug ids and lesson ids come only from the lead. Never mint.
8. Code-map rows and lesson entries land in the **same PR** as the code (the brief overrides the
   repo-default Bookkeeping Option B, which is public-window-deploy only).

## Stage plan from here

| Stage | Status |
|---|---|
| S0 triage | this file |
| S0.5 repo-side context pack (Sonnet `medium`, read-only, ≤ 8 KB) | done — 8,191 B |
| S1 discovery (`discovery.md`, Fable `high`) | done — PASS, narrowed |
| S2 spec (`spec.md`) | next — specced from `spec-leads-deals.md` |
| S3 UX + design-system derivation (`ux-spec.md`, `.claude/pipeline/design-system.md`) | mandatory, `ui: true` |
| S4 test plan (`test-plan.md`) | every `R#` → ≥1 `T#` with a concrete oracle |
| S5 build plan (`build-plan.md`) + `## Pipeline args` | **summary goes to the lead before any building** |
| S6 approval | lead's "S5 approved" required — this session does not self-approve |
| S7 execute | only after S6 |

Nothing is pushed to a code branch, and no PR is opened, without the owner's word.

---

## Addendum — lead rulings received 2026-09-15 ~21:35Z (binding, supersede the above where they conflict)

### Engine — S0's verification is SUPERSEDED, re-verified

The engine changed after S0 ran. The lead merged the skills-sync branch, so this branch now carries:

| Check | Lead's value (LEAD-REPLIES, and STAGED-ENGINE.md) | Measured on this worktree | Verdict |
|---|---|---|---|
| sha256 | `02d58b813fcbf6a60197cf5773f7b77c513ed67a117ed09cbae4ab3e42044b87` | same | **MATCH** |
| size | 224,133 B | 224,133 B | **MATCH** |
| `node --check` | — | passes | OK |

E10 = every git, script and search call is pinned to the workdir. **`b71f6c8e` (212,738 B) must not
be run.**

How the drift showed up, since it is a trap worth naming: the lead's engine commit landed *after*
this container's checkout, and `git reset --mixed` does not touch the working tree — so HEAD moved
to the E10 engine while the file on disk stayed at the old one. `sha256sum` on disk would have
happily reported the stale value. The check that caught it was `git status` reporting `pipeline.js`
as modified. **Verify the engine from the worktree AND confirm the worktree is clean**, or the sha
check proves nothing.

### Ruled, binding

- **Addon key is `crm_core`**, not `crm`. Feature-grant convention: `^[a-z][a-z0-9_]*$`, no dots.
  Registered `dark` in `apps/api/src/billing/addon-gate-registry.ts` with a **real `@RequireAddon`
  call site** (the registry spec reds `verify` on a row with no live call site). Do not reuse or
  touch `crm_gohighlevel`.
- **Owner-on-unassign: diverge from upstream and fix it.** Clear `ownerUserId` only when the
  owner's own assignment is cancelled; re-derive otherwise. **Pin it with a test that names the
  upstream wrinkle** (spec §2.5, case #35).
- **Lead dedup: email OR phone**, advisory offer only, never auto-merge. **Tenant-scoped match.**
  Email compared trimmed and case-insensitive. Phone normalised to digits — **no shared normaliser
  exists (verified at S1); adding the first one is pending the lead's answer to request #12.**
  Test the phone-only match explicitly.
- **Conversion** goes through the existing customer create path (`customers.service.ts:487`
  `create(dto: CreateCustomerDto)`), creating the `User` exactly as that path already does.
  Idempotent under `withAdvisoryLock` (`apps/api/src/common/db-locks.ts`), **registered lock names
  only** — note the allow-list has no CRM family; see request #13. **Never a second in-process
  lock.**
- **Nest module DI**: `CrmCoreModule` imports every module its providers need — at minimum
  `BillingModule` (the `@RequireAddon` guard) and `CustomersModule` (conversion). Boot is proven by
  the compose gate, which the lead runs before merge.
- **Scope fence confirmed**: sales hierarchy, SLA engine, kanban and everything deal-shaped are
  Phase 2+.
- **Three divergences settled**: status-log `type` resolved per entity; no money column written;
  conversion gated on `stage.isLost` with `status = CONVERTED`.

### Role matrix — answering the lead's open question on BUYER and DRIVER

Phase 1 row scoping is "owner or assignee, plus TENANT_ADMIN/OPERATOR see all". The lead asked
where BUYER and DRIVER land. **Neither gets any CRM access at all**, and the answer is stronger
than "no screen":

| Role | CRM access | Enforcement |
|---|---|---|
| `SUPER_ADMIN` | platform-admin surfaces only; not a tenant CRM user | existing platform-admin separation |
| `TENANT_ADMIN` | full, all rows in tenant | `@Roles` + no owner filter |
| `OPERATOR` | full, all rows in tenant | `@Roles` + no owner filter |
| `DRIVER` | **none** | absent from every CRM `@Roles` list ⇒ 403; no nav entry; no mobile `(driver)` screen |
| `CUSTOMER` (the buyer-portal role) | **none** | same, and the buyer portal gets no CRM route |

Rationale, so it is not re-litigated: a lead is *pre-customer* commercial data — who a tenant is
courting, at what price, and why they were lost. A driver seeing it is a PII and
commercial-confidentiality leak; a buyer seeing it would expose a tenant's pipeline to the very
businesses in it, including their competitors. There is no Phase-1 use case on either side, so the
roles are omitted from the allow-list rather than granted-and-filtered — lesson L-146's point
exactly: `@Roles` is authorization, not scoping, and adding a role is only half a change.
Field-sales reps are `OPERATOR`s, which is the role the Expo `(operator)` screens already use.

**Test obligation**: a DRIVER and a CUSTOMER token each get 403 on `GET /crm/leads`, not an empty
200. An empty list would be indistinguishable from "no leads yet" and would silently become a leak
the day scoping changes.

### Still unanswered

Requests **#10/#11** (the brief's `L-113` for the Nest boot crash is actually **L-115**; the real
L-113 is the Prisma `where`/`data` column-contract lesson, which also binds here) and **#12/#13**
(the missing phone normaliser; the missing CRM lock family). The behaviour the lead ruled is agreed
either way and nothing is blocked; no lesson id will be minted or amended by this session.
