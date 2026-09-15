# Discovery — why CRM core Phase 1

**Status:** `DRAFT` · **Stage:** S1 · **Author:** Fable 5.1 · **Date:** 2026-09-15
**Next:** [spec.md](./spec.md) after the STOP GATE.

> **Verdict: PASS, narrowed** — an option with a kill criterion (§6), not a six-phase
> commitment; demand evidence is n=1 plus the owner (A5).
> Binding: test tenants only (`test`, `e2e-routeflow`, `routeflow-demo`, `qa-*`, `e2e-*`,
> `ux-audit-*`); `routeflow-hq` = owner's dogfood call; `acme` placeholders; house design
> system, behaviour only; **no money column** (revenue = accrual net sales); addon key
> **`crm_core`**.

## 1. Problem in the requester's words (G1·Q1)

> "Phase 1 (leads + pipeline + timeline + tasks + convert) is the smallest slice a distributor's
> sales rep will use tomorrow, dogfooded on `routeflow-hq`." … "RouteFlow's own pipeline of
> distributors runs in it." — owner plan, 2026-09-15.

**Restated:** RouteFlow has no record for a business that is not yet a customer. Every
`Customer` is a login (`userId @unique`, required), so everything between first contact and
first order lives outside the product. Phase 1 gives that relationship a home (lead + note +
next-step task + status), one-action conversion through the existing `Customer` create path,
and the same core on the operator phone.

## 2. Who has this problem (G1·Q1)

| Role | Frequency | Cost today | Evidence |
|---|---|---|---|
| RouteFlow's own team selling to distributors (`routeflow-hq`) | daily while prospecting | prospects off-system; no next step, history or conversion count (A1) | owner ruling |
| Distributor field rep = `OPERATOR` (also runs routes) | daily: list → call → note → task → status → convert (Frappe §5.1/§5.2) | re-keys the store into `Customer` at first order; prior contact lost | plan §5 (A5, A6) |
| Admin of the GoHighLevel pilot tenant | monthly | pays an external CRM ($97+/mo, A5) seen only as a one-way `CrmHandoff` | `apps/api/src/crm/` (`crm_gohighlevel`, dark) |

## 3. What they do instead (G1·Q2)

- **Create the `Customer` early.** `customers.service.create()`
  (`apps/api/src/customers/customers.service.ts`) mints a `User` (placeholder email, temp
  password), counts against the soft-cap, can start grace; the prospect pollutes every
  customer-scoped list.
- **`Customer.notes` / `CustomerComment`** (`sales.prisma`): one free-text field, one append-only
  table; Customer-only; no type, due date or "mine". **`AuditLog`**: not user-facing.
- **GHL `CrmHandoff`:** external opportunity matched to a Customer; no native record, timeline,
  task or conversion. **Spreadsheet / phone notes** (A1): no dedup, no shared visibility,
  nothing survives conversion; a lost prospect is silent.

## 4. Why now (G1·Q3)

The owner stood up `routeflow-hq` (T12–T15) and RouteFlow's own pipeline needs a home; the GHL
connector proved the need but parked the data outside RouteFlow; the Frappe spec landed
2026-09-15 and the owner ruled. No tenant incident triggered this — recorded honestly.
**Deadline:** none.

## 5. If we ship nothing (G1·Q4)

Own prospects stay in a spreadsheet; the pilot keeps paying a third party and RouteFlow never
owns the pre-customer relationship; `CrmHandoff` stays an adapter with no native target. No
delivery breaks tomorrow. **Cost is strategic and owner-borne** — enough to pass, hence the
kill criterion in §6.

## 6. Success signal (G1·Q5)

| Signal | Baseline | Target | Measured where | When |
|---|---|---|---|---|
| Share of RouteFlow's own live prospects held in `routeflow-hq` as a `CrmLead` (OPEN/QUALIFIED) with a dated next step (open `CrmTask` or `CrmActivity` ≤ 14 days old) | 0 of N; N = owner's off-system prospect count, stated at gate flip (A1) | ≥ 90 % within 30 days of `crm_core` opening on hq, plus ≥ 1 `POST /crm/leads/:id/convert` | one read-only SQL query on `CrmLead`/`CrmTask`/`CrmActivity` for hq, owner runs it on prod, never this pipeline | 30 days after flip |

**Kill criterion:** < 50 % at 30 days → Phase 2 does not open.

## 7. Everyone else affected (G1·Q6)

| Party | Touch | Needs | Consulted |
|---|---|---|---|
| Admin / billing | grants `crm_core` (`Platform Admin → Tenants → add-ons`, per `addon-gate-registry.ts`); no SKU; converts count toward the soft cap (A4) | grant path writes the key the gate reads; dark till flipped | owner |
| `TENANT_ADMIN` / `OPERATOR` | new web + `(operator)` Expo screens; see all rows | existing components, no style change | no |
| `DRIVER` / `CUSTOMER` | **no CRM access** — pre-customer data leaks PII and pipeline; 403 on `GET /crm/leads`, never an empty 200 | absent from every CRM `@Roles` list; no nav or screen | lead (ruled) |
| Commissions | convert opens `AgentAssignment` when `salesAgentId` set; `SalesAgent → AgentAssignment → CommissionAccrual` untouched | specs green | no |
| GHL pilot tenant | untouched in Phase 1; adapter in Phase 2 | no `crm_gohighlevel` collision | owner |

Support gets "why no CRM" (gate) and "convert made a login" (two doc lines); CSV import reuses
`apps/api/src/import/`; the owner is first user and maintainer.

## 8. Root-cause check (G1·Q7, G1·Q8)

- **Cause, not symptom:** "we need a CRM" is solution language; the cause is *no pre-customer
  entity and no dated next step*. Phase 1's core (lead, note, task, status, convert, email-or-
  phone dedup, mobile call-and-log) fixes that cause.
- **Alternative:** nullable `Customer.userId` / a PROSPECT status on Customer. Rejected:
  Customer owns tier, terms, consent, address, soft-cap, grace and every customer-scoped
  denominator; a prospect there leaks everywhere.
- **Frappe-because, not rep-because** (recorded, not re-litigated): (1) `CrmPipeline` +
  `CrmPipelineStage` with probability for *leads* — four statuses suffice, probability is a deals
  idea, the editor is Phase 3: seeded defaults only. (2) `CrmLeadSource` table — an enum
  covers Phase 1. (3) `CrmSettings` — no Phase 1 knob. (4) `Message`-thread union in the lead
  timeline — no provider before Phase 4.
- **Prior art:** `apps/api/src/crm/` (GHL), `apps/web/app/(dashboard)/suppliers/page.tsx`.

## 9. Riskiest assumptions (G3·Q1) and the hostile reviewer (G3·Q4)

| # | Assumption | If wrong | Cheapest kill | Cost | Result |
|---|---|---|---|---|---|
| A1 | hq operators enter prospects on day one | signal unreadable | ask owner: prospect count, where, moved at flip? | 5 min | pending |
| A2 | `routeflow-hq` (T12–T15) on master first | no dogfood tenant | lead, `LEAD-REPLIES.md` | 5 min | pending |
| A3 | lead fields satisfy `CreateCustomerDto` | convert needs a modal | read `apps/api/src/customers/dto/create-customer.dto.ts` at S2 | 10 min | pending |

**Strongest objection:** "Seven tenant-scoped models, an irreversible migration, a new Nest
module, web and Expo screens — for a feature no paying tenant asked for, in a delivery product.
The one tenant that wanted a CRM got the GHL connector. This is the owner building his own
sales tool and calling it a product feature."
**Answer:** the gap is structural — RouteFlow cannot represent a business before it is a login,
which is why the GHL connector had to be a one-way match-to-Customer with data parked at a
vendor; a connector with no native target is a dead end. The distributor sale is a field sale
by the operator who runs the route: "customer before first order" for users already in the
app. Exposure is contained (additive migration, dark gate, `local:validate` untouched); hq
dogfood is the cheapest demand test and §6's kill criterion stops the roadmap on a miss.
"Nobody asked" is true and carried as A5. Also: convert mints a `User` as every Customer create
does; the timeline union is per record, page-capped at S2.

## 10. Non-goals

- Deals, kanban, saved views, weighted pipeline, lost reasons — Phase 2. Assignment rules,
  hierarchy, multi-contact leads, stage/source admin, comment backfill, bulk/export — Phase 3.
  Email, telephony — Phase 4. SLA, dashboard — Phase 5. Web-to-lead — Phase 6.
- No Frappe look, no frappe-ui, no new token. No money field. No GHL retirement or SKU change; no
  `crm.prisma`. No prod action; no seed off approved tenants. Dedup is advisory.

## 11. Open questions

| # | Question | Unblocks | Blocking S2? | Assumption |
|---|---|---|---|---|
| Q1 | Has hq (T12–T15) merged to master? | §6 target | no | yes (A2) |
| Q2 | Owner's off-system prospect count N | §6 baseline | no | recorded at flip (A1) |
| Q3 | `DARK_PLAN_FLAGS` entry (`plan-flag.guard.ts`) for nav too? Plan §5 said `flag.crm`. **Premise corrected at S1 review:** the lead's no-dot rule governs ADDON keys, not plan flags — all seven existing flags are dotted (`flag.analytics`…, `plan-flag.guard.ts:21-29`), plus `flag.msrp` outside the set. So `flag.crm` is *permitted*; the question is whether a second gate is *wanted* | gate shape | no | addon only (A7) |

## 12. Assumptions (unverified)

| # | Claim (§) | Basis | Would confirm | Breaks if wrong | Status |
|---|---|---|---|---|---|
| A1 | §2/§6 hq tracks prospects off-system, will move them in | inferred | Q2 answer | signal, §5 | unverified |
| A2 | §6/§11 hq tenant on master | plan §5 | `LEAD-REPLIES.md` | dogfood target | unverified |
| A3 | §9 lead fields satisfy `CreateCustomerDto` | pack | read the DTO | conversion scope | unverified |
| A4 | §3/§7 soft-cap fails open; convert never 403s | pack | read `customers.service.ts` create | conversion UX | unverified |
| A5 | §2/§5 pilot pays $97+/mo for GHL; no paying tenant asked for native CRM | plan §2/§4 | owner | §5, §9 | unverified |
| A6 | §2 reps prospect daily along routes | industry norm | pilot interview | mobile weight | unverified |
| A7 | §11 addon gate alone, no plan flag | **choice, not a constraint** — one grantable key is simpler and the addon gate already drives screen visibility; `flag.crm` is available if the lead wants nav gated separately | lead | nav gate | unverified |

## STOP GATE — S1 → S2

| Stop condition | Evaluated? | Answer | Evidence | Verdict |
|---|---|---|---|---|
| Shipping nothing is materially bad | yes | strategic, owner-borne; kill criterion set | §5, §6 | pass |
| Cause, not symptom | yes | reframed; core is the cause; 4 Frappe-only items flagged | §8 | pass |
| User, workaround, signal stated | yes | yes; frequencies hedged in §12 | §2, §3, §6 | pass |
| Blocking questions answered | yes | none block S2; A1–A3 die before S5 | §11 | pass |

- **Gate outcome:** PASS — S2 may start · **Carried into S2:** A1–A7 · **Approved by:** pending owner/lead
