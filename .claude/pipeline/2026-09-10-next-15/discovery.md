# Next 14→15.5.25 discovery brief — `apps/web` (read-only, master `eb2b815e`)

Verifies §4 of `next-advisory-assessment.md` and extends it. Every claim is file:line or a registry/lockfile fact.

## 1. Version facts

| Registry query (`npm view`)           | Result                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next@15.5` latest                    | **15.5.25**                                                                                                                                                                                                         |
| `next` dist-tag `backport`            | **15.5.25** (matches target)                                                                                                                                                                                        |
| `next@15.5.25` peerDeps               | `react`/`react-dom`: `^18.2.0 \|\| 19.0.0-rc-de68d2f4-20241204 \|\| ^19.0.0`; `sass ^1.3.0`; `@playwright/test ^1.51.1`; `@opentelemetry/api ^1.1.0`                                                                |
| `eslint-config-next@15.5.25` peerDeps | `eslint ^7.23.0 \|\| ^8.0.0 \|\| ^9.0.0` — **unchanged from 14.2.35's peer range.** The task brief's premise that eslint-config-next 15 requires ESLint 9 is **not borne out**; ESLint 8 is still an accepted peer. |
| `eslint-config-next@15.5.25` deps     | `@next/eslint-plugin-next 15.5.25`, `eslint-plugin-react ^7.37.0`, `eslint-plugin-react-hooks ^5.0.0`, `@typescript-eslint/*` up to `^8.0.0`                                                                        |

**`apps/web/package.json`**: `"next": "14.2.35"` (:44); `"react"/"react-dom": "^18"` (:45,:47) — **stale**, rest of repo is React 19; devDeps `"@types/react": "~19.2.2"` (:66), `"@types/react-dom": "^19.0.0"` (:67), `"eslint-config-next": "14.2.35"` (:69), `"eslint": "^8"` (:68); `optionalDependencies` `"@next/swc-win32-x64-msvc": "^14.2.33"` (:56) — only `@next/*` package present, no `@next/bundle-analyzer` anywhere (0 hits).

**Hoist/skew (verified in `package-lock.json` `packages` map):** root `node_modules/react` = **19.2.5**, root `node_modules/react-dom` = **18.3.1** (already-skewed pair at root); nested `apps/web/node_modules/react` = **18.3.1** (no nested react-dom, resolves to root's 18.3.1); `@types/react` 19.2.2, `@types/react-dom` 19.2.3, `react-test-renderer` 19.2.0. `apps/mobile/package.json:60-61` pins `"react"/"react-dom": "19.2.0"` exactly, devDep `:86` `"react-test-renderer": "19.2.0"` — pinned to mobile's react, confirming these two move together, untouched by a web-only bump.

**`apps/web/Dockerfile:34-48`** pins React 18 at the image root before build:

```
RUN npm install --force --no-save react@18.3.1 react-dom@18.3.1
```

Comment: mobile's React 19 hoists to `/app/node_modules`, leaving web's React 18 nested; hoisted Next 14 then resolves React 19 and fails (`Cannot find module 'react-dom/server.browser'`). Decision line: _"revisit only alongside a Next 15 upgrade (which supports React 19 natively), not standalone"_ (:46-47). Introduced at `c6b78eeb` (#94), still present at HEAD.

**A second skew workaround, not in the assessment: `apps/web/jest.config.js`, the moduleNameMapper block at base lines 28-60 (React-skew-hack comment 30-54, the `^react$` entry at :55).** Because `apps/web/package.json` pins React 18 while `@types/react` is 19.2.2 and every other workspace is React 19, Jest sees two live `react` instances (Radix via hoisted react@19, web's own files via nested react@18), crashing Radix renders (`"Cannot read properties of undefined (reading 'ReactCurrentDispatcher')"`). Fixed there via `moduleNameMapper` forcing one instance; the comment calls the underlying range drift "a real dependency bug — flagged separately, not fixed here." **Moving `apps/web/package.json`'s react/react-dom to `^19` as part of this bump removes the root cause of both this hack and the Dockerfile hack** — a positive side effect for the spec, not a new risk.

## 2. Breaking-change inventory

**(a) Sync `params`/`searchParams` — VERIFIED 18, matching the assessment.** Method: grepped `app/**` for `params.`/`searchParams.` (64 files, mostly `useSearchParams()`/`useParams()` client hooks and unrelated axios `{ params: {...} }` configs), narrowed to files whose `page.tsx` destructures the prop directly (29 candidates), read each header+signature.

0 of 6 `layout.tsx` files touch either prop. 0 `route.ts` files — the app has exactly one, `app/api/health/route.ts`, no params. 0 `generateMetadata` exports anywhere.

- **17 files**: `"use client"` page, `{ params }: { params: { <slug>: string } }` sync destructure — `(dashboard)/{customers,drivers,sales-agents,estimates,vendor-bills,products,orders,invoices,routes,returns,credit-notes,compliance}/[id or categoryId]/page.tsx`, `bookkeeping/[transactionId]/page.tsx`, `routes/templates/[id]/page.tsx`, `routes/[id]/dispatch/page.tsx`, `invoices/[id]/edit/page.tsx`, `finance/commissions/[id]/page.tsx`.
- **1 file**: `(dashboard)/finance/expenses/page.tsx:8-12`, Server Component (no `"use client"`), sync `searchParams` prop: `({ searchParams }: { searchParams: { [key: string]: string | string[] | undefined } })`.

Every `[id]` page is a Client Component receiving `params` synchronously; in 15 it becomes a `Promise`, so each needs React 19's `use()` hook (already installed at root) or a thin Server-Component wrapper — same mechanical fix, 17 times.

**False positives to not recount:** `buyer/portal/[seller]/**` (11 files) all use `useParams()` (client hook, unaffected). `orders/page.tsx`, `admin/audit-logs/page.tsx` use `useSearchParams()`. `invoices/page.tsx`, `vendor-bills/page.tsx`, `estimates/page.tsx`, `invoices/new/page.tsx`, `analytics/page.tsx` matched only an unrelated axios `{ params: {...} }` config. `admin/tenants/page.tsx`, `admin/buyers/page.tsx`, `admin/buyers/merge-requests/page.tsx` matched only a local `new URLSearchParams()` variable named `params`.

**(b) `cookies()`/`headers()`/`draftMode()` — VERIFIED 0.** `grep "next/headers"` → no matches.

**(c) `next.config.mjs` keys** (full read): `output: "standalone"` (:10) unchanged. `turbopack: { root }` (:16-18) — comment at :14 already says _"Next 16 + Turbopack picks the wrong root"_, i.e. added anticipating 16, confirms this key is stable across 15→16. `eslint.ignoreDuringBuilds`/`typescript.ignoreBuildErrors` (:26-31) unchanged. `experimental.serverComponentsExternalPackages: []` (:39) — **renamed** to top-level `serverExternalPackages` in 15; value is empty so functionally a no-op rename, 1 site. No `images` key at all (confirms assessment). No `swcMinify`.

**(d) `middleware.ts`** (283 lines, full read): no `request.geo`/`.ip` anywhere (both removed in 15) — 0 sites. `matcher` (:281) `["/((?!_next/static|_next/image|favicon.ico).*)"]` excludes `/_next/image` (backs the assessment's mitigation-3), unchanged regex, no 15-specific edit needed.

**(e) Caching defaults:** `export const dynamic = "force-dynamic"` at 5 sites (`(auth)/callback/page.tsx:3`, `auth/google/callback/page.tsx:3`, `buyer/verify-merge/page.tsx:11`, `platform/auth/callback/page.tsx:3`, `api/health/route.ts:27`); `revalidate = 0` at `api/health/route.ts:28`. 0 `fetch(..., {cache})`, 0 `force-cache`, 0 `unstable_cache`. Data goes through axios/TanStack Query, not `fetch()` — Next 15's fetch-default flip (`force-cache`→`no-store`) has **no observable effect** here.

**(f) Fonts/Script/dynamic/Actions:** `app/fonts.ts:1,8-20` uses `next/font/local` for self-hosted Geist (CLAUDE.md heavy-files exception) — **but `app/layout.tsx:2`** also imports `Inter, Instrument_Serif, Spline_Sans, Spline_Sans_Mono` from **`next/font/google`**, applied at `:106`. This contradicts a self-hosted-only framing: it's the live source of the Docker Google-Fonts-fetch risk from memory (`fonts.gstatic.com` fetched at `next build` time in the Dockerfile builder stage). Pre-existing (Next 14 too), not new, but re-exercised by any rebuild. `next/script`: 0 usages. `ssr:false`: 0. `useFormState`/`useActionState`/`"use server"`: 0. `unstable_*`: 0.

**(g) React 19:** `forwardRef` — 5 usages (`PortalSwitchLink.tsx`, `MarginHint.tsx`, `CommandPalette.tsx`, `MoneyInput.tsx`, `products/_components/QuickEditCell.tsx`) — deprecated not removed, no forced rewrite. `ReactDOM.render`/`react-dom/test-utils`: 0. No-arg `useRef()`: 0. `React.FC`: 0. `@testing-library/react` installed = **16.3.3** (root-hoisted), peer range `react ^18.0.0 || ^19.0.0` — already React-19-compatible, `apps/web/package.json:62`'s `"^16"` pin is already correct. Root `package.json` `overrides` (:78-85) pin `jest`/`jest-environment-jsdom`/`@jest/*` family to `30.2.0` — the override memory flags for any Dependabot bump; unaffected by this bump but should be diffed if one lands in the same window. `packages/ui/package.json:36-48` peerDeps `react ">=18.0.0"` (no ceiling) — already open to 19.

**(h) ESLint:** `apps/web/eslint.config.mjs` (24 lines) uses `FlatCompat` to load `"next/core-web-vitals"`/`"next/typescript"` as legacy shareable-config strings (Next-14 pattern). `apps/web/package.json` pins `eslint ^8` (:68); nested `apps/web/node_modules/eslint` = 8.57.1 vs root-hoisted 9.39.4 — a second version skew, same shape as React's. `packages/eslint-config/next.js` (used by mobile, not web) already uses pure ESLint 9 flat config with `@next/eslint-plugin-next` directly, no `FlatCompat`. Per §1, 15.5.25 still accepts ESLint 8, so this is **not forced** — but it's the most out-of-step config in the repo, worth a spec decision on aligning web to the same pattern.

## 3. Build/deploy

`apps/web/Dockerfile`, two `node:20-alpine` stages (:2,:71). Builder: copies manifests, then `packages/pricing/` in full (its tsconfig extends `@routeflow/typescript-config/base.json`, resolved during root `postinstall`'s tsc build inside `npm ci` — comments :12-23), `apps/web/package.json`, `npm ci` (:32), the React-18 force-pin (:48), full source copy (:51-52), build args `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_GOOGLE_MAPS_KEY` baked in (:60-64), `rm -rf .next && npm run build` (:68). Runner: copies only `.next/standalone`, `.next/static`, `public` (:81,85,88) — no `sharp`, matching the advisory's AVIF-unreachable proof; non-root `node` user (:98); `CMD ["node","apps/web/server.js"]` (:101) — unchanged standalone contract in 15.

`apps/web/railway.toml`: `builder="DOCKERFILE"`, `dockerfilePath="apps/web/Dockerfile"`, `watchPatterns=["apps/web/**","packages/**"]`, `healthcheckPath="/login"`, 120s timeout, restart×3 — no version-specific settings.

Compose `web` (`docker-compose.yml:158-179`): same Dockerfile, build arg `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1`, `3001:3000`, healthcheck `wget http://127.0.0.1:3000/login` — this is the CLAUDE.md-mandated production proof since host `next build` is broken by the react hoist skew (memory).

Google Fonts: per §2f, `layout.tsx` genuinely needs `fonts.gstatic.com`/`fonts.googleapis.com` egress at build time inside the builder stage — pre-existing, re-exercised by any rebuild including this one.

## 4. Test surface

VERIFIED, both match the assessment exactly: **50** Jest test files under `apps/web`; **37** Playwright specs in `apps/web/e2e`.

`local:e2e` allow-list (root `package.json:35`, `--workers=1`): `setup`, `critical-paths`, `create-order-escape`, `boxed-order-entry`, `order-edit-pricing`, `payment-truth`, `destructive-guards`, `cancelled-edit-banner`.

Coverage of the 18 §2a files: only 3 directories have a co-located Jest test (`customers/[id]`, `bookkeeping/[transactionId]`, `products/[id]`). A literal path-string grep of the 37 e2e specs for the other 15 route segments surfaces only 4 files (`09-regulated-compliance`, `13-boxed-order-entry`, `23-run-settlement-note`, `24-order-edit-pricing.spec.ts`) — likely an undercount since specs usually navigate via UI clicks, not literal URLs, but a genuine coverage-thinness signal for the test plan: direct regression signal on 15 of 18 touched pages is weak, though `critical-paths` and `payment-truth` (both in the `local:e2e` allow-list) are the most likely to exercise them indirectly.

## 5. Rollback + risks

No Prisma migration involved. `git revert` of the squash restores `apps/web/package.json`, `package-lock.json`, `next.config.mjs`, `Dockerfile`, the 17 `[id]` page files, `finance/expenses/page.tsx`, and `jest.config.js` (if trimmed) in one commit; nothing outside `apps/web` (possibly root `package.json`/lockfile) is touched. Railway redeploys the reverted commit automatically; no manual DB step. Production proof before merge is the same compose `web` build CLAUDE.md already mandates.

**Top risks, ranked:**

1. **Two-layer React skew workaround** (Dockerfile force-pin + `jest.config.js` moduleNameMapper, §1) — a bump to React 19 in `apps/web/package.json` must remove/verify BOTH; missing one leaves a stale hack that can silently break every RTL suite (mapper forcing a require path that no longer matches real resolution).
2. **`next/font/google` is a live external-network build dependency** (§2f/§3), independent of this bump but re-exercised by every rebuild — a `fonts.gstatic.com` failure blocks the mandatory compose-build proof, unrelated to the version bump itself but on its critical path.
3. **17 near-identical mechanical fixes** (§2a) with thin direct test coverage (3/18 co-located Jest tests, §4) — high copy-paste-error surface for the `use()`-hook rewrite.
4. **`eslint.ignoreDuringBuilds`/`typescript.ignoreBuildErrors`** (next.config.mjs:26-31) mean the Docker build won't surface a broken `[id]`-page type error — `check-types`/`lint` (run separately per the file's own comment) are the only gates that catch it before the compose-build proof even renders the page.
5. **`@next/swc-win32-x64-msvc` pinned `^14.2.33`** (:56) must move with `next` itself or Windows-host `npm install`/`next dev` (the owner's actual dev workflow) resolves a mismatched native SWC binary.
