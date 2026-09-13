# web — Unit tests (Jest + RTL)

> Split from `.claude/code-map/web.md` (verbatim, lines 903-1020) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Unit tests (Jest + RTL) (wave D, item 5, 2026-09-03)

`apps/web` previously had **zero** unit/component tests (Playwright E2E only — the gap
[`docs/IMPROVEMENTS.md`](../../docs/IMPROVEMENTS.md) item 5 flagged). Now 19 spec files, run via
`npm test -w apps/web` (script `"test": "jest"`) or `npm run test` (Turbo `test` task; `apps/web`
now contributes alongside api/mobile).

- **Next 15 `useParams()` migration (2026-09-10, `chore/next-15` #5b3b3c4e)** — every dynamic
  Client Component page dropped the old synchronous `{ params }: { params: { id: string } }` prop
  for `const params = useParams(); const id = params.id as string;` (`useParams` added to the
  `next/navigation` import). Mechanical, one shape, 16 pages: `drivers/[id]`, `estimates/[id]`,
  `orders/[id]`, `products/[id]`, `invoices/[id]`, `invoices/[id]/edit`, `credit-notes/[id]`,
  `vendor-bills/[id]`, `returns/[id]`, `sales-agents/[id]`, `finance/commissions/[id]`,
  `compliance/[categoryId]`, `bookkeeping/[transactionId]`, `routes/[id]`,
  `routes/[id]/dispatch`, `routes/templates/[id]`. **`customers/[id]/page.tsx` is the exception**
  (two sites, not one — `client-page-params.spec.ts` counts by site): the default export
  (`CustomerDetailPage`, the `<React.Suspense>` wrapper for its `useSearchParams()` deep link)
  now calls `useParams()` and passes `id` as a plain `string` prop into
  `CustomerDetailPageInner({ id }: { id: string })`, which no longer takes `params` at all.
  Guard: `apps/api/src/common/client-page-params.spec.ts` (T3) — a repo-wide source-text scan for
  the three old-prop shapes (destructure / `props.params` / body-destructure) and, for Server
  Components, an un-awaited `params:`/`searchParams:` annotation.
- **`jest.config.js`** — built on `next/jest` (`createJestConfig`), `testEnvironment: "jsdom"`,
  `setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"]`. **Campaign gate artifact (2026-09-08, #686):**
  `reporters` wires `["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "web" }]`,
  writing `.campaign/runs/web.json` so `scripts/campaign-check.mjs` can discharge REG-B### pins
  living in `apps/web` (e.g. `lib/api/*.test.tsx`) — before this, apps/web never ran the
  reporter and the gate reported "no test titled with REG-B## found" for every web-hosted pin
  (#683). Guard: `apps/api/src/common/campaign-check-web-report.spec.ts` (see [`api`](api.md)).
  Opts out of `next/jest`'s optional-dependency
  lockfile auto-patch via `NEXT_IGNORE_INCORRECT_LOCKFILE=1` (network call to the npm registry is
  unavailable in this environment and would abort config load; the lockfile itself is pD1's, not
  touched here). ⚠️ **`testMatch` is deliberately `["**/*.test.{ts,tsx}"]`, NOT the
  `<rootDir>`-anchored form the brief suggested** — every worktree in this repo lives under
  `.claude/worktrees/<name>`, so a rootDir-substituted glob always contains a `\.claude` segment
  on Windows; `jest-config`'s `replacePathSepForGlob()` converts `\`→`/` EXCEPT when the backslash
  precedes `$()+.?^{}` (assumed an escaped glob char), so that one separator survives literally and
  picomatch then compiles `\.` as an escaped dot — matching nothing (confirmed via
  `npx jest --listTests` returning empty). `roots: ["<rootDir>/{app,components,lib,hooks}"]` scopes
  discovery instead, so the plain relative glob needs no rootDir anchor. Lesson **L-055**.
  **REMOVED (2026-09-10, `chore/next-15` #5b3b3c4e):** the `moduleNameMapper` single-`react`-
  instance pin (`^react$`/`^react/jsx-runtime$`/`^react/jsx-dev-runtime$` →
  `<rootDir>/node_modules/react`) that worked around `apps/web` pinning React 18 while the rest of
  the repo ran React 19. The upgrade moves `apps/web`'s own `package.json` to `"react": "^19.2.0"`
  (matching `next@15.5.25`'s peer range), so there is one React major repo-wide and the pin's
  reason for existing is gone — do not restore it. Guard:
  `apps/api/src/common/no-react-skew-hacks.spec.ts` (T2) pins BOTH this and the Dockerfile removal
  below as a pair — a half-reverted skew (one hack back, the other still gone) breaks every RTL
  suite. **`testTimeout: 30_000`** (2026-09-05): RTL suites
  mount the real providers and pay a cold SWC compile on each file's first test; under pre-push /
  CI load on a slow host that overran Jest's 5 s default twice (portal-switch T10, buyer-portal
  connect-seller) as a _timeout_, not an assertion — the ceiling is raised, green tests are no slower.
- **`package.json` / `Dockerfile` (2026-09-10, `chore/next-15` #5b3b3c4e)** — `next` 14.2.35 →
  `15.5.25`, `react`/`react-dom` `^18` → `^19.2.0`, `eslint` `^8` → `^9`, `eslint-config-next` →
  `15.5.25`, `@next/swc-win32-x64-msvc` → `^15.5.25` (pins: `next-version.spec.ts` T1).
  `Dockerfile`'s `RUN npm install --force --no-save react@18.3.1 react-dom@18.3.1` (the root-level
  React-18 hoisting hack the [[L-062]]-adjacent jest note above referenced) is **deleted** — Next
  15 accepts React 19 natively, so the production build no longer needs a second, force-installed
  React copy at the image root. See `docs/testing/lockfile-edges.md`'s "Unsatisfied peer ranges"
  section, now at 0 (was 2 — the React 18/19 peer clash and the ESLint 9-vs-Next-14-peer warning,
  both resolved by this bump). Guard: `apps/api/src/common/no-react-skew-hacks.spec.ts` (T2, pairs
  with the `jest.config.js` removal in 1b).
- **`jest.setup.ts`** — `import "@testing-library/jest-dom"` plus RTL
  `configure({ asyncUtilTimeout: 10_000 })` (findBy*/waitFor headroom on slow hosts; pairs with
  `testTimeout` above).
- **`test-utils/render.tsx`** — `renderWithProviders(ui, opts)` (re-exports RTL +
  `createTestQueryClient()`: retries off, no caching). Wraps `QueryClientProvider` →
  `ToastProvider` → `I18nProvider` → `BuyerAuthProvider` → `AuthProvider` — the REAL context
  providers (safe with zero mocking as long as a test doesn't seed localStorage with a token,
  since both auth providers' refresh calls short-circuit to `null` with no network call when
  unauthenticated). Deliberately excludes `TenantProvider`/`ReAuthProvider` (both have safe
  non-null defaults without a real provider).
- **`lib/` suites (4)** — `api-client.test.ts`, `format.test.ts`, `formatting.test.ts`,
  `tenant-host.test.ts` (the last pins `tenantSlugFromHostname()`, the single source of truth
  documented above under "App shell & lib" — never re-inline its rules).
- **Component specs (15)** — auth surfaces: `app/(auth)/{login,forgot-password}/page.test.tsx`,
  `app/buyer/{login,forgot-password,portal}/page.test.tsx`; settings:
  `app/(dashboard)/settings/settings-{password,profile,users}.test.tsx`; domain modals/cards:
  `app/(dashboard)/bookkeeping/[transactionId]/page.test.tsx`,
  `app/(dashboard)/drivers/_components/{Add,Edit}DriverModal.test.tsx`,
  `app/(dashboard)/orders/_components/CreateOrderModal.test.tsx`,
  `app/(dashboard)/products/[id]/SalesHistoryCard.test.tsx`,
  `app/(dashboard)/routes/_components/late-stops.test.ts` (F12, PR #652 — `lateStopsFromAnalysis`;
  `CreateRouteModal.tsx`+`.test.tsx` DELETED same PR, B31 dead code),
  `components/MoneyInput.test.tsx`.
- **Auth-redesign specs (PR #663, spec 46)** — `components/auth/AuthShell.test.tsx`
  (`describe("AuthShell — T1")`, the shell component itself); `app/(auth)/auth-redesign.static.test.ts`
  (454 lines, 12 `describe`s: all 15 pages render `AuthShell` — T2a; `.rf-auth` CSS scoping —
  T2c/D10(b); RF monogram removed from forgot/reset/change-password — T2d; `auth-copy.ts` exports
  `AUTH_STORY` — T2f; `audience` prop matches route family — T2g; buttons use `.rf-btn` — T2h; ONE
  `h1` — T2j; success blocks carry `.rf-auth-success` — T2i; D1 pages compute their title rather
  than a literal — D10(a); no low-contrast emerald link utility on a buyer page — D10(c); fenced
  headings carry no trailing period — D10(d)); `app/(auth)/auth-redesign.guards.test.ts` (127
  lines, 2 `describe`s: no design-preview leftovers — T2b; no `next/image` import — T2e).
  **`app/(auth)/login/page.test.tsx` now module-mocks `@/lib/tenant-host` and
  `@/components/tenant-provider` for the whole file** — its assertions no longer exercise
  `tenantSlugFromHostname` directly (still covered by `lib/tenant-host.test.ts`); fidelity-loss
  note, registry B260.
- **Marketing-port specs (11, PR #657)** — static guards: `components/no-next-image.test.ts`
  (walks `app/`+`components/` for any `next/image` import — see `components/brand/` above),
  `app/(marketing)/marketing-port.static.test.ts` (MKT-PIN: dead asset/dependency scans,
  `globals.css`/`tailwind.config.ts` byte-identical to the branch baseline, one tokenised
  `--ring` focus rule — the two-colours-hardcoded finding from review is fixed and pinned here;
  plus a `.signin-menu [role="menuitem"]` CSS-rule-parser pin, R-MKT signin-menu, PR #673
  [[L-098]]: structural `display: flex` + `white-space: nowrap`, the anchor's own `:focus-visible`
  ring, no inner-child outline),
  `app/(marketing)/middleware.marketing.test.ts` (`lib/site.ts#routes` ↔
  `lib/marketing-routes.ts#MARKETING_PAGE_PATHS` parity), `app/(marketing)/seo.test.ts`,
  `lib/marketing-routes.test.ts`, `app/(marketing)/lib/operation-model.test.ts`. Component:
  `components/brand/BrandMark.test.tsx`, `app/(marketing)/components/{site-header,marketing,faq,
demo-form}.test.tsx`.
- **`app/(marketing)/distributors-redirect.static.test.ts` (PR #665, `/distributors` follow-through,
  [[L-093]])** — pins the `next.config.mjs` `redirects()` entry (loaded via a real
  `node --input-type=module` subprocess import of the config, since Jest/`next/jest`'s transform
  collides with the config's own `__dirname` binding — same technique `lib/csp.test.ts` uses) and
  the absence of `app/(marketing)/distributors/page.tsx`, so the alias can never regress back to a
  prerendered `redirect()` page.

