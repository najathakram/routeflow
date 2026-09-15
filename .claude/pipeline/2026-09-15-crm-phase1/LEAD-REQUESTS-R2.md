# Lead requests — round 2 (CRM cloud session)

> Split into its own file to keep each round cheap to push from the cloud container; `LEAD-REQUESTS.md`
> holds rounds 1 and 1b (#1–#11). This file is #12 onward. Same channel, same rules.

## 2026-09-15 · acting on your #1–#9 replies — all binding, three premises need correcting

Engine re-verified on this worktree: **`02d58b81…`, 224,133 B, `node --check` passes.** `b71f6c8e`
will not be run. Recorded in `s0-triage.md`'s addendum along with every ruling below.

A note on how the engine drift surfaced, because it is a trap for any cloud lane: your engine commit
landed *after* this container's checkout, and `git reset --mixed` does not touch the working tree —
so HEAD moved to the E10 engine while the file on disk stayed at `b71f6c8e`. A bare `sha256sum`
would have cheerfully confirmed the stale value. What caught it was `git status` showing
`pipeline.js` as modified. **Verify the engine from the worktree AND require a clean tree**, or the
sha check proves nothing. Worth a line in CLOUD-BRIEF for the next lane.

**#9 answered — BUYER and DRIVER see no CRM, and not merely by having no screen.** Both are omitted
from every CRM `@Roles` list, so they 403. Full matrix in `s0-triage.md`. A lead is pre-customer
commercial data — who a tenant is courting, at what price, why they were lost — so a driver seeing
it is a PII leak and a buyer seeing it exposes a tenant's pipeline to the businesses inside it.
**The test asserts 403, not an empty 200**: an empty list is indistinguishable from "no leads yet"
and would quietly become a leak the day scoping changes. Field-sales reps are `OPERATOR`s, which is
the role the Expo `(operator)` screens already use, so nothing needs granting.

**12 — There is no existing phone normaliser to reuse. Your #7 premise does not hold.** You said
"with the same normaliser the customers module already uses — find it, don't write a second one."
I looked properly and there isn't one:
- `apps/api/src/customers/` writes `phone`/`mobile` **verbatim** from the DTO
  (`customers.service.ts:533,536` on create; `:748,758` on update), and customer search is a raw
  `{ phone: { contains: q, mode: "insensitive" } }` (`:139`, `:1739`).
- Nothing in `apps/api/src/common/` or `packages/`. A repo-wide grep for digit-stripping
  (`replace(/\D/`, `replace(/[^0-9]/`, `normalizePhone`, `digitsOnly`, …) returns only unrelated
  slug and number formatting in `apps/web`.

So writing one **creates** the first, not a second. **Request: confirm I may add exactly one**, and
where you want it to live — my recommendation is `apps/api/src/common/phone.ts`, exported for
reuse, with a code-map note that it is now *the* normaliser. (It is not money, so it does not belong
in `packages/pricing`.)

There is a consequence worth your attention: because stored `Customer.phone`/`mobile` are
**unnormalised**, a dedup match must normalise **both sides at query time** — the stored form cannot
be trusted. That means either a functional index on the normalised expression or a tenant-scoped
scan. At Phase 1 volumes a scan inside one tenant is fine, but it is a real decision and I would
rather you saw it now than in a review. I am **not** proposing to backfill or rewrite existing
customer phone data — that is live client data and out of scope.

**13 — `withAdvisoryLock` has no CRM family, and the allow-list is closed.**
`LOCK_FAMILIES = ["order-merge", "cron", "billing", "tenant-mirror"]` (`common/db-locks.ts:105`),
enforced at `:225` — an unknown family throws `TypeError`, deliberately, so a typo cannot stand up
a pool that serialises against nothing. Your ruling was "registered lock names only", which as
written cannot be satisfied: there is no registered CRM name.

The precedent that resolves it: **`customers.service.ts:1374` already takes
`family: "order-merge"` keyed by `customerId`** for advance-payment application — an operation
that is not an order merge at all. So `order-merge` is in practice *the customer-keyed family*.

That leaves a genuine design question I am **not** deciding unilaterally, because it is
architecture and it touches a file carrying a documented pool-sizing derivation:
- **(a)** conversion takes `family: "order-merge"`, keyed on the **lead id**. No file change, no new
  pool. But it puts a lead id into a customer-keyed namespace — safe (the key is
  `hashtext(family), hashtext(key)`) yet semantically muddy for the next reader.
- **(b)** add a `"crm"` family with its own sizing paragraph in the style the file already uses.
  Honest, self-documenting, and costs a small pool plus an edit to a carefully-reasoned file.

I lean **(a)** for Phase 1 — conversion is rare, request-path and short, exactly `order-merge`'s
profile — with a comment naming why the key is a lead id. **Your call, or Fable's if you'd rather
route it there as architecture.** Either way: one lock, no second in-process lock, as CLAUDE.md
requires.

**14 — #10 and #11 are still open** (they landed after your #1–#9 reply). #10 matters slightly: your
"Nest module DI (lesson **L-113**)" ruling repeats the brief's id, but that lesson is **L-115**
(`ARCHIVE.md:308`, the #703/W16 26-minute 502). The real L-113 is the GoHighLevel
`externalSource` column-mismatch lesson — which binds here too, since Phase 1 adds seven models'
worth of new Prisma call sites and `any`-typed mocks would hide exactly that class of bug. The
behaviour you ruled is agreed either way and nothing is blocked; only the citation is wrong, and I
will not mint or amend a lesson id myself.

---

### Status of this lane right now

S0 done, S0.5 done, **S1 discovery running** (Fable 5.1 `high`). S2 starts when it lands and will be
specced from `spec-leads-deals.md` directly. #12 and #13 want answering before S2 freezes; nothing
else is blocked. No code written, no ids minted, no host-heavy step attempted, no PR.
