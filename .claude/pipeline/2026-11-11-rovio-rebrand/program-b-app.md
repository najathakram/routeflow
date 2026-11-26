# Program B (the app) and Program C (the domain): outline

> Status: `OUTLINE`. This is not a build plan. Program B gets its own planning run when the website's
> Phase 2 is in proof, because its details will move by then. Every number below comes from
> [packs/app-brand-inventory.md](./packs/app-brand-inventory.md), read from `origin/master` `5fc866853` on 2026-11-11.

## What "the app" covers

| # | Area | Size today | What changes | Risk |
|---|---|---|---|---|
| 1 | Sign-up path: verify, welcome and reset emails; the email frame's logo and colours | 10 + 2 subjects; `apps/api/src/email/email-layout.ts:7-15` | name, logo, colours | medium |
| 2 | Browser identity: tab title, tab icon, theme colour, install names | `apps/web/app/layout.tsx:48-76`; 4 PNGs in `apps/web/public/brand/`; 2 manifests | title template, icons, manifest names and colours | low |
| 3 | Colour tokens | navy used 6,562 times, brand 1,708 times, all from `packages/ui/src/tokens/ledger.ts` and `apps/web/app/globals.css` | token values; about 400 hard-coded hexes by hand; 5 test files pin colours | medium |
| 4 | Logo in the app's frame | `components/brand/BrandMark.tsx`, 18 consumers | pick the file by background; today it inverts one file with a CSS filter, which a two-colour mark cannot survive | low |
| 5 | Words on screen | about 105 lines web, 27 mobile, 230 API | the name; 476 test files pin it (436 API specs) | medium (volume) |
| 6 | Documents | "Powered by RouteFlow" footers, a default navy `#1B3A5C`, one old platform-branded invoice template that still says `routeflow.io` | footer, default colour; retire or redo the old template | medium (customer-facing paper) |
| 7 | Mobile app | `apps/mobile/app.json`: name, icon, splash, 5 permission prompts, one notification title | name and pictures; store listing; a new build and store review | medium (lead time) |
| 8 | Billing names | Stripe product names are written by code as "RouteFlow <plan>" (`apps/api/src/billing/stripe-product.ts:92,102`); the statement name is set in Stripe's dashboard | product names; the owner changes the statement name | medium (money-facing) |
| 9 | Telling customers | none yet | an in-app notice; "Rovio, formerly RouteFlow" in email and document footers for six months | low |
| 10 | Other systems | field labels created inside customers' GoHighLevel accounts; the import column name "RouteFlow ID" | add the new label beside the old; keep the keys | low |

The largest cost is item 5's tests, not the strings. The cheap way through: give each app one constant for
the platform's name (two exist already: `PLATFORM_BRAND` in `billing-notification.templates.ts:19` and
`APP_NAME` in `apps/web/lib/page-title-context.tsx:15`), make the tests read it, and the rename becomes
one line per app.

## Never rename these (each one breaks sign-ins, installed apps or signed links)

The 13 package names (`@routeflow/*`, imported by 2,615 files). About 45 storage keys (`rf:*`, `rf-*`,
`routeflow.*`). The cookies `tenant-slug`, `rf_refresh`, `rf-auth-success`, `routeflow-oauth-state-v1`.
The signing label `routeflow:storage-url-signing:v1`. The bundle id `com.routeflow.mobile`, the URL
scheme `routeflow`, the Expo slug. The shell token `RouteFlowShell` (accept old and new). Environment
variable names, database names, bucket names, Railway service names. The test-tenant slugs
`e2e-routeflow` and `routeflow-demo`. The GitHub repository name. The file paths
`public/brand/routeflow-mark-*.png`: sent emails link to them, so the new mark replaces the files in
place under the old names.

## Suggested order of slices

| Slice | Holds | Why this order |
|---|---|---|
| B1 | sign-up path emails and browser identity (rows 1, 2) | lands on the website's launch day, so a new customer never meets the old name after signing up on a Rovio site |
| B2 | tokens and the logo in the app's frame, web (rows 3, 4) | the visible repaint; everything token-driven follows |
| B3 | words, remaining emails, documents (rows 5, 6) | the long tail, behind the name constant |
| B4 | mobile (row 7) | needs a store review; start the listing early |
| B5 | billing names, the notice, clean-up (rows 8, 9, 10) | money-facing names last, with the owner at the Stripe dashboard |

## What the owner must decide before B is planned

1. The three working colours in the app (operator teal, store emerald, admin indigo): keep them as wayfinding, or one ink look everywhere.
2. Tenants that set their own colour keep it. What does a tenant with no colour get: ink?
3. The sender name on platform email, and the day it changes.
4. The name in the app stores and on card statements.
5. Whether the legal pages need an attorney's wording for the change of name.

## Gates B inherits from house rules

A feature-parity inventory per screen, with no removal unless the owner agrees. `apple-ux` pass.
`apple-design` and `apple-ux` both sign every placement. Playwright proof at three widths with an
`impeccable` review. `local:validate` and `local:e2e` on the money paths. Test tenants only; no live
tenant's rows are touched.

## Program C: retiring `routeflow.info` (after B)

The owner ruled on 2026-11-11 that the website launches on `www.xrovio.com`. Program A therefore serves
the whole app on both addresses and forwards only the public pages (build plan WP2A). What is left for C:
move sign-in and the app's own links to the new address, then forward the old app paths; business
sub-addresses (if any, A9); the mobile app's web address (`EXPO_PUBLIC_WEB_URL`, a new build); the email
sending domain `send.routeflow.info` and the from-address; the calendar mailbox `admin@routeflow.info`;
the `hello@` address; the email logo hot-link; and four test files that pin the host. Sign-in and tenancy
are high-risk areas: C gets its own plan and gates. Keep `routeflow.info` registered and forwarding for at
least a year (brand kit checklist).
