# Handoff — 2026-09-18 · Lane B (platform-admin)

## ▶ START HERE — do these in order, no confirmation needed

1. Check whether PR #899 landed. If it needs rebasing onto current master, do that.
2. B525 — remove the dead `AddonsTab` / empty `AVAILABLE_ADDONS` array. Verify nothing
   references it by searching the codebase; do NOT infer it is unused from the array being
   empty.
3. Do NOT build B524 (server-side `requires` enforcement) — that is Lane D's, in `apps/api`.

Standing rules: do not merge or change repo visibility (the landing coordinator
does that). Push with SKIP_VERIFY=1 SKIP_VERIFY_REASON="…" if the local verify
chain is the blocker; never --no-verify. Ask the lead for any bug registry id —
B525 is taken, B526 is next free; never mint your own. Check free disk before any
full verify or build run (a full run filled the disk twice on 2026-09-17).
Approved test tenants only: test, e2e-routeflow, routeflow-demo, qa-*, e2e-*,
ux-audit-*. Never a live tenant.

- **Task**: B519 — `driver_payments`'s registry `requires: {anyOf: [recurring_routes, order_delivery]}` is declared but unenforced by either live "enable" path. Build the console-side block/warn+confirm; read `requires` from the registry, never hardcode.
- **UPDATE**: owner reversed the wind-down (budget left) — **B519 is DONE, PR open: [#899](https://github.com/najathakram/routeflow/pull/899)**, branch `fix/B519-driver-payments-requires`, pushed via audited `SKIP_VERIFY` (disk pressure, no npm ci/tsc/jest run locally — see PR body for exactly what was and wasn't verified). Everything below this line is the ORIGINAL investigation-only handoff, kept for context/history — the "exact next steps" section is now done, not still pending.
- **Branch/worktree**: `.claude/worktrees/rf-B519-driver-payments-requires`, branch `fix/B519-driver-payments-requires`, pushed. No `node_modules` installed — nothing to strip.
- **Run**: none (bug-pipeline, no pipeline run recorded).

## What I found (ruled in / ruled out)

- **The "old legacy toggle" is dead code.** `page.tsx`'s `AddonsTab`/`AVAILABLE_ADDONS` (~line 102) is now `const AVAILABLE_ADDONS: Array<...> = []` — an empty array, superseded by the Feature Console. Not a real second enable path; don't spend time on it.
- **The two LIVE enable paths** (both confirmed to actually flip `driver_payments` on, by reading `apps/api/src/routes/driver-payments.guard.ts:34-62` — it checks an active `FeatureOverride` GRANT first, then `AddonService.hasAddon`, either one passes):
  1. **Feature Console → "Enable as add-on"** (`_features/FeatureConsole.tsx:378-391` → `_features/EnableAddonModal.tsx`) → `POST .../addons/enable` via `enableTenantAddon()`. This is the "purchased add-on" action the ticket means. Already a genuine two-step confirm (choice → confirm) with an explicit-only Stripe/free choice (no silent default) — that's the console's existing risky-action precedent to match, not the plain single-modal pattern I initially found on the (dead) old toggle.
  2. **`FeatureOverridesSection`'s "+ New Override" GRANT form** (`page.tsx` ~line 1247+, opened via `FeatureConsole`'s "Customise" button too) → `POST .../feature-overrides` (unbilled COMP override). This is the second path that also satisfies the guard.
  Both need the requires-check; they're separate components with separate submit handlers.

## The real blocker (bigger than I first told the lead — correct this)

I told the lead this needed "1 line" in `platform-admin.controller.ts`. That's wrong — it's **two additive changes**, not one:

1. `packages/types/api/features.ts`'s `FeatureRegistryRow` interface (~line 32-46) has **no top-level `requires` field**. There IS a `requires?: string[]` at line 29, but that belongs to `FeatureModeOption` (a different, per-config-mode concept — e.g. `orders_inline_returns`'s mode gating) — not what B519 needs. Need to add `requires?: { allOf?: readonly string[]; anyOf?: readonly string[] }` to `FeatureRegistryRow` itself, matching the shape already on `FeatureDef` in `apps/api/src/billing/feature-registry.ts:89`.
2. `apps/api/src/platform-admin/platform-admin.controller.ts`'s `listFeatureRegistry()` (currently at **line 386**, not the line I originally cited — B522 merged since and shifted it) needs `requires: f.requires` added to its mapped object.

Lead pre-approved me doing the `apps/api` controller line (option a, low-collision, additive). The `packages/types` change wasn't explicitly discussed but is the same category (additive field, shared contract file Lane B doesn't otherwise own) — flag it to whoever picks this up rather than assuming blanket approval carries over.

## Better plan than my original one (found while reading `FeatureConsole.tsx`)

Don't re-derive tenant feature state from raw `addons` + `feature-overrides` fetches client-side (my first plan, before I found `FeatureConsole.tsx`). The console already has a server-resolved, authoritative `effectiveKeys` set (`FeatureConsole.tsx:153`, derived from `effective.filter(f => f.serving)` via `fetchTenantFeaturesEffective`). Use `row.requires` (once it exists) against `effectiveKeys` to compute missing prerequisites — one source of truth, no drift, no duplicate fetching.

## Exact next steps

1. Add `requires` to `FeatureRegistryRow` (`packages/types/api/features.ts`).
2. Add `requires: f.requires` to `listFeatureRegistry()` (`apps/api/src/platform-admin/platform-admin.controller.ts:386`).
3. In `FeatureConsole.tsx`, compute `missingRequires(row.requires, effectiveKeys)` per row (small `allOf`/`anyOf` helper — `allOf`: every key must be in `effectiveKeys`; `anyOf`: at least one must be).
4. Pass the missing-prereqs info (raw keys + resolved labels via `registryByKey`) into `EnableAddonModal` as a new prop. Extend its existing choice/confirm steps with an amber warning + an explicit acknowledgment (checkbox or equivalent) gating "Continue"/"Confirm" when unsatisfied — this is warn-and-confirm, not a hard block, matching the console's existing "explicit only, never silent default" philosophy already used for the Stripe/free choice.
5. Add the equivalent warning to `FeatureOverridesSection`'s GRANT form (`page.tsx`). It doesn't currently fetch tenant effective-features — decide whether to lift `effectiveKeys` from `FeatureConsole`'s parent or give it its own `fetchTenantFeaturesEffective` call. Not decided; pick one and note why in the PR.
6. **Reverse direction (prerequisite later removed while `driver_payments` stays enabled): NOT investigated, NOT built.** Explicitly unhandled — say so plainly in the PR per the ticket's own instruction ("if nothing warns, say so"), don't silently assume it's covered.
7. Server-side enforcement is **B524** (filed by the lead, id already allocated) — `AddonService.enableAddon` and `FeatureOverrideService.create` don't validate `requires` either, so today the endpoints accept an invalid grant from anywhere else even after this UI fix lands. State plainly in the PR body that this is the UI half only, B524 is the enforcement half, and both checks must read the same registry declaration (`FEATURE_REGISTRY[key].requires`) or they'll drift into disagreeing.

## Follow-up: B525 (allocated)

Remove the dead `AVAILABLE_ADDONS`/`AddonsTab` UI in `page.tsx` (~line 102 empty array onward) —
superseded by the Feature Console as of tonight's eight toggle removals. Small, clearly-scoped
Lane B follow-up, separate from B519.

**Before deleting: verify it's genuinely unreferenced, don't assume from the empty array.** The
array being `[]` proves nothing renders from *that data*, not that the surrounding component/JSX
is dead — check for other references to `AddonsTab`, `AVAILABLE_ADDONS`, `showEnableModal`, and
the modal JSX itself (grep the whole file, not just the array declaration) before removing
anything. This is the same class of check that made #866 dangerous — cheap to apply, expensive to
skip.

(Next free bug id after this allocation: **B526**.)

## Report

**Superseded — see UPDATE at top.** PR [#899](https://github.com/najathakram/routeflow/pull/899) is open on `fix/B519-driver-payments-requires`. Not merged. `node_modules` never installed, nothing to strip.

Still open/unstarted: **B524** (server-side `requires` enforcement in `AddonService.enableAddon` / `FeatureOverrideService.create`) and **B525** (delete the dead `AddonsTab`/`AVAILABLE_ADDONS` UI, verify unreferenced first).
