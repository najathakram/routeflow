# Plan: Consolidate Tobacco Dealer Compliance into the Regulated Items hub

> Authored by Fable 5 on 2026-08-24. Status: IMPLEMENTED (pipeline wf_a5c6326c-03d, 1 fix round → clean; fresh API jest 165/165 · 2811 tests)
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to any conversation.
>
> **Worktree:** `C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco` — branch `feat/regulated-consolidation`, cut from master `b1a0e099`. Every relative path below is relative to that worktree root. All cited line numbers are anchored against master `b1a0e099`.

## Objective

RouteFlow currently ships two parallel tobacco/regulated surfaces: the addon-gated standalone **/tobacco** surface (web page + nav leaf, Settings-hub row, mobile More-menu row + screen, monthly `TobaccoReport` cron, `tobacco.excludeFromMainAnalytics`, `Product.isTobacco` quick-toggle — all keyed on the raw `TenantAddon('tobacco_dealer')` row) and the **Regulated Items hub** (**/compliance**, category-driven, currently visible to every tenant, gated by nothing). This PR consolidates them into ONE surface: the Regulated Items hub survives; tobacco becomes the addon-gated **compliance pack** inside it. Basic regulated categorization (types, categories, product assignment) stays free; ledgers/reports/filings/exclusion become gated on the `tobacco_dealer` addon. `/tobacco` deep links redirect into the hub. `Product.isTobacco` becomes a server-maintained mirror of membership in the tenant's Tobacco regulated type, kept in sync in BOTH directions, with a dry-run-first backfill script to reconcile existing data. **No schema migration.**

## Constraints & conventions

### Binding decisions

1. **Addon key stays `tobacco_dealer`.** It is bridged to the `REGULATED_ITEMS` SKU via `LEGACY_ADDON_KEY_TO_SKU` in `apps/api/src/billing/plan-catalog.constants.ts:239-243`, and `REGULATED_ITEMS` is in the published catalog v11 — `AddonService.enableAddon` (post-#433) validates bridged keys against the published catalog and will pass. Do NOT invent a new addon key. Only the platform-admin LABEL/description changes (WP5).
2. **Server gating uses the tobacco controller's house pattern**: `@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` + `@RequireAddon("tobacco_dealer")` (see `apps/api/src/tobacco/tobacco.controller.ts:16-19`). NOT `PlanFlagGuard` — the pack gate reads the raw addon row, exactly like tobacco does today. Guard order matters: AddonGuard reads `req.user` set by JwtAuthGuard (see the comment in `apps/api/src/billing/addon.guard.ts:6-12`).
3. **`Product.isTobacco` sync model — DECISION: write-sync (category is the axis, `isTobacco` is a derived mirror).** Every product write that changes `trackedCategoryId` recomputes `isTobacco = (new category is the tenant's Tobacco type)`. An `isTobacco`-only PATCH (the mobile quick-toggle) is reinterpreted server-side as an assign-to/unassign-from the Tobacco type, then the mirror derivation runs. **Justification:** the monthly report must be byte-equivalent before/after for a correctly-categorized tenant. Read-derivation would rewrite every reader (`tobacco-report.service`, `tobacco.service`, ~8 `analytics.service` exclusion filters, `common/invoiced-sales.ts`) in one PR and make byte-equivalence contingent on a perfect backfill. Write-sync leaves EVERY reader untouched (they keep reading `isTobacco`, which is now correct by construction), the toggle still writes a field that everything reads (no half-state), and a later release can flip readers to `trackedCategoryId` at leisure.
4. **The Tobacco type is resolved by name**: `TrackedCategory.name` equals `"Tobacco"` case-insensitively (the Phase-4 W1 backfill seeded exactly this row per tenant that had `isTobacco` products; the historical seed is squashed into `0_init`). This is the no-migration identification path. The one definition lives server-side (`isTobaccoCategoryName`) and is surfaced to clients as a computed `isTobaccoCategory` boolean on every tracked-category payload — clients never re-implement the name match.
5. **No schema migration.** The sync + backfill are data-level. (If review finds a schema change truly unavoidable, the next free slot is `20260905000000_*` — `20260904` is claimed by another in-flight session — but the burden of proof is on whoever proposes it; this plan needs none.)
6. **Free vs gated split** (owner-approved): FREE = tracked-categories CRUD + subcategories + product assignment + product forms + `GET /regulated/templates` (product forms consume it) + the hub's structural views (type cards, product counts, category chips). GATED (`tobacco_dealer`) = `GET /regulated/ledger`, all `/regulated/filings*` routes, `/regulated/reports/{preview,csv}`, the whole `/tobacco/*` controller (already gated), the filings auto-prepare cron, and the corresponding web/mobile UI sections.

### Do NOT touch

- `apps/api/src/common/pricing.ts`, `apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts` (the 3 money mirrors).
- `apps/api/src/invoices/**` and `apps/api/src/orders/**` (services untouched).
- The regulated-sales **LEDGER write paths** — `apps/api/src/regulated/regulated-ledger.service.ts` and every `writeSaleEntries`/`reverse*` hook. The ledger is append-only; its discipline is binding. (Read endpoints get an addon gate in WP2; the service itself is not edited.)
- `apps/api/src/tobacco/tobacco.service.ts`, `apps/api/src/tobacco/tobacco-report.service.ts`, `tobacco-report-pdf.tsx`, `tobacco.controller.ts`, `tobacco.module.ts` — the tobacco API module survives UNCHANGED as the compliance-pack backend. Its readers stay on `isTobacco`; this is what guarantees byte-equivalent report output. Only client surfaces move.
- The buyer portal (`apps/api/src/buyer/**`, `apps/web/app/buyer/**`, mobile `(customer)` group).
- `apps/web/components/CommandPalette.tsx` (verified: contains no tobacco references — leave it alone).
- Tax stays section-level (standing decision) — no tax wiring changes anywhere.

### Repo conventions the agents need

- Web nav injection happens in the `navStructure` `useMemo` of `apps/web/app/(dashboard)/layout.tsx` (never in `OPERATOR_NAV`).
- Gated web pages follow the sales-agents pattern (`apps/web/app/(dashboard)/sales-agents/page.tsx:53-149`): `useTenantAddons()` → boolean, every gated query hook takes `{ enabled }` so an unentitled tenant fires ZERO gated requests, deep links render `LockedPage` from `apps/web/app/(dashboard)/_components/gates/PlanGates.tsx` with `gate={{ code: "PLAN_GATE", message: "…" }}`.
- Mobile has no role/addon guard components — gate by conditional render; API enforcement is the real control.
- Live-tenant scripts follow `apps/api/scripts/repair-receiving-units.mjs`: dry-run default; `--execute --confirm-tenant=<slug>` (slug typed back); non-test tenants additionally need `--live-tenant-override`; `isTestTenant` from `scripts/lib/test-tenants.cjs`; DB URL resolver handles both `DATABASE_URL` and Railway `POSTGRES_*` env parts.
- Playwright: a spec without its own project entry in `apps/web/playwright.config.ts` never runs.
- WP agents must NOT edit `.claude/code-map/**` or `HANDOFF.md` — the orchestrator does one consolidation pass after the WPs land.
- No `npx prisma generate` needed (no schema change).

## Work packages

File ownership across WP1–WP7 is disjoint; WP1/WP2/WP3 (api), WP4/WP5 (web), WP6 (mobile), WP7 (e2e) can run in parallel.

---

### WP1 — API: `isTobacco` ⇄ Tobacco-type write-sync

- **files:**
  - `apps/api/src/common/tobacco-category.ts` (new)
  - `apps/api/src/common/tobacco-category.spec.ts` (new)
  - `apps/api/src/products/products.service.ts`
  - `apps/api/src/products/products.service.spec.ts`
  - `apps/api/src/tracked-categories/tracked-categories.service.ts`
  - `apps/api/src/tracked-categories/tracked-categories.service.spec.ts`
- **brief:** Introduce the single canonical Tobacco-type resolver; make every product write path keep `Product.isTobacco` mirroring membership in that type; expose `isTobaccoCategory` on every tracked-category API payload. `assertCanFlagTobacco` (products.service:120-128) stays — an EXPLICIT `isTobacco: true` still requires the addon; the derived mirror write does not go through it (assigning a category is free categorization; the flag alone unlocks nothing).

- **exact code — `apps/api/src/common/tobacco-category.ts` (new, complete):**

```ts
/**
 * The tenant's "Tobacco" regulated type — the compliance-pack anchor.
 *
 * Identification is BY NAME (case-insensitive "Tobacco"): the Phase-4 W1
 * backfill seeded exactly one such TrackedCategory per tenant that had
 * isTobacco products, and the consolidation deliberately avoids a schema
 * marker column. Renaming that category away from "Tobacco" detaches the
 * mirror sync; apps/api/scripts/backfill-tobacco-category.mjs re-heals it.
 *
 * Product.isTobacco is a DERIVED MIRROR of membership in this type (write-sync,
 * 2026-08-24 consolidation): every write that changes Product.trackedCategoryId
 * recomputes the flag, and an isTobacco-only PATCH is sugar for an assign/
 * unassign. Readers (tobacco reports/analytics exclusion) still consume the
 * flag — do not change them without re-proving report byte-equivalence.
 */
export const TOBACCO_CATEGORY_NAME = "Tobacco";

export function isTobaccoCategoryName(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === TOBACCO_CATEGORY_NAME.toLowerCase();
}
```

`tobacco-category.spec.ts`: cover `"Tobacco"`, `"tobacco"`, `" TOBACCO "`, `"Tobacco Products"` (false), `null`/`undefined`/`""` (false).

- **exact code — `products.service.ts`.** Add import `{ TOBACCO_CATEGORY_NAME, isTobaccoCategoryName }` from `"../common/tobacco-category"`. Add two private helpers (place near `assertCanFlagTobacco`, ~line 128):

```ts
/** The tenant's Tobacco regulated type, matched by name (case-insensitive). */
private async findTobaccoCategory(): Promise<{ id: string; name: string } | null> {
  return this.prisma.forTenant().trackedCategory.findFirst({
    where: { name: { equals: TOBACCO_CATEGORY_NAME, mode: "insensitive" } },
    select: { id: true, name: true },
  });
}

/**
 * Resolve the tenant's Tobacco type, creating it when absent. The created row
 * mirrors the Phase-4 W1 seed exactly (warn-only: taxType NONE, no license,
 * CA_CDTFA / MONTHLY, SEPARATE_INVOICE) so flagging a first tobacco product
 * never enables tax or license enforcement as a side effect.
 */
private async resolveOrCreateTobaccoCategory(): Promise<{ id: string }> {
  const existing = await this.findTobaccoCategory();
  if (existing) return existing;
  const tenantId = this.prisma.getTenantId();
  if (!tenantId) {
    throw new BadRequestException("A tenant context is required to flag tobacco products.");
  }
  return this.prisma.forTenant().trackedCategory.create({
    data: {
      tenantId,
      name: TOBACCO_CATEGORY_NAME,
      taxType: "NONE",
      requiresLicense: false,
      reportTemplate: "CA_CDTFA",
      reportCadence: "MONTHLY",
      invoiceTreatment: "SEPARATE_INVOICE",
      active: true,
    },
    select: { id: true },
  });
}
```

**In `create()`** — immediately AFTER the `const regulated = …` block (lines 531-547) and BEFORE `assertSubcategoryInSection` (line 548), insert; then change line 586 from `isTobacco: dto.isTobacco ?? parent?.isTobacco ?? false,` to `isTobacco,`:

```ts
// ── Compliance-pack sync: Category is the ONE axis; isTobacco is a derived
// mirror of membership in the tenant's Tobacco type. An isTobacco-only create
// (no category sent — legacy clients / quick flows) is sugar for "put it in
// the Tobacco type"; when a category IS sent, the category wins.
let isTobacco = dto.isTobacco ?? parent?.isTobacco ?? false;
if (regulated.trackedCategoryId == null && dto.isTobacco === true) {
  const tobacco = await this.resolveOrCreateTobaccoCategory();
  regulated.trackedCategoryId = tobacco.id;
  isTobacco = true;
} else if (regulated.trackedCategoryId != null) {
  const cat = await this.prisma.forTenant().trackedCategory.findUnique({
    where: { id: regulated.trackedCategoryId },
    select: { name: true },
  });
  isTobacco = isTobaccoCategoryName(cat?.name);
}
```

(`regulated`'s inferred property type must allow the assignment — if TS narrows `trackedCategoryId` to `null` in a branch, type the temp explicitly: `const regulated: { trackedCategoryId: string | null; trackedSubcategoryId: string | null; regItemType: number | null; regUomCase: string | null; regUomUnit: string | null } = …`.)

**In `update()`** — immediately AFTER `const existing = await this.findOne(id);` (line 613), insert the quick-toggle reinterpretation (the existing `assertCanFlagTobacco(dto.isTobacco)` at line 611 stays where it is):

```ts
// ── Compliance-pack sync: an isTobacco-only PATCH (the mobile quick-toggle)
// is sugar for a Tobacco-type assign/unassign. When the request also carries
// an explicit trackedCategoryId, the category wins and the mirror derivation
// below reconciles the flag.
if (dto.isTobacco !== undefined && dto.trackedCategoryId === undefined) {
  if (dto.isTobacco === true) {
    const tobacco = await this.resolveOrCreateTobaccoCategory();
    if (existing.trackedCategoryId !== tobacco.id) {
      dto.trackedCategoryId = tobacco.id;
      // A section move always clears the old section's subcategory (the
      // parent==section invariant) unless the request set one explicitly.
      if (dto.trackedSubcategoryId === undefined) dto.trackedSubcategoryId = null;
    }
  } else {
    const tobacco = await this.findTobaccoCategory();
    if (tobacco && existing.trackedCategoryId === tobacco.id) {
      dto.trackedCategoryId = null; // un-flagging = leaving the Tobacco type
    }
  }
}
```

Then, AFTER the `data` object is fully built (after the msrp block, lines 777-779) and BEFORE `return this.prisma.forTenant().product.update(…)` (line 780), insert the mirror derivation (`sectionChanged` and `effectiveCategoryId` already exist at lines 686/717):

```ts
// ── Mirror derivation: after this write, isTobacco always reflects membership
// in the Tobacco type. Recomputed only when the section actually changes or
// the caller sent isTobacco — unrelated PATCHes never touch the flag.
if (sectionChanged || dto.isTobacco !== undefined) {
  if (effectiveCategoryId == null) {
    data.isTobacco = false;
  } else {
    const cat = await this.prisma.forTenant().trackedCategory.findUnique({
      where: { id: effectiveCategoryId },
      select: { name: true },
    });
    data.isTobacco = isTobaccoCategoryName(cat?.name);
  }
}
```

- **exact code — `tracked-categories.service.ts`:**
  1. Import `isTobaccoCategoryName` from `"../common/tobacco-category"`.
  2. `serialize` (lines 32-35) decorates every category payload:
     ```ts
     private serialize<T extends object>(row: WithCount<T>) {
       const { _count, ...rest } = row;
       return {
         ...rest,
         productCount: _count.products,
         // Computed, never stored: the compliance-pack anchor flag clients key on.
         isTobaccoCategory: isTobaccoCategoryName((rest as { name?: string }).name),
       };
     }
     ```
     (`serializeSub` for subcategories stays untouched.)
  3. `assignProducts` (lines 197-226): change the discarded `await this.findOne(id);` to `const category = await this.findOne(id);`, and after the final `updateMany` (line 221-224) add — also update the now-stale doc comment (lines 189-196) that says `isTobacco` stays owned by the product flow:
     ```ts
     // Compliance-pack sync: isTobacco mirrors membership in the Tobacco type.
     // Applied to the full id set (movers AND rows already in this category) so
     // a drifted mirror is healed by any re-assign.
     await this.prisma.forTenant().product.updateMany({
       where: { id: { in: productIds } },
       data: { isTobacco: isTobaccoCategoryName((category as { name?: string }).name) },
     });
     return { assigned: count };
     ```
  4. `unassignProducts` (lines 229-251): after the final `updateMany`, scope the mirror clear to the rows that were actually in the category (the `targets` list fetched at line 233):
     ```ts
     const targetIds = targets.map((t) => t.id);
     if (targetIds.length > 0) {
       // Unassigned products are in no regulated type — never tobacco.
       await this.prisma.forTenant().product.updateMany({
         where: { id: { in: targetIds } },
         data: { isTobacco: false },
       });
     }
     return { unassigned: count };
     ```

- **spec updates:** `products.service.spec.ts` — new cases: (a) PATCH `{isTobacco:true}` with no category on a product outside the Tobacco type sets `trackedCategoryId` to the (existing) Tobacco type, clears `trackedSubcategoryId`, writes `isTobacco:true`; (b) same but no Tobacco type exists → one is created with the W1-seed values (`taxType:"NONE"`, `requiresLicense:false`, `reportTemplate:"CA_CDTFA"`, `reportCadence:"MONTHLY"`, `invoiceTreatment:"SEPARATE_INVOICE"`); (c) PATCH `{isTobacco:false}` on a Tobacco-type member clears the category and the flag; (d) PATCH `{trackedCategoryId:<nonTobacco>}` on a flagged product writes `isTobacco:false`; (e) PATCH `{trackedCategoryId:<tobaccoId>}` writes `isTobacco:true` even without `dto.isTobacco`; (f) an unrelated PATCH (rename/price) performs NO trackedCategory lookup and leaves `isTobacco` out of the update data; (g) create with `{isTobacco:true}` and no category links + flags. `tracked-categories.service.spec.ts` — assign to a category named "Tobacco" sets `isTobacco:true` on the id set; assign to another category sets `false`; unassign sets `false` only on rows that were members; every serialized payload carries `isTobaccoCategory` (true for "tobacco" case-insensitive, false otherwise).

---

### WP2 — API: gate the compliance-pack routes + cron

- **files:**
  - `apps/api/src/regulated/regulated.controller.ts`
  - `apps/api/src/regulated/regulated.module.ts`
  - `apps/api/src/regulated/regulated-filing-cron.service.ts`
  - `apps/api/src/regulated/regulated-filing-cron.service.spec.ts`
- **brief:** Ledger/filings/reports become compliance-pack routes gated on the raw `tobacco_dealer` addon, matching the tobacco controller's pattern exactly. `GET /regulated/templates` stays UNGATED (the free product forms consume it via `useRegulatedTemplates`). The tracked-categories controller is untouched (free categorization). The filings auto-prepare cron skips tenants without the addon (mirrors the tobacco cron's addon intersection at `tobacco-report.service.ts:322-332`). Use the string literal `"tobacco_dealer"` in decorators, same as `tobacco.controller.ts:19` — no cross-WP import.

- **exact code — `regulated.controller.ts`:**

```ts
import { AddonGuard } from "../billing/addon.guard";
import { RequireAddon } from "../billing/require-addon.decorator";

// Categorization stays free; the LEDGER/FILINGS/REPORTS surfaces are the
// Regulated compliance pack, gated on the tobacco_dealer addon (bridged to the
// REGULATED_ITEMS SKU). GET /templates stays ungated — the free product forms
// read it. Guard order matters: AddonGuard reads req.user (set by JwtAuthGuard).
@Controller("regulated")
@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)
@Roles(UserRole.OPERATOR)
export class RegulatedController {
```

Then add `@RequireAddon("tobacco_dealer")` to these handlers (method-level, so `getTemplates` — undecorated — passes the guard's `if (!addonKey) return true` fast-path): `getLedger`, `previewReport`, `downloadReportCsv`, `listFilings`, `prepare`, `downloadCsv`, `downloadPdf`. Do NOT decorate `getTemplates`.

- **exact code — `regulated.module.ts`:** `imports: [StorageModule, AuditModule, BillingModule]` (add `import { BillingModule } from "../billing/billing.module";`) — AddonGuard + AddonService resolve from the controller's module context; BillingModule exports both.

- **exact code — `regulated-filing-cron.service.ts`**, in `autoPrepareClosedFilings()` replace the single query (lines 67-70) with:

```ts
// System-level (NO forTenant) → every tenant's active categories; each row
// carries its own tenantId, which we set as context per prepare. Compliance
// pack: only tenants with the active tobacco_dealer addon get auto-prepared
// filings (mirrors the tobacco report cron's addon intersection).
const [categories, packAddons] = await Promise.all([
  this.prisma.trackedCategory.findMany({
    where: { active: true },
    select: { id: true, tenantId: true, reportCadence: true },
  }),
  this.prisma.tenantAddon.findMany({
    where: { addonKey: "tobacco_dealer", active: true },
    select: { tenantId: true },
  }),
]);
const packTenants = new Set(packAddons.map((a) => a.tenantId));
const gated = categories.filter((c) => packTenants.has(c.tenantId));
```

Iterate `gated` instead of `categories`; extend the closing log line with the ungated count: `` `(${gated.length} of ${categories.length} active categories on pack tenants)` ``.

- **spec updates:** `regulated-filing-cron.service.spec.ts` — mock `prisma.tenantAddon.findMany`; assert a category on an addon-less tenant is never prepared and a category on an addon tenant still is; keep the existing idempotency/rollover cases green.

---

### WP3 — Backfill script (dry-run-first, no migration)

- **files:** `apps/api/scripts/backfill-tobacco-category.mjs` (new)
- **brief:** Reconcile existing data to the write-sync invariant: for a tenant, the set `{Product.isTobacco = true}` must equal the member set of the Tobacco type. Mirror `repair-receiving-units.mjs` posture EXACTLY (header comment, `resolveDbUrl`, arg parsing, `isTestTenant` guard, dry-run default, `--execute --confirm-tenant=<slug>`, `--live-tenant-override`). Additionally support `--all-tenants` for a **dry-run-only** global report (`--all-tenants` combined with `--execute` must exit with an error — execution is strictly per-tenant).
- **exact code — the per-tenant plan/execute core (transplant `resolveDbUrl` + the arg/guard block verbatim from `repair-receiving-units.mjs:42-105`, adding the `--all-tenants` flag):**

```js
const CI_TOBACCO = { equals: "Tobacco", mode: "insensitive" };

async function planForTenant(tenant) {
  const tobaccoCat = await prisma.trackedCategory.findFirst({
    where: { tenantId: tenant.id, name: CI_TOBACCO },
    select: { id: true, name: true, active: true },
  });
  const products = await prisma.product.findMany({
    where: {
      tenantId: tenant.id,
      OR: [{ isTobacco: true }, ...(tobaccoCat ? [{ trackedCategoryId: tobaccoCat.id }] : [])],
    },
    select: {
      id: true,
      name: true,
      isTobacco: true,
      trackedCategoryId: true,
      trackedCategory: { select: { name: true } },
    },
  });
  return {
    tenant,
    tobaccoCat,
    // Flagged but pointing nowhere → link into the Tobacco type.
    link: products.filter((p) => p.isTobacco && p.trackedCategoryId == null),
    // Flagged but assigned to a DIFFERENT type → NEVER auto-moved. Reported
    // for the owner to resolve by hand (moving could change invoice splitting
    // and filing attribution for that product).
    conflicts: products.filter(
      (p) => p.isTobacco && p.trackedCategoryId != null && p.trackedCategoryId !== tobaccoCat?.id,
    ),
    // Members of the Tobacco type missing the mirror flag → set it.
    flag: products.filter(
      (p) => !p.isTobacco && tobaccoCat && p.trackedCategoryId === tobaccoCat.id,
    ),
    // No Tobacco type yet but flagged products exist → create it (W1-seed values).
    createCategory: !tobaccoCat && products.some((p) => p.isTobacco),
  };
}

async function executePlan(plan) {
  await prisma.$transaction(async (tx) => {
    let catId = plan.tobaccoCat?.id;
    if (plan.createCategory) {
      const created = await tx.trackedCategory.create({
        data: {
          tenantId: plan.tenant.id,
          name: "Tobacco",
          taxType: "NONE",
          requiresLicense: false,
          reportTemplate: "CA_CDTFA",
          reportCadence: "MONTHLY",
          invoiceTreatment: "SEPARATE_INVOICE",
          active: true,
        },
        select: { id: true },
      });
      catId = created.id;
    }
    if (plan.link.length > 0 && catId) {
      await tx.product.updateMany({
        where: { id: { in: plan.link.map((p) => p.id) } },
        data: { trackedCategoryId: catId },
      });
    }
    if (plan.flag.length > 0) {
      await tx.product.updateMany({
        where: { id: { in: plan.flag.map((p) => p.id) } },
        data: { isTobacco: true },
      });
    }
  });
}
```

Dry-run output per tenant: counts + per-product `id · name · action` lines for `link`/`flag`, LOUD `CONFLICT` lines for `conflicts` (these are never written), `CREATE TrackedCategory "Tobacco"` when applicable, and `clean — nothing to do` when all empty (idempotency proof: a second run must print exactly that). `--all-tenants` iterates `prisma.tenant.findMany({ select: { id, slug, status } })` printing the same plan per tenant, writes nothing regardless of flags. Exit non-zero if `--execute` is passed with `--all-tenants`. Note in the header comment: `link` rows have `trackedCategoryId == null`, so they carry no subcategory and no synced `Product.category` — the script deliberately touches ONLY `trackedCategoryId`/`isTobacco`, never `category`/`trackedSubcategoryId`.

Run commands (documented in the header):

```
railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs --all-tenants
railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs --tenant=<slug>
railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs --tenant=<slug> --execute --confirm-tenant=<slug> [--live-tenant-override]
```

---

### WP4 — Web: hub consolidation + `/tobacco` redirect

- **files:**
  - `apps/web/app/(dashboard)/compliance/page.tsx`
  - `apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx`
  - `apps/web/app/(dashboard)/compliance/[categoryId]/_components/CompliancePackPanel.tsx` (new)
  - `apps/web/app/(dashboard)/tobacco/page.tsx`
  - `apps/web/lib/api/tracked-categories.ts`
- **brief:** The hub becomes the one surface. Free structure stays visible to everyone; ledger/report/filings sections render only with the addon; the tobacco pack renders inside the Tobacco section's dashboard; `/tobacco` becomes a client redirect (deep links must not 404 — the target id is tenant-specific, so this cannot be a `next.config` redirect).

1. **`lib/api/tracked-categories.ts`:** add to `interface TrackedCategory` (lines 15-40): `/** Computed server-side: name is "Tobacco" (ci) — the compliance-pack anchor. */ isTobaccoCategory?: boolean;`. Give `useRegulatedFilings` (lines 250-258) an options arg mirroring `useRegulatedLedger`'s:

   ```ts
   export function useRegulatedFilings(categoryId?: string, options?: { enabled?: boolean }) {
     return useQuery<RegulatedFiling[]>({
       queryKey: [...FILINGS_KEY, categoryId ?? null],
       queryFn: () => …,
       enabled: options?.enabled ?? true,
     });
   }
   ```

2. **`CompliancePackPanel.tsx` (new):** `"use client"` component, prop `{ categoryId: string }`. Build it FIRST by transplanting from the current `apps/web/app/(dashboard)/tobacco/page.tsx` (613 lines — read it before step 4 replaces it): the `Tabs.Root` block with the four tabs (**Reports** — list + per-row CSV/PDF via `fetchTobaccoReportUrl` → `window.open(url)` (presigned URL, no auth header needed) + "Generate/Regenerate" for the previous month via `useGenerateTobaccoReport`; **Inventory**; **Purchases** — keeps the supplier `tobaccoLicenseNo` column; **Sales** — keeps the customer license column + missing-license warning treatment), plus the TENANT_ADMIN analytics-exclusion toggle card (`useTobaccoSettings`/`useUpdateTobaccoSettings`, `useAuth().user?.role === "TENANT_ADMIN"`). Wrap it all in one `Card title="Tobacco compliance pack"`. Drop the old page's KPI cards and monthly recharts chart (the section dashboard already has its own ledger KPIs/chart — do not duplicate). All hooks come from `@/lib/api/tobacco` unchanged. The panel performs no addon check itself — the parent gates the mount.

3. **`compliance/[categoryId]/page.tsx`:** add

   ```tsx
   import { useTenantAddons, TOBACCO_ADDON } from "@/lib/api/tobacco";
   import { LockedPage } from "@/app/(dashboard)/_components/gates/PlanGates";
   import { CompliancePackPanel } from "./_components/CompliancePackPanel";
   …
   const { data: addonsData, isLoading: addonsLoading } = useTenantAddons();
   const packEnabled = addonsData?.addons?.includes(TOBACCO_ADDON) ?? false;
   ```

   Gate the two pack hooks so an unentitled tenant fires ZERO gated requests: `useRegulatedFilings(params.categoryId, { enabled: packEnabled })`, `useRegulatedLedger({ category: params.categoryId, from }, { enabled: packEnabled })`. Render split:
   - **Always (free):** back link, header, the "Regulated Products" KPI (link to `/products?section=`), the "Categories" chips card.
   - **`packEnabled`:** the Net Sales/Tax KPI cards, the Filings KPI, the monthly chart, then `{c.isTobaccoCategory && <CompliancePackPanel categoryId={c.id} />}`, then `RegulatedReportPanel`, then the Filings card (Prepare button unchanged).
   - **`!packEnabled && !addonsLoading`:** in place of all gated sections, one
     ```tsx
     <LockedPage
       gate={{
         code: "PLAN_GATE",
         message: "Compliance ledgers, reports and filings aren't enabled for this workspace.",
       }}
       title="Regulated compliance pack"
     />
     ```

4. **`compliance/page.tsx`:** same `packEnabled` derivation (the file already imports from `@/lib/api/tobacco`, line 9). `useRegulatedFilings(undefined, { enabled: packEnabled })`. Filings KPI value becomes `packEnabled ? filings.length : "—"`. **Delete the `/tobacco` link** (lines 87-91, "Tobacco reports →"). The Tax KPI keeps its existing `hasTobacco` + `useTobaccoOverview(undefined, { enabled: hasTobacco })` wiring. The filings roll-up `Card` (lines 160-162) renders only when `packEnabled`; otherwise render `<Card title="Filings"><p className="py-6 text-center text-sm text-navy/60">Filings, ledgers and reports are part of the Regulated compliance pack, which isn&apos;t enabled for this workspace.</p></Card>`.

5. **`tobacco/page.tsx`** — replace the whole file:

   ```tsx
   "use client";

   /**
    * /tobacco → the Regulated Items hub. The standalone tobacco surface retired
    * into the compliance pack (2026-08-24 consolidation); deep links in the wild
    * must not 404. Client-side because the target section id is tenant-specific.
    */
   import * as React from "react";
   import { useRouter } from "next/navigation";
   import { Loader2 } from "lucide-react";
   import { useTrackedCategories } from "@/lib/api/tracked-categories";

   export default function TobaccoRedirect() {
     const router = useRouter();
     const { data: categories, isSuccess, isError } = useTrackedCategories();
     React.useEffect(() => {
       if (isError) {
         router.replace("/compliance");
         return;
       }
       if (!isSuccess) return;
       const tobacco = categories?.find((c) => c.isTobaccoCategory);
       router.replace(tobacco ? `/compliance/${tobacco.id}` : "/compliance");
     }, [isSuccess, isError, categories, router]);
     return (
       <div className="flex items-center justify-center p-12">
         <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
       </div>
     );
   }
   ```

---

### WP5 — Web: retire nav/settings entries + admin label rename

- **effort:** low
- **files:**
  - `apps/web/app/(dashboard)/layout.tsx`
  - `apps/web/app/(dashboard)/settings/_components/SettingsHub.tsx`
  - `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`
- **brief:**
  1. **`layout.tsx`:** delete the Tobacco leaf splice (lines 899-901: `if (hasTobacco) { inject.push({ kind: "leaf", label: "Tobacco", href: "/tobacco", icon: Cigarette }); }`), the `const hasTobacco = useHasAddon(TOBACCO_ADDON);` declaration (line 870), and `hasTobacco` from the memo deps (line 939). Fix imports: line 65 becomes `import { useHasAddon } from "@/lib/api/tobacco";` (**`useHasAddon` MUST stay** — `hasSalesAgents` on line 871 uses it; only `TOBACCO_ADDON` goes). Remove `Cigarette` from the lucide-react import if now unused. Update the comment at lines 880-883 (drop the "addon-gated Tobacco deep page stays a separate leaf" sentence). The "Regulated Items" NavGroup splice stays exactly as-is.
  2. **`SettingsHub.tsx`:** delete the Tobacco hub item (lines 149-154), narrow `HubItem.show` to `"admin"` (line 33), delete the `useHasAddon, TOBACCO_ADDON` import (line 17), the `hasTobacco` const (line 192), and simplify `canShow` (lines 195-199) to `(item: HubItem) => (item.show === "admin" ? isAdmin : true)`. Update the doc comment (lines 19-26). The "Regulated sections" item stays.
  3. **`admin/tenants/[id]/page.tsx`:** in `AVAILABLE_ADDONS` (lines 96-102) keep `key: "tobacco_dealer"` but change `name` to `"Regulated compliance pack"` and `description` to `"Regulated Items compliance pack — license-column ledgers, monthly tobacco reports, regulated filings & range reports, and the analytics-exclusion option inside the Regulated Items hub (legacy key: tobacco_dealer)"`.

---

### WP6 — Mobile: hub consolidation + retire tobacco surfaces

- **files:**
  - `apps/mobile/app/(operator)/compliance/index.tsx`
  - `apps/mobile/app/(operator)/compliance/[id].tsx`
  - `apps/mobile/components/TobaccoPackSection.tsx` (new)
  - `apps/mobile/app/(operator)/tobacco/index.tsx`
  - `apps/mobile/app/(operator)/(tabs)/more.tsx`
  - `apps/mobile/lib/api/tobacco.ts`
  - `apps/mobile/lib/api/regulated.ts`
  - `apps/mobile/lib/api/tracked-categories.ts`
- **brief:**
  1. **`lib/api/tracked-categories.ts`:** add `isTobaccoCategory?: boolean;` to the `TrackedCategory` interface (comment: computed server-side, mirrors web).
  2. **`lib/api/regulated.ts`:** `useRegulatedFilings` (lines 34-42) gains `options?: { enabled?: boolean }` → `enabled: options?.enabled ?? true` (mirror `useRegulatedLedger` at lines 85-103).
  3. **`lib/api/tobacco.ts`:** `useTobaccoOverview` (lines 56-62) gains `options?: { enabled?: boolean }` and `retry: false` (mirror web `apps/web/lib/api/tobacco.ts:104-114`). Keep everything else — these hooks now feed the pack section.
  4. **`TobaccoPackSection.tsx` (new):** transplant from the current `apps/mobile/app/(operator)/tobacco/index.tsx` the "MONTHLY REPORTS" `ListGroup` (generate-previous-month row + report rows with PDF share via `fetchTobaccoReportUrl` + `sharePdf`) and the "TOBACCO INVENTORY" `ListGroup` (rows linking to `/(operator)/products/{id}`, `No cost` pill), including `previousMonth()`, `fmt()`, `onGenerate`, `onShare` and the needed styles. No KPI row (the section screen has its own). No addon check inside — the parent gates the mount.
  5. **`compliance/[id].tsx`:** derive `const packEnabled = useHasAddon(TOBACCO_ADDON);` (import from `../../../lib/api/tobacco`). Gate hooks: `useRegulatedFilings(id, { enabled: packEnabled })`, ledger `{ enabled: !!id && packEnabled }`. Render: header + Regulated-Products KPI + subcategory chips always; the Net-sales/Tax KPIs, `MONTHLY` group, prepare row, `<TobaccoPackSection />` (only when `section.isTobaccoCategory`), `RegulatedReportSection`, `RegulatedFilingsList` only when `packEnabled`. When `!packEnabled` render a locked group in their place:
     ```tsx
     <ListGroup header="COMPLIANCE PACK">
       <View style={styles.emptyRow}>
         <Text style={styles.emptyText}>
           Ledgers, reports and filings are part of the Regulated compliance pack, which isn&apos;t
           enabled for this workspace. Ask your platform administrator.
         </Text>
       </View>
     </ListGroup>
     ```
     Mount order for the pack section: after the `MONTHLY` group, before the subcategory chips.
  6. **`compliance/index.tsx`:** `packEnabled` same way (`hasTobacco` already exists, line 16 — rename/reuse). Pass `{ enabled: packEnabled }` to `useTobaccoOverview` (fixes the pre-existing unconditional 403 noted in the comment at lines 17-19 — update that comment) and to `useRegulatedFilings`. Filings KPI value `packEnabled && … : "—"`; render `RegulatedFilingsList` only when `packEnabled`, else the same locked-copy block.
  7. **`app/(operator)/tobacco/index.tsx`** — replace the whole file:

     ```tsx
     import { Redirect } from "expo-router";

     /**
      * The standalone tobacco screen retired into the Regulated Items hub
      * (compliance pack, 2026-08-24). Kept as a redirect so stale deep links /
      * saved navigation states land in the hub instead of 404ing.
      */
     export default function TobaccoRedirect() {
       return <Redirect href="/(operator)/compliance" />;
     }
     ```

  8. **`(tabs)/more.tsx`:** delete the conditional Tobacco `ListRow` (lines 231-240), the `hasTobacco` const (line 16), and trim the import on line 9 to whatever is still used (if nothing from `lib/api/tobacco` remains, delete the import line).
  9. **Do NOT touch** `app/(operator)/products/[id].tsx` — the quick-toggle keeps PATCHing `{ isTobacco }`; the server now reinterprets it (WP1). Also do not touch `ProductForm`/pickers.

---

### WP7 — E2E: gate spec + keep spec 09 deterministic

- **files:**
  - `apps/web/e2e/19-compliance-pack-gate.spec.ts` (new)
  - `apps/web/e2e/09-regulated-compliance.spec.ts`
  - `apps/web/playwright.config.ts`
- **brief:**
  1. **Spec 09 mock fix:** the compliance section page now reads `GET /tenants/me/addons` to decide whether the report panel renders. Inside `mockRegulatedApi` (after the existing routes, ~line 150) add, so the suite stays deterministic regardless of the live tenant's addon state:
     ```ts
     await page.route(/\/tenants\/me\/addons(\?.*)?$/, (route) =>
       fulfillJson(route, { addons: ["tobacco_dealer"] }),
     );
     ```
     (The category fixture is named "E2E Tobacco", which is deliberately NOT `isTobaccoCategory`, so the tobacco pack panel never mounts and no `/tobacco/*` mocks are needed.)
  2. **New spec — ONE read-only test branching on live addon state** (pattern: `18-sales-agents-gate.spec.ts`):

     ```ts
     /**
      * Tobacco→Regulated consolidation gate. READ-ONLY: GETs and renders only.
      * Branches on the tenant's live addon state via GET /tenants/me/addons so it
      * is green both before and after tobacco_dealer is enabled on the e2e tenant.
      */
     import { test, expect } from "@playwright/test";
     import { apiBase, operatorAccessToken } from "./helpers/api";

     test("compliance pack follows the tobacco_dealer addon; /tobacco redirects", async ({
       page,
     }) => {
       await page.goto("/dashboard");
       const token = await operatorAccessToken(page);
       test.skip(!token, "no operator token — auth setup did not run");
       const res = await page.request.get(`${apiBase(page.url())}/api/v1/tenants/me/addons`, {
         headers: { Authorization: `Bearer ${token}` },
       });
       const { addons = [] } = await res.json();
       const enabled = addons.includes("tobacco_dealer");

       // The standalone /tobacco leaf is gone for everyone (a section NAMED
       // "Tobacco" may legitimately appear in the Regulated Items group, so
       // assert on the href, not the label).
       await expect(page.getByRole("navigation").locator('a[href="/tobacco"]')).toHaveCount(0);

       // Deep links in the wild must not 404 — /tobacco redirects into the hub.
       await page.goto("/tobacco");
       await page.waitForURL(/\/compliance(\/|$)?/, { timeout: 15_000 });

       await page.goto("/compliance");
       await expect(page.getByRole("heading", { name: "Regulated Items" })).toBeVisible();
       if (enabled) {
         await expect(page.getByText(/isn't enabled for this workspace/i)).toHaveCount(0);
       } else {
         await expect(page.getByText(/isn't enabled for this workspace/i)).toBeVisible();
       }
     });
     ```

  3. **`playwright.config.ts`:** append a project entry after `sales-agents-gate` (lines 257-269) — without it the spec never runs:
     ```ts
     // ── Compliance-pack entitlement gate (tobacco consolidation, 19) ──────────
     // Reads the tenant's live addon flag and asserts the /tobacco redirect and
     // the hub's locked/unlocked state match it. Read-only: GETs and renders only.
     {
       name: "compliance-pack-gate",
       testMatch: /19-compliance-pack-gate\.spec\.ts/,
       dependencies: ["setup"],
       use: {
         ...devices["Desktop Chrome"],
         storageState: path.join(AUTH_DIR, "operator.json"),
       },
     },
     ```

## Acceptance criteria

1. `GET /regulated/ledger`, `GET/POST /regulated/filings*`, `GET /regulated/reports/{preview,csv}` return 403 for a tenant without an active `tobacco_dealer` `TenantAddon` row, via `AddonGuard` + `@RequireAddon("tobacco_dealer")`; `GET /regulated/templates` and every `/tracked-categories*` route remain reachable with plain OPERATOR auth (no addon).
2. `PATCH /products/:id` with body `{"isTobacco": true}` (no `trackedCategoryId`) assigns the product to the tenant's Tobacco type (creating it with `taxType NONE / requiresLicense false / CA_CDTFA / MONTHLY / SEPARATE_INVOICE / active` when absent), clears any prior section's subcategory, and persists `isTobacco: true`. `{"isTobacco": false}` on a Tobacco-type member clears `trackedCategoryId` and the flag. The addon requirement for explicit `isTobacco: true` (`assertCanFlagTobacco`) is unchanged.
3. Any product create/update that sets `trackedCategoryId` writes `isTobacco` = (target category's name is "Tobacco" case-insensitive); `POST /tracked-categories/:id/products/assign` and `/unassign` write the same mirror on exactly the affected ids. A PATCH that touches neither `isTobacco` nor the section performs no tracked-category lookup and leaves `isTobacco` out of the update payload.
4. Every tracked-category API payload (list/detail/mutations) carries a computed `isTobaccoCategory` boolean; nothing is stored in the DB and **no Prisma migration exists in the diff** (`apps/api/prisma/migrations/` unchanged, `schema.prisma` unchanged).
5. `apps/api/src/tobacco/*` (controller/service/report service/PDF template/module), `regulated-ledger.service.ts`, `invoices/**`, `orders/**`, the 3 `pricing.ts` mirrors, buyer portal files, and `CommandPalette.tsx` have zero diff. Consequently the monthly tobacco report output is byte-identical for a tenant whose `{isTobacco}` set equals its Tobacco-type membership, and historical `TobaccoReport` rows remain listed/downloadable through the unchanged `/tobacco/reports*` endpoints, now surfaced in the hub panel.
6. The regulated filings auto-prepare cron (`@Cron("0 4 * * *")`) prepares filings only for tenants with an active `tobacco_dealer` addon; the tobacco report cron (`0 2 1 * *`) is untouched.
7. `apps/api/scripts/backfill-tobacco-category.mjs` exists; with no flags it prints a plan and writes nothing; `--execute` requires `--confirm-tenant=<slug>` and (for non-test tenants) `--live-tenant-override`; `--all-tenants --execute` is rejected; conflicts (flagged product assigned to a different type) are reported and never written; a second execute run reports clean/no-op.
8. Web: `/tobacco` renders no content page — it client-redirects to `/compliance/<tobacco section id>` (or `/compliance` when no Tobacco type / on fetch error). The sidebar contains no `/tobacco` leaf; the Settings hub has no Tobacco row; the platform-admin addon toggle shows key `tobacco_dealer` labelled "Regulated compliance pack".
9. Web `/compliance` and `/compliance/[id]`: with the addon, all previous sections render plus (Tobacco section only) the compliance-pack panel with Reports (list/generate/CSV/PDF), Purchases + Sales tables retaining their license columns, Inventory, and the TENANT_ADMIN analytics-exclusion toggle. Without the addon, the free structure (types, product counts, category chips, product links) still renders, a `LockedPage`/locked card replaces the gated sections, and **zero** requests to `/regulated/ledger`, `/regulated/filings*`, `/regulated/reports/*`, or `/tobacco/*` are fired (all gated hooks pass `enabled`).
10. Mobile: the More menu has no Tobacco row; `/(operator)/tobacco` redirects to `/(operator)/compliance`; the compliance hub + section screens gate ledger/filings/report sections on `useHasAddon(TOBACCO_ADDON)` with a locked-copy group when absent; the Tobacco section shows the reports + inventory pack groups when entitled; the product-detail quick-toggle is byte-unchanged.
11. E2E: `19-compliance-pack-gate.spec.ts` + its `playwright.config.ts` project exist, the spec is read-only and green in BOTH addon states; `09-regulated-compliance.spec.ts` mocks `/tenants/me/addons` and its 5 tests still pass.
12. `npm run verify` (types + lint + tests across workspaces) passes from the worktree root.

## Verification commands

From `C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco`:

```
npm run check-types
npm run lint
npm run test
npm run verify        # the three above via turbo — the gate the repo actually uses
```

Optional (requires a running stack + auth env): `npm run test:e2e -w apps/web -- --project=regulated-compliance --project=compliance-pack-gate`. Optional DB-backed check: `node apps/api/scripts/backfill-tobacco-category.mjs --tenant=<test tenant>` (dry-run prints a plan; no env → exits with the missing-env usage message, which is also acceptable proof of the guard).

## Runbook (owner steps post-merge — NOT implementer work)

1. Before merge: run the backfill in `--all-tenants` dry-run against prod; review. Expect: owner tenant mostly clean (W1 already linked), possibly a few `link`/`flag` rows for products touched since; any `CONFLICT` rows need a manual decision.
2. Audit which tenants have active `TrackedCategory` rows but no `tobacco_dealer` addon — those tenants lose ledger/filings/reports UI at deploy (intended; enable the addon per tenant if desired). Enable the addon on `routeflow-demo` (it has tobacco products seeded) for the demo.
3. Execute the backfill per tenant (`--execute --confirm-tenant=… --live-tenant-override` for live tenants, after a fresh validated backup).
4. Fixture check on `routeflow-demo`: `POST /tobacco/reports/generate` for last month before and after the deploy; diff the CSVs — must be byte-identical.
5. Orchestrator (not WP agents): update `.claude/code-map/` (api.md `tobacco/`+`regulated` rows, web.md tobacco/compliance rows, mobile.md rows 47/193-194, INDEX row) and `HANDOFF.md`.

## Risks & rollback

- **Name-based Tobacco resolution.** Renaming the "Tobacco" category (or naming a second category "Tobacco" — blocked by the `@@unique([tenantId,name])` index for exact case, and by the tracked-categories 409 for ci-dups only on subcategories, so a case-variant dup is theoretically possible) desyncs the mirror. Mitigation: single server-side definition, backfill script re-heals, documented in `common/tobacco-category.ts`. Watch in review that no client re-implements the name match.
- **Gating is immediate on deploy.** `AddonGuard` has no `PLAN_FLAG_ENFORCEMENT` kill switch (that switch only mutes `DARK_PLAN_FLAGS` in `PlanFlagGuard`). Tenants without the addon lose regulated ledger/filings surfaces the moment the deploy lands — hence runbook step 2.
- **Quick-toggle edge:** flagging tobacco on a product carrying reg codes from a non-CA template section now 400s (the section-move validation in `products.service.update` rejects codes the CA_CDTFA template can't express — deliberate: silently clearing them would restate filed reports). Loud and recoverable via the product form; population ≈ 0.
- **New side effect of the quick-toggle:** flagging now also assigns the category, so a newly-flagged product's order lines start splitting into a sibling invoice if the Tobacco type's treatment is `SEPARATE_INVOICE` — this is the intended one-axis behavior (web forms already cause it), but it is a behavior change vs. the old flag-only write; call it out in the PR description.
- **Spec 09 depends on the new addons mock** — if WP7 lands without WP4 the mock is harmless; if WP4 lands without WP7, spec 09 skips (its deploy-order guard) rather than fails.
- **Rollback:** no migration, so `git revert` of the PR restores everything server- and client-side. Data written by the sync/backfill (`trackedCategoryId` links, `isTobacco` mirrors, possibly a created "Tobacco" category) is exactly the state the OLD code also tolerated (the axes were independent before), so no data rollback is needed.

---

### Critical Files for Implementation

- C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco\apps\api\src\products\products.service.ts
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco\apps\api\src\tracked-categories\tracked-categories.service.ts
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco\apps\api\src\regulated\regulated.controller.ts
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco\apps\web\app\(dashboard)\compliance\[categoryId]\page.tsx
- C:\ClaudeCode\routeflow\.claude\worktrees\ap-tobacco\apps\web\app\(dashboard)\tobacco\page.tsx
