# Web landing 2026-11-03, train af (merge commit `d6d5c56cb1`, range `6e9dae10eb..d6d5c56cb1`; train PR #4146, train head `73caa26085`)

Web paths under `apps/web/` unless they start with `apps/mobile/`, `apps/api/` or `packages/`. Three members: #4144 `d49f6787f6`, #4140 `100cdf13bd` (api scripts + pricing only), #4145 `17191e57cb` (docs only). The api side is in `api/landing-2026-11-03-af.md`. No migration, no new env var, no cron, plan flag or addon gate. Tests are names only; they were not run for this note.

## #4144 `d49f6787f6` no old look left anywhere (W-1129, owner order 2026-11-03)

Rule: every page a visitor can reach wears the site's own look (header, type, colours, footer); the header and footer exist twice (static HTML and React) and a test pins them equal.

- `components/site-frame/{SiteFrame,SiteFrameHeader}.tsx`, `site-frame-nav.ts`, `site-frame.css` (new): one frame and one nav list, pinned against the ready-made pages. Header and footer say **Company** and **Contact**; Sign in becomes Open dashboard by presence cookie.
- Auth: `components/auth/AuthShell.tsx`, `auth-copy.ts`, `auth-shell.css` and the pages `(auth)/{login,signup}`, `(auth)/choose-role`, `buyer/{login,register,invite/[token],reset-password,verify-email}` put every form in one card inside the site frame; fields, validation, requests and redirects are unchanged; the old side story panel (AI scanning chip, sample order) is gone. Sign-up words (workspace hint, password rule, error lines) are in `(auth)/signup/page.tsx` and `auth-copy.ts`.
- `(marketing)/{privacy,terms}/page.tsx`: same frame, legal text untouched. `app/not-found.tsx`: new look, one button home.
- `public/site/company.html`, `contact.html`, `css/company.css` (new): Company tells the founder's note as on home (no photo, no credit); Contact is email only. `lib/static-site-page.ts`, `app/site-page/[page]/route.ts` serve them.
- Redirects (`next.config.mjs`, 308): /wholesalers, /distributors to /product; /retailers, /buyer to /#stores; /book-a-demo, /demo to /contact; /sign-in to /login; /about to /company; /features to /product and /faq, /integrations, /quickbooks to /#faq (temporary). `app/sitemap.ts` is 11 URLs; `lib/marketing-routes.ts`, `lib/umami-tag.ts` and `lib/presence-cookies.ts` follow.
- Removed (38 files, about -7.4k lines): the old marketing components (header, footer, FAQ, demo scheduler and form, workflow tour and the rest), the old /book-a-demo, /wholesalers, /retailers, /sign-in and /about pages and their tests; two raw-message allowlist entries for the deleted demo files.
- `apps/mobile/lib/route-parity-manifest.ts`: rows follow the page changes.
- Tests: `old-pages-redirect.static.test.ts`, `site-company-contact.static.test.ts`, `site-frame.test.tsx`, `AuthShell.test.tsx`, `auth-redesign.static.test.ts`, `signup/page.words.test.tsx`, the `seo`, `cache-headers`, `static-site`, `middleware.marketing` and `UmamiScript` tests; `e2e/36-marketing-site.spec.ts` and `e2e/46-auth-redesign.spec.ts` rewritten (not run at merge time).

## #4140, #4145

- #4140 `100cdf13bd`: no web source. #4145 `17191e57cb`: docs only.
