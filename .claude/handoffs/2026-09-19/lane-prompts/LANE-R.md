# Lane R — category labels + jurisdiction selling restrictions (window title: "RouteFlow Lane R")

Read `LANE-COMMON.md` first. Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-R`, branches `feat/r-<step>`.
If the owner opens TWO R sessions: "RouteFlow Lane R-service" takes steps 1–3, "RouteFlow Lane
R-ui" takes steps 4–6 and waits for step 1's PR before wiring UI to the service.
Plan: `local-assets/handoff/2026-09-18/PLAN-categories-jurisdiction-bans.md`. Evaluation card
R1. Feature is OFF by default per tenant (`sellingRestrictionsEnabled` setting, master
off-switch) — the OFF state is a first-class outcome, never a bypass.

## Owner rulings
- Three distinct outcomes never share a code path: feature OFF · ON with no matching rule ·
  ON but INDETERMINATE (missing/unnormalized address) → fail closed (block + explain).
- Governing address = the customer's DEFAULT address (D4); a tenant setting chooses billing
  vs shipping precedence. No licensed-premises field now.
- Rules are written by TENANT_ADMIN only. Block quantity INCREASES on a line that became
  restricted after it was created; decreases and removals stay allowed.
- Address normalization runs BEFORE rules can go live; the OWNER runs the prod script.
- A variant may opt OUT of a parent's category label (e.g. a THC-free variant).

## What already exists (do not rebuild)
`ProductCategoryLabel`, `SellingRestriction` (categoryId XOR productId, jurisdiction
FEDERAL|STATE, `states String[]` USPS codes, surface, effectiveFrom/To, lift audit),
`CustomerAddress.stateCode Char(2)` — all on master via #936. Google Maps keys exist (three;
see memory `project_maps_key_architecture`). Enforcement points (plan §3, 9 of them):
`create`, `changeStatus`, `updateOrderItems`, `approveChangeRequestAtStop`, templates,
recurring invoices, `createSplitInvoices`, `update`/`duplicate`, `convertToInvoice`.

## Order of work (one PR each; est. builder-days)
1. **`SellingRestrictionsService`** — `evaluate(tenantId, customerId, lines[]) → {outcome: OFF|ALLOW|BLOCK|INDETERMINATE, reasons[]}`; resolves the governing address per tenant precedence; matches by product OR any of its labels (respecting variant opt-out); effective window; FEDERAL rows ignore the address. Pure core + thin Prisma adapter; exhaustive unit specs for the three outcomes. 1.5
2. **One choke point + meta-spec** — `assertLinesSellable()` called from every line-writing
   path above; `selling-restrictions-coverage.spec.ts` greps/imports each path and fails the
   build if one is missing (`no-bare-cron.spec.ts` is the template). Block qty increases on
   pre-ban lines. Opus review mandatory. 2.5
3. **Address normalization script** — `apps/api/scripts/normalize-address-states.mjs`:
   free-text state → `stateCode` (USPS table for exact/alias matches; Google Address
   Validation `administrativeArea` for the rest; unresolvable rows listed, never guessed);
   dry-run → live with `--backup-attested`, id-pinned, test-tenant-first, same guard
   conventions as `backfill-legacy-tenant-ids.mjs`. Hand the command to the lead for the
   owner. 1.0
4. **Category labels API + UI** — many-to-many labels on products, variant opt-out toggle,
   label manager page (Radix + Tailwind, existing design system). 1.5
5. **Restrictions admin + buyer catalog** — TENANT_ADMIN rule editor (category|product ×
   FEDERAL|state list × surface × effective window × reason; lift with reason); buyer portal
   hides/blocks restricted products for that customer's jurisdiction with the explanation. 2.0
6. **Tenant settings + mobile** — feature switch, address precedence; mobile shows the block
   reason on order screens (read-only). 1.0

Proof: unit specs per outcome; F proves each of the 9 enforcement points with a banned line
against the `test` tenant (post PROOF-REQ with the fixture recipe); Playwright 1440/768/390
for the two admin pages and the buyer view.
