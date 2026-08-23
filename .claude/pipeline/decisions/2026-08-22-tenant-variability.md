# Tenant variability doctrine — how per-tenant differences enter this codebase

**Date:** 2026-08-22 · **Author:** platform architecture (Fable 5), ratified by the owner · **Status:** BINDING for all future feature work, client requests, and pipeline plans. Every plan that introduces a per-tenant difference must name the rung it uses and why a lower rung could not express it.

**The one-sentence rule: one trunk, one build, one deployment — every difference between tenants is DATA, not code.**

This is not aspiration; it is the current state (verified 2026-08-22: zero `slug === "…"` branches exist in app code) and this document exists to keep it that way as tenant count grows.

---

## Never do these

| Anti-pattern | Why it is fatal |
| --- | --- |
| A branch/fork or separate build per tenant | N codebases; every security fix becomes N fixes; the classic death of a SaaS company. |
| `if (tenant.slug === "acme")` anywhere in app code | Uncountable, undeletable, untestable customization. The test suite cannot run "as acme". |
| A flag named after a tenant (`flag.acme_special`) | A fork smuggled into a flag. Flags name **capabilities**, never customers. |
| Schema columns that only one tenant uses, named for their business | Schema is shared; model the *general* concept and configure the specific one. |

## The ladder — always take the LOWEST rung that can express the requirement

| Rung | Question it answers | RouteFlow mechanism | Cost |
| --- | --- | --- | --- |
| **1. Entitlement** | "Does this tenant get this capability at all?" | `PlanVersion.featureFlags` ∪ addon `grantsFlags` → `EntitlementsService.hasFlag` / `@RequirePlanFlag` / `@RequireAddon`; sold via plans and `AddonSku`s | One flag + one gate |
| **2. Configuration** | "Same behavior, different values?" | `SystemConfig` (tenantId+key+value; JSON values allowed), e.g. `settings.taxRate`, tier labels | One config key + one reader with a default |
| **3. Strategy** | "Genuinely different logic in ONE slot?" | An interface + named implementations, config selects one — the pattern `payment-provider.interface.ts` already uses | An interface + N small classes |
| **4. Feature-as-data** | "Each tenant defines the feature themselves?" | Custom fields / templates / rules engines (largely unbuilt; the MSRP *segment* stub is a small example of leaving a data-shaped seam) | Expensive once, then zero per tenant |
| **5. Isolation** | "Honestly a different product?" | Separate service/module behind an addon (e.g. `tobacco` module + `@RequireAddon("tobacco_dealer")`) | Last resort |

Escalate a rung only when the one below **cannot** express the requirement — not when it merely feels cleaner. Most requests that arrive sounding like rung 5 are rung 2.

## Two kinds of "flag" — never mix them

| | **Entitlement flag** | **Release toggle** |
| --- | --- | --- |
| Owner | Business (super admin / plan catalog) | Engineering |
| Lifetime | Forever — it is a product SKU | Weeks — deleted after rollout, and the deletion is scheduled work recorded in the plan that introduced it |
| Naming | `flag.<capability>` in the plan catalog | Env var / config, clearly temporary, never in the plan catalog |
| Example | `flag.msrp`, `flag.sales_agents` | a `DISABLE_X_ENFORCEMENT` kill-switch during a rollout |

## Standing rules

1. **Branch on capability, never identity.** `hasFlag("flag.msrp")`, never a tenant name. If a capability is worth building it is worth selling to a second tenant.
2. **Flags default OFF, and the OFF path is the previously-correct path.** A new flag must never make an existing tenant worse. Corollary (learned on MSRP/#411): gate **inside the service on the presence of the new field**, not on shared routes — decorating a shared route 403s un-flagged tenants' ordinary edits.
3. **The server is the authority.** Every gate exists in the API (`@RequirePlanFlag` / service-level `hasFlag`); the UI gate (`LOCKED_PAGE` / `INLINE_RESOLVE` from the `PLAN_GATE` 403 contract) is UX on top, never the enforcement. UI-only gating (as `developer_mode` deliberately is) must be an explicit, documented exception.
4. **Every flag gets an owner and a lifetime decision at birth** — entitlement (permanent, into the plan catalog + `AVAILABLE_ADDONS` so the audited admin toggle works) or release toggle (expiry date written down).
5. **Flag count is a budget.** Each boolean doubles the theoretical state space; keep entitlement flags coarse (one per sellable capability, not per button) and test the combinations that actually ship (each plan's flag set + each addon on/off).
6. **Removing must be as easy as adding.** UI reads key off persisted data (`item.msrp != null`), not off the live flag, so history renders after a downgrade; revoking a flag never corrupts or hides existing records.
7. **Per-tenant *variation* of a flagged feature is rung-2 config**, keyed under the feature's namespace (e.g. `pricing.tierLabels`), read through one accessor with a hard default.

## Triage script for every tenant/client request

Run the request through this, in order; the first match wins:

1. **Would a second tenant plausibly want it?** → It is a capability. Build it once on the trunk behind `flag.<capability>` (+ addon SKU if sellable à la carte). Default OFF.
2. **Same behavior, different value/wording/limit?** → `SystemConfig` key with a default. No flag needed unless the whole feature is also gated.
3. **Genuinely different logic in one well-defined slot?** → Interface + named implementations; a config key selects the implementation per tenant.
4. **A true one-off no one else will want?** → Say no; or reshape it as data (custom field / template); or price it high enough to fund a proper rung-3 implementation.
5. **Never** a branch on the tenant's name, a fork, or a tenant-named schema column.

Worked examples from the 2026-08 requests: MSRP → rung 1 (`flag.msrp` + MSRP addon). Sales agents → rung 1 (`flag.sales_agents`). "Call tiers Retailer/Wholesaler instead of 1–5" → rung 2 (`pricing.tierLabels` in SystemConfig; the tier *mechanism* is unchanged). "50% upfront, 50% net 60" → general payment-terms model (everyone gets it), not a tenant branch. Google Maps addresses → rung 1 if sold, rung 2 for the key/config. Tobacco compliance → rung 5, already correctly isolated.

## Enforcement debt (recorded 2026-08-22)

The catalog defines 11 entitlement flags (`flag.analytics`, `flag.ap_bills`, `flag.api_sso`, `flag.credit_limits`, `flag.dispatch_live`, `flag.forecasting`, `flag.import_integrations`, `flag.pricing_tiers`, `flag.reports`, `flag.returns`, `flag.settlement`) and **none is enforced server-side** — the only live gate is `@RequireAddon("tobacco_dealer")`. Rule 3 says this is a real hole, not cosmetic: plan tiers currently do not exist at runtime. Closing it is planned as its own PR with a prod pre-check (resolve every live tenant's entitlements first; no tenant may lose a surface it uses today without an explicit owner decision) and a temporary kill-switch (a release toggle, with an expiry).
