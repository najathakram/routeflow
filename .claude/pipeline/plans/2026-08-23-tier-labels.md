# Plan: tenant-configurable price-tier labels (rung-2 config; no migration, no flag)

> Status: IMPLEMENTED (2026-08-23, autopilot; clean=true, 6 findings fixed, gate green) · Authored 2026-08-23. This file is the ONLY context implementers receive.

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-tier-labels
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree before ANY command; ABSOLUTE paths under the worktree for every file
read/edit. Relative paths here are relative to the worktree root. Branch is already
`feat/tier-labels`; do not commit, stage or push — the orchestrator handles git.

## Objective

A tenant wants tiers NAMED for their business ("Retailer" / "Wholesaler") instead of "Tier 1..5".
Per the binding doctrine (`.claude/pipeline/decisions/2026-08-22-tenant-variability.md`, on master),
this is per-tenant CONFIGURATION: one SystemConfig JSON key, a label helper with a hard fallback,
and swapping literal strings at render sites. The tier MECHANISM is untouched. No schema change,
no migration, no entitlement flag, no branch on tenant identity.

## Work packages

### WP1 — API: config storage + endpoints (files: `apps/api/src/system-config/system-config.service.ts`, `apps/api/src/system-config/settings.controller.ts`, `apps/api/src/system-config/dto/pricing-tier-labels.dto.ts`)

Copy the RemittanceConfig pattern EXACTLY — read `system-config.service.ts` ~L171-200
(`REMITTANCE_KEY`, `getRemittanceConfig`/`setRemittanceConfig`, including its PATCH semantics:
`undefined` = leave untouched, `""` = clear) and mirror it:

- Key `pricing.tierLabels`, value `Record<"1"|"2"|"3"|"4"|"5", string>` stored as one JSON document.
- `getPricingTierLabels(): Promise<Record<string,string>>` (missing key → `{}`) and
  `setPricingTierLabels(patch)`.
- New DTO `pricing-tier-labels.dto.ts`: fields `tier1..tier5` (or `labels` record — match whatever
  shape the remittance DTO uses for consistency), each `@IsOptional() @IsString() @MaxLength(24)`.
- Endpoints on `settings.controller.ts`, mirroring the margin-config posture (read that controller
  ~L467-497 first): `GET /settings/pricing-tier-labels` with `@Roles(OPERATOR, DRIVER)` (drivers
  see priced lines), `PATCH /settings/pricing-tier-labels` with `@Roles(TENANT_ADMIN)`.

### WP2 — shared helper, three mirrors + spec (files: `apps/api/src/common/tier-label.ts`, `apps/api/src/common/tier-label.spec.ts`, `apps/web/lib/tier-label.ts`, `apps/mobile/lib/tier-label.ts`)

One pure function, mirrored identically in all three (repo money-discipline convention — identical
logic, per-platform files):

```ts
/** Configured tenant label for a pricing tier, hard-falling back to "Tier N". */
export function tierLabel(
  labels: Record<string, string> | null | undefined,
  n: number | string | null | undefined,
): string {
  const key = String(n ?? "");
  const custom = labels?.[key]?.trim();
  if (custom) return custom;
  const num = Number(key);
  return Number.isFinite(num) && num >= 1 ? `Tier ${num}` : "Tier ?";
}
```

Spec (`tier-label.spec.ts`, API side): configured name wins; missing/blank/whitespace → `Tier N`;
`null`/undefined/garbage n handled without throwing.

### WP3 — web render sites + settings card (files: `apps/web/lib/api/tier-labels.ts`, `apps/web/app/(dashboard)/settings/page.tsx`, `apps/web/app/(dashboard)/customers/[id]/page.tsx`, `apps/web/app/(dashboard)/products/[id]/page.tsx`, `apps/web/app/(dashboard)/products/page.tsx`, `apps/web/app/(dashboard)/estimates/page.tsx`)

1. `apps/web/lib/api/tier-labels.ts`: a `useTierLabels()` React Query hook GETting
   `/settings/pricing-tier-labels` (staleTime generous — labels change rarely) and a
   `useUpdateTierLabels()` mutation. Follow the conventions of an existing small settings hook in
   `apps/web/lib/api/`.
2. Swap literal "Tier N" render strings for `tierLabel(labels, n)` at: the customer tier picker on
   `customers/[id]/page.tsx`, the product `priceTier2..5` labels on `products/[id]/page.tsx` and
   the products list quick-edit column (`products/page.tsx`), and any tier text on
   `estimates/page.tsx`. THEN grep `apps/web` case-insensitively for `Tier ` and sweep remaining
   literal tier-name renders (report every file touched; skip files owned by other packages —
   settings/page.tsx is yours, the rest of the grep hits are too unless listed in another package).
3. Settings card on `settings/page.tsx`: "Pricing tier names" — five inputs, placeholder `Tier N`,
   PATCH on save, visible/editable per the page's existing role gating for admin-ish cards (match
   how other TENANT_ADMIN-only cards on that page gate).

### WP4 — mobile read-side (files: `apps/mobile/lib/api/tier-labels.ts`, `apps/mobile/components/CustomerForm.tsx`, `apps/mobile/components/ProductForm.tsx`)

Mirror hook in `apps/mobile/lib/api/tier-labels.ts` (follow an existing mobile settings hook's
conventions). Swap literal tier strings in `CustomerForm.tsx` and `ProductForm.tsx` for
`tierLabel(...)` from `apps/mobile/lib/tier-label.ts`. Then grep `apps/mobile` for `Tier ` and
sweep remaining render sites (report which). Mobile does NOT get an editing UI in this task.

## Explicitly OUT of scope

Renaming the "Special" price badge per-tier (needs per-line tier provenance the schema lacks —
note as follow-up, do not build) · migrations/schema · entitlement flags · `.claude/code-map`.

## Acceptance criteria

1. With no config set, every touched surface renders exactly what it renders today — `Tier N` on
   the full-width/prose surfaces, and the existing `T2`..`T5` / `T1 (List)` abbreviations on the
   three already-abbreviated web surfaces (the products-list tier columns, the variant modal's
   5-column tier grid, and that grid's "Higher than …" warning). Criteria 1 and 2 conflict on
   those three; **criterion 1 wins**: zero visual regression for tenants who never configure a
   label beats a uniform fallback, since `Tier N` would widen those narrow columns for everyone
   by default. `tierLabel()` stays the fallback everywhere else.
2. With `{"2":"Wholesaler"}` set, every touched surface — the three abbreviated ones included —
   shows "Wholesaler" for tier 2, and its own default for the rest (`Tier N`, or `T3`..`T5` on
   the three abbreviated surfaces named above).
3. PATCH semantics: omitted field untouched, empty string clears back to default — same as
   remittance config.
4. GET is OPERATOR+DRIVER; PATCH is TENANT_ADMIN only.
5. Helper spec passes; the three helper mirrors are textually identical in logic.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-tier-labels && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-tier-labels && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-tier-labels && npm run test
```
