# Plan: address / maps gaps (migration 20260903, lowest priority)

> Status: IMPLEMENTED (2026-08-23, autopilot; clean=true, 4 findings + a pre-existing mobile create-flow break fixed, final full gate green) · Authored 2026-08-23 from the verified 2026-08-22 recon. This file is the ONLY
> context implementers receive.

## ⚠️ WORKTREE — read before anything else

ALL work happens in:

```
C:\ClaudeCode\routeflow\.claude\worktrees\ap-maps
```

Your process may start in `C:\ClaudeCode\routeflow` (main checkout) — do NOT touch files there.
`cd` into the worktree before ANY command; ABSOLUTE paths under the worktree for every edit.
Branch is already `feat/address-maps-extension`; do not commit, stage or push. NEVER touch
production or run `railway`.

## Context — most of "Google Maps integration" already exists

Web Places Autocomplete ships for Customer and Tenant addresses
(`apps/web/components/AddressAutocomplete.tsx` + `/public/places/autocomplete` and
`/public/places/details` endpoints), server-side geocoding exists, an interactive Google map exists
for route building, and route optimization runs on ORS (NOT Google — keep it that way). This task
closes three confirmed gaps only.

## Work packages

### WP1 — geocode on customer CREATE (files: `apps/api/src/customers/customers.service.ts`, `apps/api/src/customers/customers.service.spec.ts`)

Confirmed gap: `addAddress` geocodes, but `create()` writes the first address via
`customerAddress.createMany` WITHOUT geocoding — the common create-with-address flow leaves
lat/lng null forever. Read both methods first. Extract the geocode call from `addAddress` into one
private helper (e.g. `private async geocodeIfPossible(addr): Promise<{lat,lng}|null>` — keep the
existing failure semantics: geocode failure must NEVER fail the write) and use it for each address
in `create()` too. Note `createMany` cannot carry per-row computed values conditionally — either
geocode before building the rows array, or switch to sequential `create` calls only if the row
count is tiny (read the code; prefer geocode-then-createMany). Spec: create-with-address stores
lat/lng when the geocoder returns; geocoder failure still creates the customer with null lat/lng.

### WP2 — supplier geocoding + autocomplete (files: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260903000000_supplier_geocode/migration.sql`, `apps/api/src/suppliers/suppliers.service.ts`, `apps/api/src/suppliers/dto/create-supplier.dto.ts`, `apps/api/src/suppliers/dto/update-supplier.dto.ts`, `apps/web/app/(dashboard)/suppliers/page.tsx`)

1. Schema: add `lat Float?` and `lng Float?` to `model Supplier` (mirror how CustomerAddress
   declares them). Hand-write the migration SQL (Prisma 7: `prisma migrate dev` HANGS
   non-interactively — write `migration.sql` yourself):
   ```sql
   -- Add geocoding columns to Supplier (additive, nullable)
   ALTER TABLE "Supplier" ADD COLUMN "lat" DOUBLE PRECISION;
   ALTER TABLE "Supplier" ADD COLUMN "lng" DOUBLE PRECISION;
   ```
   Directory name EXACTLY `20260903000000_supplier_geocode`. Then regenerate the client
   (`npx prisma generate --schema apps/api/prisma/schema.prisma` from the WORKTREE root).
2. `suppliers.service.ts` create/update: geocode the address on write via the same
   helper/service WP1 uses (import it — coordinate: WP1 owns `customers.service.ts`; if the shared
   helper needs a new home, put it in a new small `apps/api/src/common/geocode.util.ts` and have
   BOTH packages import from there; WP1's brief allows this too — whoever needs it first creates
   it; the fixer resolves any duplication).
3. Web supplier form (find the supplier create/edit UI — likely on `suppliers/page.tsx` or a
   component it renders; adjust the file list in your report if it lives elsewhere): mount the
   EXISTING `AddressAutocomplete` component, wiring selections into the existing address fields.

### WP3 — mobile autocomplete parity (files: `apps/mobile/components/AddressAutocompleteInput.tsx`, `apps/mobile/app/(operator)/customers/new.tsx`, `apps/mobile/app/(operator)/customers/[id].tsx`)

New lightweight RN component: debounced TextInput (~300ms) → GET `/public/places/autocomplete` →
suggestion list → on pick GET `/public/places/details` → callback with structured address parts.
Use the SAME two public endpoints web uses (read `AddressAutocomplete.tsx` for request/response
shapes — no new backend). Wire into the mobile operator customer create/edit address fields
(locate the exact files; the two listed are the expectation — report if the address form lives in
a shared component instead and edit that). RN gotchas: give the TextInput an explicit width style
(intrinsic size-20 issue), render the suggestion list inline (not a Modal) to avoid portal-order
problems.

### WP4 — owner ops note (files: `docs/plans/maps-key-split-note.md`)

Short committed note (this path is tracked): one Google key currently serves server Places, server
Geocoding, and the browser Maps JS API. Recommend: split into an IP/API-restricted server key
(never exposed via `/public/places/config`) + an HTTP-referrer-restricted browser key; remove the
vestigial Mapbox config (locate and cite where it lives — grep `mapbox` case-insensitively and
list the files; do NOT delete it in this PR); note that maps calls have no per-tenant quota and
`MeterService` is the natural home if the owner wants a cap. Under 60 lines.

## Migration verification (WP2 owner does this; gate re-checks nothing DB-side)

Replay the FULL migration chain against a throwaway scratch DB in the local `routeflow_postgres`
container — from the worktree root:

```
docker exec routeflow_postgres psql -U postgres -c "CREATE DATABASE mig_scratch_maps"
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mig_scratch_maps" npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
docker exec routeflow_postgres psql -U postgres -d mig_scratch_maps -c "\d \"Supplier\""
docker exec routeflow_postgres psql -U postgres -c "DROP DATABASE mig_scratch_maps"
```

(Read `docker ps` first for the real container name/user; the compose file is at the repo root —
adapt user/password from `docker-compose.yml`, NEVER from any production value. If the container
is not running, note it as a deviation instead of starting services.) Confirm lat/lng exist in the
scratch DB before dropping. NEVER run migrate deploy against anything but a scratch DB you created.

## Explicitly OUT of scope

Google Directions/Distance Matrix (ORS stays) · map views beyond what exists · plan-gating/metering
maps (owner decision — WP4 documents it) · deleting the Mapbox config · `.claude/code-map`.

## Acceptance criteria

1. Creating a customer with an address geocodes it (spec-proven), and geocode failure never blocks
   the write.
2. Supplier create/edit geocodes; migration replays clean on a scratch DB; columns nullable.
3. Mobile customer address entry offers live suggestions using the existing public endpoints.
4. No change to ORS routing, no new Google API usage patterns beyond the existing three.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-maps && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-maps && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-maps && npm run test
```
