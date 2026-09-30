# Test plan — auth-redesign

Rule: every R# has a T#; every T# names its R#, level, Given/When/Then and a concrete oracle known
independently of the implementation. Red-gate scope = T1 + T2 **minus the absence guards** (an assertion
that something is ABSENT is green on today's tree, so it can never be a red-gate test): the guards live in
`app/(auth)/auth-redesign.guards.test.ts` and are green by design, listed under T4. Everything left in
`components/auth/AuthShell.test.tsx` and `app/(auth)/auth-redesign.static.test.ts` must FAIL today on its
own assertion. T4/T6 are the regression fence (existing tests, untouched, must stay green). T5 is
post-deploy (never in the gate; it runs in the deployment E2E through its `playwright.config.ts` project
entry).

## New tests

### T1 — `apps/web/components/auth/AuthShell.test.tsx` (unit, RTL) — R1, R4

- Given the module `@/components/auth` is loaded through `let mod: any = null; try { mod =
require("@/components/auth"); } catch { mod = null; }` — When `expect(mod?.AuthShell).toBeDefined()`
  runs — Then it FAILS today with `expected undefined to be defined` (behavioural red), passes after.
- T1a: render `<AuthShell audience="distributor" kicker="Distributor workspace" title="Welcome back."
lead="Sign in to your distributor workspace."><form aria-label="probe" /></AuthShell>` → `screen.getByRole
("main")` has class `rf-auth` and id `main-content`; `getByRole("heading", { level: 1 })` text is exactly
  `Welcome back.`; `getByRole("heading", { level: 2 })` text is exactly `A clearer picture of your
business.`; `getByText("For distributors")` is inside `.rf-auth-story-copy`; `getByText("Distributor
workspace")` is inside `.rf-auth-card`; the probe form is inside `.rf-auth-card`; `getByRole("link", {
name: /back to website/i })` has `href="/"`; `getByRole("link", { name: /need help/i })` has
  `href="/contact"`; `getByRole("link", { name: /routeflow home/i })` exists (the `Brand` link).
- T1b: `audience="retailer"` → h2 text exactly `Stock your shelves. Stay in control.`; `getByText("For
retailers")`; no `For distributors` text.
- T1c: `logoUrl="/x.png" logoAlt="Acme"` → an `img` with `alt="Acme"` and `src="/x.png"` inside
  `.rf-auth-card`; without `logoUrl` no such img.
- T1d: `footer={<a href="/buyer/login">Sign in to the buyer portal</a>}` → that link renders inside
  `.rf-auth-footer` before the `Need help?` link.
- T1e: exactly one `h1` in the document; the order card text `Order RF-1042` is present and its container
  has `aria-hidden="true"`.

### T2 — `apps/web/app/(auth)/auth-redesign.static.test.ts` (static, node) — R2, R3, R4, R5, R7, R8, R11

Reads files with `fs` relative to `apps/web` (pattern: `app/(marketing)/marketing-port.static.test.ts`).

- T2a: for each of the 15 page paths (list them literally: `app/(auth)/login/page.tsx`,
  `app/(auth)/signup/page.tsx`, `app/(auth)/signup/check-email/page.tsx`,
  `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/page.tsx`, `app/buyer/login/page.tsx`,
  `app/buyer/register/page.tsx`, `app/buyer/forgot-password/page.tsx`, `app/buyer/reset-password/page.tsx`,
  `app/buyer/verify-email/page.tsx`, `app/buyer/verify-merge/page.tsx`, `app/buyer/change-password/page.tsx`,
  `app/buyer/invite/[token]/page.tsx`, `app/change-password/page.tsx`, `app/verify-email/page.tsx`): the
  source matches `/from "@\/components\/auth"/` AND contains `<AuthShell`. Oracle today: 0 of 15 match →
  `expect(missing).toEqual([])` fails listing all 15.
- T2b **(guard file, green by design — see T4)**: none of the 13 sources, nor `components/auth/**`,
  contains `rf-preview-note`, `Design preview`, `Sample-only`, `demo@example.com`, `useHydrated`, or
  `readOnly` (R3). `routeflow.info` is deliberately NOT banned — its only occurrences are legitimate
  tenant-subdomain explanatory comments in `app/(auth)/login/page.tsx` (lines 38, 40, 165, 166), so banning
  it would only be satisfiable by deleting correct documentation. The scan skips `*.test.*` files.
- T2c: `components/auth/auth-shell.css` exists and contains `--rf-navy: #10264d`, `--rf-plum: #623691`,
  `--rf-muted: #616b7c`, `@media (max-width: 850px)`, `prefers-reduced-motion`, `var(--font-geist-sans)`.
  A missing file reads as `""` (no `existsSync` short-circuit) so each token case fails on the token it
  names, not on a shared file-missing proxy; the dedicated `exists (T2c)` test owns the existence oracle.
  The "does NOT contain `@font-face` or `url(`" half is an absence guard → guard file, green by design.
- T2d: `app/(auth)/forgot-password/page.tsx` and `app/(auth)/reset-password/page.tsx` no longer contain the
  monogram (`>RF<` or `"RF"` inside a `bg-brand-500` div) (R8). Oracle today: both contain it.
- T2e **(guard file, green by design — see T4; narrows the repo-wide T3 to the auth surface)**: none of the
  13 sources or `components/auth/**` imports `next/image` (R8).
- T2f: `components/auth/auth-copy.ts` exports `AUTH_STORY` with keys `distributor` and `retailer`, each
  with `kicker`, `heading`, `paragraph` strings; `AUTH_STORY.distributor.heading === "A clearer picture of
your business."`, `AUTH_STORY.retailer.heading === "Stock your shelves. Stay in control."`. A missing
  module reads as `{}` (no `existsSync` short-circuit) so each heading case fails on its own string oracle
  (`expected "…" received undefined`); the dedicated `exists and exports` test owns the existence oracle.
- T2g: every page whose `<AuthShell` call has `audience="retailer"` lives under `app/buyer/`, and every
  other listed page (`app/(auth)/**` plus the operator `app/change-password` and `app/verify-email`) uses
  `audience="distributor"`.
- T2i: each of the 8 pages that owns a success/done state (`app/(auth)/forgot-password`,
  `app/(auth)/reset-password`, `app/(auth)/signup/check-email`, `app/buyer/forgot-password`,
  `app/buyer/reset-password`, `app/buyer/verify-email`, `app/buyer/verify-merge`,
  `app/buyer/invite/[token]`, all `page.tsx`) contains `rf-auth-success` (R13). Those states need a
  live token or email, so they are impractical signed-out in Playwright — R13 is fenced here, not T5.
- T2h: every listed page whose source contains `type="submit"` also matches
  `/className="rf-btn(?! secondary)[\s"]/` (the negative lookahead so a page's Google button cannot stand in
  for its primary submit button);
  every listed page containing `GoogleIcon` or `Continue with Google` also contains `rf-btn secondary`;
  `app/buyer/invite/[token]/page.tsx` contains no `bg-buyer-600` and `app/buyer/verify-merge/page.tsx` no
  `bg-brand-600` (the brand-coloured pills the shell replaced) (R7).
- T2j: no listed page source matches `/<h1[\s>]/` — `AuthShell` owns the single `h1` (R2; pairs with T1e,
  which counts the `h1` on the shell itself).

### T3 — existing guard `apps/web/components/no-next-image.test.ts` — R8 (already on the branch; no change)

### T5 — `apps/web/e2e/46-auth-redesign.spec.ts` (e2e, post-deploy) — R6, R7, R9, R10, R12

Project `auth-redesign` in `playwright.config.ts` (`testMatch: /46-auth-redesign\.spec\.ts/`,
`dependencies: []`, `use: { ...devices["Desktop Chrome"] }`), signed-out throughout, tenant host via the
existing `baseURL` (platform host, so `/login` shows the Workspace field).

- T5a desktop (1280×800), for each route `/login`, `/signup`, `/forgot-password`, `/reset-password`,
  `/buyer/login`, `/buyer/register`: `page.locator("main#main-content.rf-auth")` visible;
  `.rf-auth-story` visible with width > 400; `getByRole("heading", { level: 1 })` text equals the spec's
  copy table (`Welcome back.`, `Your next chapter starts here.`, `Reset your password`, `Choose a new
password`, `Welcome back.`, `Your next chapter starts here.`); `getByRole("link", { name: "Need help?" })`
  → href `/contact`; screenshot `test-output/auth-redesign/<route>-desktop.png`.
- T5b labels resolve: `/login` → `getByLabel("Workspace")`, `getByLabel("Username or email")`,
  `getByLabel("Password")`, `getByRole("button", { name: "Sign in", exact: true })`; `/buyer/login` →
  `getByLabel("Email")`, `getByLabel("Password")`, `getByRole("button", { name: "Sign in", exact: true
}).first()`; `/forgot-password` → `getByLabel("Email")`, `getByRole("button", { name: /send reset link/i
})`; `/reset-password` (no token) → text `/invalid or incomplete/`.
- T5c cross-links unchanged: `/login` has link `Forgot password?` → `/forgot-password`, link `/sign in to
the buyer portal/i` → `/buyer/login`; `/buyer/login` has link `/sign in to the seller dashboard/i` →
  `/login`; the phrases `retailer portal` and `staff portal` are absent from both pages.
- T5d mobile: `test.describe` with `test.use({ viewport: { width: 375, height: 812 } })` (desktop UA — a
  phone UA is proxied away from `/login` by design): on `/login` and `/buyer/login` `.rf-auth-story-copy`
  is hidden, `.rf-auth-story` bounding height < 140, `.rf-auth-card` visible, no horizontal overflow
  (`document.documentElement.scrollWidth <= 375`); screenshot `<route>-mobile.png`.
- T5e a11y (manual assertions only — `@axe-core/playwright` is NOT a dependency of `apps/web`, so an
  "if available" axe branch would be dead code advertising coverage it cannot execute; adding the
  dependency is an owner call): on `/login` and `/buyer/login` assert exactly one `h1`, every `input` has
  an associated label (`page.locator("input:not([type=hidden])")` count equals labelled count), and after
  `Tab` the focused element is inside `.rf-auth` with the shell's OWN ring — computed
  `{ outlineWidth: "2px", outlineStyle: "solid", outlineOffset: "2px" }`. An `outline-style !== "none"`
  oracle would NOT do: Chromium's UA `:focus-visible` ring already reports "auto", so it passes with
  `.rf-auth :focus-visible` deleted.
- T5f tenant logo (R9): only if the E2E base URL is a tenant subdomain host in that run — otherwise
  `test.skip` with the reason; on a tenant host `/login` shows no `Workspace` label and an `img` inside
  `.rf-auth-card` with non-empty `alt`.

## Regression fence (existing, untouched — R2, R11; must stay green)

- T4 Jest: `app/(auth)/login/page.test.tsx`, `app/(auth)/login/portal-switch.test.tsx`,
  `app/(auth)/forgot-password/page.test.tsx`, `app/buyer/login/page.test.tsx`,
  `app/buyer/login/portal-switch.test.tsx`, `app/buyer/forgot-password/page.test.tsx`,
  `app/(marketing)/marketing-port.static.test.ts` (MKT-PIN T7 `globals.css`/tailwind byte pins),
  `components/no-next-image.test.ts`, `components/brand/BrandMark.test.tsx`; plus the NEW
  `app/(auth)/auth-redesign.guards.test.ts` (T2b + T2e + T2c's no-font/asset half) — absence guards, green
  before AND after the implementation, never part of the red gate.
- T6 Playwright (post-deploy): `07-auth-password.spec.ts` AP-01..AP-09, `36-marketing-site.spec.ts` T2/T3,
  `setup/auth.setup.ts` (uses `getByLabel("Username or email")`, `getByPlaceholder("Enter your password")`,
  `getByRole("button", { name: "Sign in", exact: true })`).
- Strings that must survive verbatim: labels `Workspace`, `Username or email`, `Password`, `Email`, `New
password`, `Confirm new password`, `Current password`; placeholders `Enter your password`, `Enter your
email`; buttons `Sign in` (exact; the Google button must not be named exactly `Sign in`), `Send reset
link`, `Set new password`, `Change password`; links `Forgot password?`, `Sign in to the buyer portal`,
  `Sign in to the seller dashboard`, `Go to buyer portal`, `Go to seller dashboard`, `Request a new reset
link`; copy `Check your inbox`, `If that address is registered`, `This reset link is invalid or
incomplete.`, `You're signed in to the buyer portal.`, `You're signed in to a seller dashboard.`; the
  heading `Reset your password` on `/forgot-password`; absent phrases `retailer portal`, `staff portal`.

## Harness notes (the engine's harness-integrity check verifies this list)

- T1 mocks nothing; `@/components/brand` renders plain `<img>`/`<a>` under jsdom — no mock needed. If
  `next/link` needs the app-router mock the repo already uses in `site-header.test.tsx`, copy that pattern.
- T2 is filesystem-only (`fs`, `path`); it must locate `apps/web` via `path.resolve(__dirname, "..", "..")`
  like `marketing-port.static.test.ts`, not via `process.cwd()`.
- The existing login/buyer-login Jest tests render the whole page; wrapping the page in `AuthShell` adds a
  `Brand` link named `RouteFlow home` and a `Need help?` link — neither collides with the pinned `getByRole
("link", …)` names, but any NEW link text in the shell must not match `/sign in/i`, `/forgot password/i`,
  `/go to /i`.
- Playwright is never run inside the engine; T5 lands with its project entry and is proven by the
  deployment E2E (expected red → green on the deployment run after merge).
- **Runner invocation:** a Jest positional argument is a REGEX, not a path — `npx jest
"app/(auth)/auth-redesign.static.test.ts"` makes `(auth)` a capture group that matches `app/auth/…` and
  therefore matches NOTHING, while Jest still prints "Ran all test suites matching …". Always run these by
  path: `npx jest --runTestsByPath "components/auth/AuthShell.test.tsx"
"app/(auth)/auth-redesign.static.test.ts" "app/(auth)/auth-redesign.guards.test.ts"` (from `apps/web`), and
  assert the TOTAL count — the red gate is **49 tests: 40 failed, 9 passed** (the 9 are the guard file).
- T1 loads `@/components/auth` through a guarded module-scope `require` (falls back to a `() => null`
  placeholder) so the missing module fails T1's own assertion instead of erroring the whole suite, and every
  T1a–T1e query is non-throwing (`querySelector`/`Array.find`) so each fails on a VALUE, not on a thrown
  `getByRole`. There is NO stub file in `components/auth/` — a stub there would pre-satisfy T1.
