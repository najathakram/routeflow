# App rebrand inventory: RouteFlow to Rovio (read from origin/master)

Scope: apps/web outside `public/site` and `app/(marketing)`, apps/mobile, apps/api/src, packages/*. Method: `git grep ... origin/master -- <paths>` with `:!*.test.* :!*.spec.* :!*/e2e/* :!*/__tests__/*` unless noted. `CAMEL` = case-sensitive `Route ?Flow` (brand text); lowercase `routeflow` is nearly all identifiers. Note the legal pages (`app/(marketing)/privacy`, `terms`) are in the excluded marketing tree.

## 1. Visible brand name (non-test, non-comment lines)

Command: `git grep -c -E 'Route ?Flow' origin/master -- <area> <excludes>`, then filtered out comment-only lines with `grep -v -E ':[0-9]+:\s*(//|\*|/\*)'`.

| Area | CAMEL occ / files (incl. comments) | Approx. user-visible lines | Notes |
|---|---|---|---|
| apps/web/app | 90 / 40 | ~75 | settings/_components/MailboxCard.tsx (13), settings/page.tsx:474-2349 (12), GoHighLevelSettingsTab.tsx (6), app/layout.tsx:53-71 (title, OG, appleWebApp), buyer/layout.tsx:14-28, (platform-admin)/layout.tsx:156/194/230, (auth)/login/page.tsx:189/213, admin-login/page.tsx:127/267, not-found.tsx:13 |
| apps/web/components | 14 / 8 | ~12 | TenantLogo.tsx:43, DocumentLetterhead.tsx:20, RegisterHeader.tsx:64, PwaInstallPrompt.tsx:19, brand/BrandMark.tsx:137 (aria-label), site-frame/SiteFrame.tsx:46,83, SiteFrameHeader.tsx:54,57 |
| apps/web/lib | 24 / 11 | ~18 | generic-toast-copy.ts (6: lines 276-299), activation-error-copy.ts (5), payment-due.ts:62,106,136, page-title-context.tsx:15 (`APP_NAME`), credit-note-error-copy.ts:118 |
| apps/mobile | 33 / 18 | ~27 | app.json (6, incl. 5 OS permission prompts), app/index.tsx:79,127,191,200,202, (auth)/login.tsx:125,126,226, company-code.tsx:81,120, driver-profile.tsx:62 and operator/profile.tsx:62 ("RouteFlow v1.0.0"), (shell)/web.tsx:145-146, ShellUnavailable.tsx:9-11, location-tracker.native.ts:68 (Android foreground-service notification title) |
| apps/api/src | 360 / 101 (248 non-comment lines) | ~230 | email 85 lines (email.service.ts 55, routeflow-mail.ts 23, email-layout.ts 10), billing 43, platform-admin 17, buyer 13, crm 11, orders 9, demo-booking 8, onboarding 8; includes about 70 occurrences of the class name `RouteFlowGateway` (identifier, not visible) |
| packages/ui | 5 / 3 | 0 | only `SHELL_UA_PRODUCT = "RouteFlowShell"` (shell-bridge.ts:21,32) and BrandGlyph comments. UA token is a web/mobile handshake: treat as identifier |
| packages/types | 14 / 11 | 1 | import.ts:77 alias "RouteFlow ID" (CSV import column alias; add "Rovio ID", keep old); rest comments |

Total visible-string edits in app code: about 360 lines, of which about 230 sit in the API (email-heavy). Other visible patterns: web `Managed by RouteFlow` (billing/page.tsx:917), `Sent via RouteFlow's mail service` (invoices/[id]/page.tsx:1753,1840, settings/page.tsx:1559, mobile invoice-send-logic.ts:103, api email.service.ts:1025; keep these in sync), `RouteFlow` as suggested Claude API key name (settings/page.tsx:1270,1307).
Lowercase `routeflow` occurrences (identifiers): apps/web app 667, components 162, lib 411, mobile 865, api 781, ui 12, types 24; about 95% are `@routeflow/*` imports. Reproduce: `git grep -h -o -E 'routeflow' origin/master -- <area> | wc -l`.

## 2. Logo and icon assets

Web (apps/web):
- Only binary brand set: `public/brand/routeflow-mark-{64,180,192,512}.png` (4 PNGs). Also `app/favicon.ico`. No `app/icon.*`, `apple-icon.*`, or OG image outside marketing (`app/(marketing)/opengraph-image/route.tsx` is excluded). `public/buyer-manifest.json`, `public/operator-manifest.json`.
- Single render component: `components/brand/BrandMark.tsx` (`BRAND_MARK_SRC = "/brand/routeflow-mark-192.png"`, line 8; `tone="light"` inverts via CSS filter, so a dark-on-transparent mark is assumed). Consumers: `components/TenantLogo.tsx`, `DocumentLetterhead.tsx`, `PwaInstallPrompt.tsx`, dashboard/layout.tsx, (platform-admin)/layout.tsx, buyer/portal/layout.tsx, settings/page.tsx:474, dashboard/page.tsx, estimates/[id], invoices/[id], credit-notes/[id], bookkeeping/[transactionId] pages: 18 non-test files reference `BRAND_MARK_SRC|<BrandMark|routeflow-mark`. Mobile: auth screens (company-code, customer-login, login, sign-in) and app/index.tsx; `packages/ui/src/mobile/ios/BrandGlyph(.web).tsx`, `BrandGradientCard.tsx`.
- app/layout.tsx:52-76 metadata: `metadataBase https://www.routeflow.info`, title default/template "RouteFlow" / "%s · RouteFlow", `manifest: /operator-manifest.json`, appleWebApp title, `startupImage` 192, icons 64/180, openGraph image 512; `viewport.themeColor "#0E1F36"` (line 48). buyer/layout.tsx:14-28 repeats it ("RouteFlow Buyer Portal").
- Manifests: operator: name/short_name "RouteFlow", id `routeflow-operator`, background #FAF6EE, theme #0E1F36, 3 icons. Buyer: "RouteFlow Buyer Portal", background #064e3b, theme #047857 (emerald, off-palette).
- Email hot-links the web PNG: `apps/api/src/email/email-layout.ts:14` `https://www.routeflow.info/brand/routeflow-mark-192.png`. Replacing the file in place updates all sent mail; renaming breaks past emails.

Mobile (apps/mobile):
- Assets (6 PNG): `assets/icon.png`, `splash-icon.png`, `favicon.png`, `android-icon-{foreground,background,monochrome}.png`. No notification-icon asset is configured (notification title string only, location-tracker.native.ts:68).
- app.json (values): name "RouteFlow", slug `routeflow-mobile`, scheme `routeflow`, version 1.2.0, icon `./assets/icon.png`, splash `./assets/splash-icon.png` bg #ffffff (twice, also expo-splash-screen plugin), ios.bundleIdentifier `com.routeflow.mobile`, android.package `com.routeflow.mobile`, adaptiveIcon bg #E6F4FE, EAS projectId `5f27e8dc-...-acba`, updates.url `https://u.expo.dev/<projectId>`, owner `najathakram1`, runtimeVersion policy appVersion. Permission strings embed "RouteFlow" (camera x2, location x2, photos x1).
- app.config.js: dynamic wrapper (maps key from env; no brand strings). eas.json: profiles development/preview/staging/production, channels staging/production, env `EXPO_PUBLIC_API_URL=https://routeflowapi-production.up.railway.app`, `EXPO_PUBLIC_WEB_URL=https://www.routeflow.info`; submit.android track internal (service-account path only). Store listings/ASC metadata are not in the repo.

## 3. Colour system

Verdict: a repaint is mostly a token-value change, with a long tail of hard-coded hexes (about 400 across app code) and an email/PDF layer that does not use tokens.

Token files:
- `packages/ui/src/tokens/ledger.ts` (single source), `tokens.ts`, `tokens/accent.ts`, `native/tokens.ts` (RN shape built from ledger; no hand-typed hex), `packages/config/tailwind.config.ts` (preset mapping).
- Brand scale (teal): 50 #E8F2F1, 100 #D4E9E8, 200 #A9D5D2, 300 #7FD1CD, 400 #3FB8B3, 500 #14A39F, 600 #0E8480, 700 #0B6E6B, 800 #095856, 900 #073F3E. Emerald (buyer) scale 50-900 (#ecfdf5 to #064e3b); indigo (admin) via `--accent` overrides in globals.css.
- globals.css (341 lines): `--ink-900 #0f1b2d`, `--ink-700 #33425b`, `--ink-500 #5c6b82`, `--ink-400 #8b97ac` (plus `-rgb` triplets, lines 14-24), `--canvas #f7f9fc`, `--brand-700/600/500/300/50`, `--primary: var(--brand-500)`, `--primary-strong/-deep/-soft/-mist`, `--primary-foreground #fff`, `--accent*` (line 51 default = primary; buyer emerald #059669 and admin indigo #4f46e5 overrides at lines 91-107), status `--success #16a34a/#dcfce7`, `--warning #d97706/#fef3c7`, `--danger #dc2626/#fee2e2`, `--info #0284c7/#e0f2fe`; dark-mode block at line 117 (canvas #152238).
- tailwind: `navy` = `rgb(var(--ink-900-rgb)/<alpha>)` (preset line 60), `navy.light` #2563EB legacy, `brand`, `ink`, `primary` = `var(--primary,#14A39F)` (apps/web/tailwind.config.ts:23). Tenants override `--primary*` at runtime in `components/tenant-provider.tsx:110-122`; Rovio ink as default means the default (no-tenant-colour) look flips from teal to ink/copper.
- Wide use via classes (token-driven, so a token change reaches them): `text|bg|border|ring|from|to|via|fill|stroke-navy*` 6,562 occ in 422 files; `*-brand*` 1,708 occ in 262 files; `*-primary` only 2.
- Hard-coded hexes (not token-driven), non-test, non-marketing: main navy/blue/teal set (`#0e1f36 #1d2a3d #1b3a5c #0f1b2d #14a39f #087d76 #0b6e6b #0e8480 #3b6fca #2563eb #1e3a5f`) = 22 `#1b3a5c`, 16 `#1d2a3d`, 13 `#0b6e6b`, 9 `#0f1b2d`, 7 `#2563eb`, 4 `#14a39f`, 3 `#3b6fca`, 3 `#0e1f36`, 2 `#0e8480`, 2 `#087d76`, 1 `#1e3a5f`. By area: api/src 26 (email-layout.ts:7-11 `BRAND_NAVY #1D2A3D`, `BRAND_TEAL #087D76`, `BRAND_CLOUD #F3F7F8`, `BRAND_STEEL #536579`; email.service.ts ~14 inline `color:#1D2A3D`; documents/render-order-receipt.ts; PDFs below), web/app 25 (13 files), web/components 5, mobile 9, packages/ui 16.
- All 6-digit hexes of any colour: web/app 254 (34 files), web/components 26 (8), mobile 106 (36), packages/ui/src 127 (11, mostly the token files). Mobile top hexes are neutral/status (#ffffff, #fef3c7, #ef4444).
- Manifest/theme colours not tokenized: `layout.tsx:48` and `operator-manifest.json` (#0E1F36), buyer-manifest (#064e3b/#047857), mobile app.json splash #ffffff, adaptive bg #E6F4FE.
- Mobile theme: `apps/mobile/lib/theme.tsx` (tenant primary + shared builder from packages/ui), `theme-surface.ts`; only 2 files import it directly, screens use ledger tokens and 300 inline `color:/backgroundColor: "#..."` literals (mostly neutrals).
- Fonts (web): self-hosted via `app/fonts.ts` (next/font/local): Geist sans+mono, Spline Sans + Spline Sans Mono, Inter, Instrument Serif (6 families; files in `apps/web/fonts/`, CSS vars `--font-geist-sans`, `--font-spline`, `--font-inter`, `--font-instrument-serif`). Mobile: Spline Sans weights 400-700 + mono via `@expo-google-fonts/*` loaded in `apps/mobile/app/_layout.tsx`. Instrument Serif and Geist are a marketing-era leftover; confirm which the app uses before choosing the Rovio face.
- Brand ink #0E1F36 already exists as themeColor, so Rovio ink #0E1726 is a one-hex change there.

## 4. Outbound documents and messages

Emails (API):
- Layout engine `apps/api/src/email/email-layout.ts`: `renderEmailLayout`, two looks: `kind: "routeflow"` (platform: logo, "Sent with RouteFlow") and `kind: "tenant"` (tenant name, optional footer line "Sent with RouteFlow", lines 218/256/296). 11 `kind:` call sites; `renderEmailLayout(` callers: email.service.ts (3), routeflow-mail.ts (4), customers/portal-invite-email.ts (1).
- Platform-branded builders: routeflow-mail.ts (10 `subject:`; "Verify your email", etc.), email.service.ts (24 `subject:`: account merge, set password, workspace ready, login-email change x3, role change...), billing/billing-notification.templates.ts (18 `subject:`; `PLATFORM_BRAND = "RouteFlow"` line 19, always platform brand), mailbox-alert.copy.ts (2), buyer/buyer-auth.service.ts:125,607 ("Verify your email for RouteFlow", "Reset your RouteFlow password"), crm/gohighlevel-poll.service.ts:189, demo-booking, onboarding, payment-requests. Footers literally "RouteFlow Platform — ..." (about 12 in email.service.ts).
- Tenant-branded: invoice/estimate/order mails use the tenant's name via `tenantNameOrNull()`; fallback `"RouteFlow"` (email.service.ts:596). Mixed-brand sender: `${businessName} via RouteFlow <addr>` (email.service.ts:584).
- From-name: `EMAIL_FROM` env (example `"RouteFlow <noreply@routeflow.info>"` in .env.example:111); fallback `RouteFlow <${smtpUser}>` (email.service.ts:338) or `RouteFlow <invoices@send.routeflow.info>` (line 345). Production value lives in Railway env, not in the repo.
- Colours/logo: BRAND_* constants above plus logo URL hot-link to `www.routeflow.info/brand/routeflow-mark-192.png`; `BRAND_SITE_URL https://www.routeflow.info` (line 15).

PDFs (@react-pdf/renderer, apps/api/src):
- invoices/invoice-pdf-template.tsx (invoice, credit note, estimate variants): tenant letterhead; `DEFAULT_NAVY #1B3A5C` (line 219) unless `tenant.primaryColor`; "Powered by RouteFlow" footer (line 1057) and fallback name "RouteFlow" (579, 1055); 28 hexes.
- buyer/statement-pdf-shared.tsx + statement-pdf-template.tsx: tenant letterhead, `DEFAULT_NAVY #1B3A5C`, `DEFAULT_BRAND #3B6FCA`; fallback "RouteFlow" (212, 235), "Powered by RouteFlow" (237).
- customers/account-statement-pdf-template.tsx, orders/packing-slip-pdf-template.tsx: 0 hexes, 0 brand strings (reuse shared styles). tobacco/tobacco-report-pdf.tsx: 7 hexes, no brand text.
- bookkeeping/invoice-template.tsx (legacy transaction invoice, used by invoice.service.ts:78): fully PLATFORM-branded: `author="RouteFlow"`, logo text, "Austin, TX · routeflow.io" (348, 457) and its own palette #1B3A5C/#3B6FCA. Likely stale (domain routeflow.io is not the live host); decide whether to retire or rebrand.
- Result: PDFs are tenant-branded with a platform "Powered by" and a default navy; there is no platform logo file inside PDFs except the legacy template.
- billing/rf-invoice/*: platform invoices to tenants (RouteFlow as issuer); templates in billing-notification.templates.ts and rf-invoice-email.

Push, SMS, in-app: push via Expo (`notifications/notifications.service.ts:217`, `expo-server-sdk`); no platform brand string found in titles beyond the shown ones (only 4 non-test matches in `notifications/`; check titles list during build). SMS/WhatsApp are tenant-configured channels (`messaging/*`). Android foreground-service notification title "RouteFlow" (mobile location-tracker.native.ts:68). Swagger: `main.ts:121-122` title "RouteFlow API", description "REST API for the RouteFlow delivery management platform"; startup log `main.ts:139`.

## 5. Domains and identity

Hostnames in non-doc code (counts of occurrences): routeflow.info 31, routeflow.com 22 (mostly test/fixture), www.routeflow.info 20, `routeflowapi-production.up.railway.app` 15, `routeflowweb-production.up.railway.app` 6, routeflow.io 5 (+ app.routeflow.io, acme.routeflow.io: legacy examples in CORS comments, dto examples, bookkeeping template), send.routeflow.info 3 (mail sending domain), app.routeflow.info 4, routeflow.app 3, `routeflowmobile-production.up.railway.app` 2.
Code (non-test) locations: `app/layout.tsx:52` metadataBase; `lib/tenant-host.ts` and `middleware.ts:16-83` (tenant slug from `<slug>.routeflow.*` subdomain, so host suffix logic matters for any domain move); `components/site-frame/site-frame-nav.ts:44` `SITE_EMAIL hello@routeflow.info`; `dashboard/FirstRunCard.tsx:16`, `choose-plan/page.tsx:26` (mailto hello@); `(platform-admin)/admin/tenants/[id]/page.tsx:2126` shows `<slug>.routeflow.info`; mobile `app/index.tsx:191` mailto, `eas.json:46-59`, `redirect/server.js:7`, `Dockerfile:10`; api: `WEB_URL` fallback `https://www.routeflow.info` (billing-notification.templates.ts:43-47, addon-invariant.job.ts:568, demo-booking.service.ts:748, onboarding-intake.service.ts:776, payment-requests.service.ts:314, stripe-connect.controller.ts:107), `API_PUBLIC_URL` fallback railway host (stripe-connect.service.ts:85), `admin@routeflow.info` (demo-booking config:77 and .env.example:183 `GOOGLE_CALENDAR_IMPERSONATE`, a Workspace user for calendar access: a mailbox identity, not just text).
CORS: `CORS_ORIGINS` / `CORS_WILDCARD_DOMAINS` env-driven (main.ts:24-25,101 comments). No hard-coded cookie `domain:` found. Deep link: `routeflow://auth/callback` default (auth.controller.ts:418,444; google-oauth.service.ts:46,50) overridable by `GOOGLE_MOBILE_SCHEME`. No associatedDomains/assetlinks/universal-link config in the repo. Legal pages: terms/privacy live under `apps/web/app/(marketing)/` (out of scope here).

## 6. MUST-NOT-RENAME (identifiers)

| Item | Count / evidence |
|---|---|
| npm workspace names | 13 `package.json` names: root `routeflow`, `@routeflow/{api,web,mobile,control,config,eslint-config,pricing,returns,scanning,types,typescript-config,ui}`. Import specifiers: 2,615 files; `@routeflow/types` 1,688, `pricing` 1,252, `ui` 1,249, `scanning` 101 (cmd: `git grep -h -o '@routeflow/[a-z-]*'`). Also in 3 Dockerfiles, next.config.mjs `transpilePackages`, CI `-w @routeflow/control` |
| localStorage/AsyncStorage/SecureStore keys | `rf:*`/`rf-*`/`routeflow.*` families: ~45 distinct keys (e.g. `rf:op:accessToken`, `rf:buyer:refreshToken`, `rf:currentRole`, `rf:oauth:pendingState`, `routeflow.scanMode`, `routeflow:product-create-draft:v1`, `routeflow.driver-location`). Renaming logs everyone out / drops drafts |
| Cookies | `tenant-slug`, `rf_refresh` (6 uses), `rf-auth-success`; `routeflow-oauth-state-v1` (OAuth state, line in auth/google) |
| JWT issuer/audience | none contain "routeflow" (grep of auth/common found none) |
| Key-derivation labels | `"routeflow:storage-url-signing:v1"` (config/configuration.ts:34): changing breaks every signed upload URL; `derived-jwt-key.ts` labels also fixed |
| Env var names | `ROUTEFLOW_BUILD_SHA` 6, `ROUTEFLOW_API_DOTENV` 6, `ROUTEFLOW_BUILD_DIRTY` 5, `ROUTEFLOW_URL` 2, `ROUTEFLOW_USERNAME/PASSWORD` 1 each |
| DB names | `routeflow_test` (CI db-migrations.yml, 5 uses), `routeflow_dev` (docker-compose, local-db-bypass-urls.ts:24) |
| Buckets / paths | R2 default bucket `routeflow-assets` (configuration.ts:195, bookkeeping/invoice.service.ts:24), `routeflow-uploads` tmp dir |
| Docker/Railway | Railway service/host names `routeflowapi-production`, `routeflowweb-production`, `routeflowmobile-production` (21 hits incl. CI, eas.json, Dockerfile `NEXT_PUBLIC_API_URL` build arg); CI runner label `routeflow-ephemeral`; Docker images built from per-app Dockerfiles |
| Bundle ids / scheme | `com.routeflow.mobile` (iOS+Android, immutable once on stores), scheme `routeflow`, slug `routeflow-mobile`, `owner`/projectId; changing bundle id = a new store app |
| Web/mobile handshake | `RouteFlowShell` UA product + regex (packages/ui shell-bridge.ts:21,32; 15 hits in 6 files): old installed apps send the old token, so accept both |
| Tenant slugs | `e2e-routeflow` 184 occ / 84 files, `routeflow-demo` 62 / 34, `routeflow-hq` house tenant (tenant-class.util.ts:37; scripts) |
| GitHub | repo `najathakram/routeflow` 119 refs in 42 files (scripts, CI, watchdog) |
| Code identifiers | `RouteFlowGateway` class (52 + 16 imports of `gateways/routeflow.gateway`), `routeflowNotice`, `routeflowFragmentMail`, file `email/routeflow-mail.ts` (11 imports); renaming is optional cosmetic |
| External-system keys | GoHighLevel custom fields `contact.routeflow_customer_id/_link/_status` (gohighlevel-writeback.service.ts:44-46) plus labels "RouteFlow Customer ID" created inside customers' GHL accounts: keep keys, labels would need migration |
| Redis keys | no `routeflow`-prefixed redis/queue key prefix found |

## 7. Tests pinning brand strings or colours (CAMEL matches in test files)

- 476 test files contain RouteFlow text: apps/api spec 436 files (302 occurrences excluding the `RouteFlowGateway` class), apps/web+mobile 37 files (96 occurrences). Packages 0.
- Top 15 by count: api email.service.spec.ts 30; email-tenant-look.spec.ts 16; email-layout.spec.ts 15; billing/denial-text.spec.ts 15; email-tenant-mail.pins.spec.ts 12; web e2e/36-marketing-site.spec.ts 10 (marketing, out of scope); email-mailbox-revoked-notice.spec.ts 10; rf-invoice-email.spec.ts 9; rf-invoice-constants-parity.spec.ts 9; web lib/payment-due.test.ts 8; gohighlevel-writeback.service.spec.ts 8; billing/stripe-product.spec.ts 8; billing-notification.templates.spec.ts 8; platform-admin/platform-config.prepare-ai-call.spec.ts 7; gateways/routeflow.gateway.buyer-rooms.spec.ts 7 (class name, not text).
- Web/mobile next: e2e/mailbox-connect.spec.ts 5, MailboxCard.test.tsx 5, mobile __tests__/shell-bridge-schema.test.ts 5, notifications-matrix.test.tsx 4, billing-page.test.tsx 4, layout.install-banner.test.tsx 4.
- Colour/logo pins: hex pins in 5 files only: api email-layout.spec.ts, email.service.spec.ts (hard-coded logo URL line 2054), mobile native-theme.test.ts, web components/tenant-provider-ramp.test.ts, lib/tailwind-preset-ledger.test.ts (the last two will fail on a token change by design). Class pins (`bg|text|border-navy|brand`) are rare (about 6 files, 2-3 each). Alt-text/title pins: RetryableImg.test.tsx (8, generic), none for the logo alt. No visual-snapshot baselines in apps/web/e2e.

## 8. Billing-facing names

- Stripe product names are created in code: `billing/stripe-product.ts:92` `RouteFlow ${planName}` (product id `rf_plan_<code>`), `:102` `RouteFlow add-on — ${name}` (id `rf_addon_<sku>`). `ensureStripeProduct` retrieves by id and calls `reconcile`, so existing products keep the old name until reconcile or a manual Stripe edit: confirm what reconcile updates. Checkout inline lines: `catchup-session-params.ts:95` (`plan.stub.label`), payment-requests `product_data.name = req.description` (tenant text).
- Statement descriptor: not set anywhere in code (grep `statement_descriptor` = 0 hits): lives in the Stripe dashboard/Connect settings; also customer-facing Stripe email/branding and Checkout logo are dashboard settings.
- Plan catalog: versioned rows published by `apps/api/prisma/publish-plan-catalog-v8..v13.ts` and `plan-catalog-v11..v13.definitions.ts` (immutable PlanVersion history); plan display names come from DB/`catalog-display-name.ts`, no "RouteFlow" in the v13 definitions, so tenant-visible plan names do not need a catalog republish; only the Stripe product names do. Billing UI strings: `settings/billing/page.tsx:917` "Managed by RouteFlow", settings-index.ts:429 "Pay what you owe for your RouteFlow plan", payment-due.ts:62/106/136.
- Test seed names: `prisma/seed.ts:92` "RouteFlow Test Co.", `bootstrap-house-tenant.mjs:96` "RouteFlow HQ" (data, not shipped UI).

## Gaps and cautions
- Counts of "visible" lines are a heuristic (non-comment lines minus identifier shapes); API visible figure includes copy inside template literals and audit/log messages (platform-admin `audit-actions.constant.ts` 9 lines are admin-only).
- Not checked: runtime DB content (tenant-stored email templates, notification rule texts), Stripe dashboard settings, Railway env values (EMAIL_FROM, WEB_URL, CORS), App Store / Play listings.
