# Owner note: split the Google Maps key

## Current state

One Google API key (`GOOGLE_MAPS_API_KEY` / `AppConfig.googleMaps.apiKey`) currently serves three
call sites:

- Server-side Places Autocomplete + Place Details
  (`apps/api/src/tenants/public-places.controller.ts`, `GET /public/places/autocomplete` and
  `/details`).
- The same key is handed straight to the browser via `GET /public/places/config`
  (`publicConfig()` in the same controller) so the web app can load the Maps JS SDK client-side.
- Server-side Geocoding for supplier/customer addresses (`apps/api/src/config/configuration.ts`,
  `googleMaps.apiKey`).

Because it's one key, it can't be locked down to "server API restrictions" (Places + Geocoding,
no HTTP referrer) without also breaking the browser Maps JS usage, which needs the opposite
restriction (HTTP referrer, no IP/server lock).

## Recommendation: split into two keys

1. **Server key** — restrict to Places API (New) + Geocoding API, IP-restricted to Railway's
   egress if feasible (or left unrestricted-by-referrer if not). Used only by
   `configuration.ts` → `googleMaps.apiKey` and the autocomplete/details handlers. **Never**
   returned by `/public/places/config` — that endpoint must only ever serve the browser key.
2. **Browser key** — restrict by HTTP referrer to the deployed web origins
   (`www.routeflow.info`, any staging origin). Used only for `publicConfig()` /
   `NEXT_PUBLIC`-style Maps JS bootstrapping.

Both keys are created in the same Google Cloud project; only the restrictions and the env var
they're read from differ. This is a config/console change plus a small code change (new env var,
`publicConfig()` reads the browser key instead of `apiKey`) — not part of this PR.

## Vestigial Mapbox config (do not delete here)

Mapbox is unused in the actual Places/Geocoding flow but its config still exists:

- `apps/api/src/config/configuration.ts:84` and `:149-150` — `mapbox.accessToken` reads
  `MAPBOX_ACCESS_TOKEN`.
- `apps/web/components/AddressAutocomplete.tsx:22,91` — comments referencing Mapbox's
  address-parts-inline behavior (dead code path, Google is what's wired up).

Left in place intentionally; a future cleanup PR can remove it once confirmed nothing references
it.

## No per-tenant quota today

Places autocomplete/details and geocoding calls are throttled per-IP (`@Throttle`) but have no
per-tenant metering or cap — a single noisy tenant can consume the whole project's Google quota.
If the owner wants a cap, `MeterService` (billing) is the natural home: it already tracks
per-tenant usage counters for other metered features, so a `mapsLookups` counter there would slot
in without a new subsystem.
