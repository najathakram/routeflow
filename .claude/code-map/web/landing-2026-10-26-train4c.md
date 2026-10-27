# Web landing 2026-10-26, train 4c (#3813 `305c10bc9`, #3767 `8f154e10c`; merge `b1a2fc3d1`)

Paths under `apps/web/`. Tests not indexed. Api part: `api/landing-2026-10-26-train4c.md`.

## #3813 `305c10bc9` app shells use the visible height on phones with a toolbar (364)
- `app/(dashboard)/layout.tsx`, `app/(platform-admin)/layout.tsx`: shell height uses `dvh`, not `vh`; pinned by `app/app-shell-dvh.static.test.ts`.

## #3767 `8f154e10c` restriction copy names the business's reason (W-806)
- `lib/api/restriction-warning.ts` (parity-tested against the api), `lib/restriction-rules.ts`, `lib/rule-chooser.ts`, `lib/unknown-state.ts`, `lib/portal-limits.ts`; `components/RestrictionWarningDialog.tsx`, `components/portal-limits/LimitInPortalDialog.tsx`; `app/(dashboard)/settings/restrictions/{page,rules/page,rules/[id]/page}.tsx`; `app/(dashboard)/products/[id]/PortalLimitsRow.tsx`. Copy only; no flow change.
