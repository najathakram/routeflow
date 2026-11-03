# Web landing 2026-11-03, train ae and #4143 (range `9e782a5dfc..6e9dae10eb`; train PR #4142 merge `21cee01b01`, train head `2791d368b8`; #4143 merge `6e9dae10eb`)

Web paths under `apps/web/` unless they start with `scripts/` or `apps/mobile/`. Three members: #4141 `1245b44b21` and #4139 `fbb3f1adea` (docs only: Train ad bookkeeping) merged as train ae (#4142, `21cee01b01`); #4143 `ac34482ca1` merged directly on its green CI as `6e9dae10eb`. **No api change, no migration**, no cron, plan flag or addon gate, no new env var. Railway redeploys web and mobile only (the api service stays at `9e782a5dfc`). Tests are names only; they were not run for this note.

## #4141 `1245b44b21` site audit fixes (W-1129)

- `middleware.ts`: the `/` redirect is sent `Cache-Control: no-store` (the bare 307 had inherited the public stale-while-revalidate header from `next.config.mjs`, so a browser replayed `/` to `/dashboard` after the cookie was gone). Who is redirected did not change in this PR.
- `public/sw.js`: files under `/site/` are network-first (cache only as offline fallback); `CACHE_VERSION` is `routeflow-v4`, which drops the v3 `/site/` copies. Other static files stay cache-first.
- Wording: seven static pages under `public/site` (`home.html`, `product.html`, `pricing.html`, `does-and-doesnt.html`, `getting-started.html`, `security.html`, `data-in-and-out.html`) carry only sentences read from code (credit-limit line, plans differ by customers and logins, Google sign-in vs company single sign-on, "Method: Store credit (credit note)", default weighted-average cost with last cost available, invoice after delivery or shipment, sign-up password rule).
- Polish: phone menu and footer reach Security, Data in and out and What it does and doesn't on all seven pages; wheel total and paid balance stay steady; a "What each part does" list under the wheel (`public/site/js/home-up.js`, `graphics/rf-wheel-up.js`, `css/home-up.css`, `css/site.css`); `/login`, `/signup` and `/forgot-password` are noindex with real titles (`app/(auth)/{login,signup,forgot-password}/layout.tsx`).
- Tests: `app/(auth)/auth-noindex.static.test.ts`, `app/(marketing)/middleware.marketing.test.ts`, `service-worker.static.test.ts`, `site-phone-and-motion.static.test.ts`.

## #4143 `ac34482ca1` www always shows home (W-1129, owner order 2026-11-03)

Rule: `/` is the home page for everyone, signed in or not, so it is cacheable for everyone. Nothing a cookie decides is served at `/`.

- `middleware.ts`: the `/` 307 (operator to `/dashboard`, buyer to `/buyer/portal`) is gone; the buyer-only guard on operator paths is unchanged.
- `public/site/js/auth-nav.js` (new, no framework, no network call): header, phone-menu and footer "Sign in" on the seven pages become **Open dashboard** when a presence cookie exists (operator to `/dashboard`, buyer to `/buyer/portal`; with both, the portal used last, `rf-last-portal`; dashboard by default). It mirrors `resolveLandingTarget` in `lib/portal-routing.ts`, which stays as the reference rule. "Store sign in" is unchanged. `scripts/sync-site-port.mjs` copies the script.
- `apps/mobile/lib/web-shell/shell-config.ts`: comment only (the shell enters at `/login` and `/buyer/login`, never `/`).
- Tests: `app/(marketing)/middleware.marketing.test.ts` ("/" is 200 with no Location for every cookie combination), `site-auth-nav.static.test.ts` (script target pinned to the server rule over every cookie combination; the three links marked and the script loaded on each of 7 pages), `e2e/05-cross-cutting.spec.ts` CC-11..15 and CC-18..20 rewritten (not run at merge time).

## #4139

- `fbb3f1adea`: docs only (landing notes for train ad, `.claude/code-map` and lessons `_meta`).
