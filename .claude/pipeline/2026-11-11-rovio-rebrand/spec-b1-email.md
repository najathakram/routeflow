# B1 spec: platform email under the new brand (wave 2)

Base `98bd95141`, which includes master batch 1. Binding: delta §1, §2a and §5. Revised after an independent review: FAIL, with every fix applied below.

## SA rulings (recommended, owner away)
- **API pins approved.** The delta is amended to name `email/email-brand.pin.spec.ts` as the T35 row for the API and `email/email-brand-fixture.spec.ts` as the T45 row for email. Both run in the WP2.7 proof.
- **R1:** `billing/billing-notification.templates.ts` and `buyer/buyer-auth.service.ts` join B1. Neither has an owner in delta:118-128.
- **Colours:** email keeps today's colours. The palette in email stays with B2/B3.
- **Old mark file:** `public/brand/routeflow-mark-192.png` is never deleted.
- **Sender:** From = `BRAND.name` + the address from the env.

## 0. Acceptance (business first)
- **Sign-up mail:** a business that signs up on the new site gets verify, welcome and reset mail with the new brand's name, logo and site. The old name appears in only two places: the "formerly" line, and the sender address `send.routeflow.info` (kept until B3).
  - If this is wrong, a new payer's first mail names a company they never heard of. It reads as phishing, the trial is never verified, and the sale is lost.
- **Tenant mail:** a tenant's own mail keeps the tenant's look. The platform name appears only in "Sent with …" and "… via …".
- **Delivery:** checked on DN. One platform mail to a Gmail test inbox and one to an Outlook test inbox must both show `spf=pass dkim=pass dmarc=pass`.
- **Tech:** every name, logo URL and site link in B1's files comes from `common/brand.ts`. T-B5 is the proof.

## 1. Scope and non-goals
- **In:**
  - NEW `common/brand.ts`.
  - `email/email-layout.ts`, `email/routeflow-mail.ts` and `email/email.service.ts`.
  - The R1 files and the specs listed in §7.
  - B1 also solely owns `apps/web/app/layout.tsx` (delta:125). That is browser identity and has its own brief.
- **Stays:**
  - The sender domain and the address in `EMAIL_FROM`, so there is no SPF/DKIM/DMARC change (delta:48).
  - Link hosts come from `WEB_URL`, which flips in the env (delta:45).
  - Old mailboxes stay at least 12 months (delta:49).
  - Program C owns forwarding from the old host.
- **Not B1. These get the new header over old text, so B3 (or a separate package) must merge before the 2.5 flip, or they join B1:**
  - **Mail, owner B3:**
    - `onboarding/onboarding-intake.service.ts` :164, :168, :494, :786
    - `onboarding/onboarding-lifecycle.service.ts` :115, :124, :288
    - `demo-booking/demo-booking.service.ts` :627, :635, :804-807, :835, :882
    - `customers/portal-invite-email.ts` :21, :34
    - `email/mailbox/mailbox-alert.copy.ts` :39-82
    - `messaging/providers/email-channel.provider.ts` :35
  - **Internal mail built with `routeflowNotice` (header only), owner B3:**
    - `billing/billing.service.ts` :3136
    - `billing/addon-invariant.job.ts` :579
    - `crm/gohighlevel/gohighlevel-poll.service.ts` :188
    - `platform-admin/platform-admin.service.ts` :3163
    - `email/owner-alert.service.ts` :58, :70, :111, :213
  - **PDFs, a separate package (Program B row 6):**
    - `invoices/invoice-pdf-template.tsx` :579, :1055, :1057
    - `buyer/statement-pdf-shared.tsx` :212-237
    - `bookkeeping/invoice-template.tsx` :346, :348, :457. This file prints `routeflow.io`.

## 2. `common/brand.ts` contract
- **Reading:** `readFileSync(join(dirname(require.resolve("@routeflow/types/package.json")), "brand/brand.json"))`, parsed once at module load. It exports a frozen `BRAND` and `loadBrand(path)`.
- **Validation:**
  - `name`, `formerly`, `origin`, `emailLogo`, `emailLogoWidth` and `emailLogoHeight` must all be present.
  - `origin` must start `https://` and have no trailing slash.
  - `emailLogo` must start with `/` and end in `.png`, because mail clients render no SVG.
  - Width and height must be positive integers.
  - A missing or invalid key throws `brand.json: missing <key>`, so the API fails at boot, never mid-send.
- **Why no runtime import:**
  - `@routeflow/types` has `main: ./index.ts`. A value import becomes `require()` in `dist/` and crashes boot (`no-runtime-workspace-imports.spec.ts:1-14`).
  - The image carries `packages/` (`apps/api/Dockerfile:66-69`).
  - Jest does not remap `@routeflow/types` (`apps/api/package.json:180-194`).
  - The package has no `exports` field, so `require.resolve` of `package.json` works in both places.
- **Guard hardening:**
  - The patterns at :48, :50, :52, :54 and :57 (array :46-58) match only the bare package. A static subpath import is caught (:138, :150, :166), but `require()`, dynamic `import()`, `export … from` and a bare import of a subpath are not.
  - Change: replace `["']@routeflow\/types["']` with `["']@routeflow\/types(?:\/[^"']*)?["']`.
  - New cases: a subpath import and a subpath `require` are flagged. A subpath `import type` is not flagged, and neither is `require.resolve("@routeflow/types/package.json")`.
- **`brand.spec.ts` cases:**
  1. The real file loads, and its keys match delta §1.
  2. Each required key, when deleted, throws with that key named.
  3. `http://`, a trailing `/`, an `emailLogo` without a leading `/` and `.svg` are all rejected.
  4. The `emailLogo` file exists under `apps/web/public/`, and its PNG header (IHDR width and height) matches `emailLogoWidth`/`emailLogoHeight` at 1x or 2x or more.
  5. `BRAND` is frozen.
- **S1 follow-up brief:** add `emailLogoWidth` and `emailLogoHeight`. Today `emailLogo` is `/brand/routeflow-mark-192.png` (192×192); 2.0a points it at the kit PNG.

## 3. Brand sites in B1's three files
Found with `Grep` over `apps/api/src`, non-spec files.

| file:line | Today | New source |
|---|---|---|
| layout :14 `BRAND_LOGO_URL` | `https://www.routeflow.info/brand/routeflow-mark-192.png` | `` `${BRAND.origin}${BRAND.emailLogo}` `` (no extra slash) |
| layout :15 `BRAND_SITE_URL` | `https://www.routeflow.info` | `BRAND.origin` |
| layout :82 | `alt="RouteFlow"`, 24×24 chip | `alt="${escapeHtml(BRAND.name)}"`, see §4 |
| layout :86 | typed wordmark `routeflow.` | removed (the PNG carries the wordmark) |
| layout :218, :256, :296 | `Sent with RouteFlow` | `Sent with ${escapeHtml(BRAND.name)}` (plain text unescaped) |
| mail :33-48 | verify mail, 7 sites | `BRAND.name`, with the T37 rewording |
| mail :56-73 | reset mail, 5 sites | `BRAND.name` |
| mail :116-155 | sign-in linked, new login and password set, 10 sites | `BRAND.name` |
| service :338, :345 | `RouteFlow <…>` | §5 From rule |
| service :584 | `<Biz> via RouteFlow <addr>` | `${biz} via ${BRAND.name}` |
| service :596 | fallback `"RouteFlow"` | `BRAND.name` |
| service :1025 | "via RouteFlow's mail service" (UI message) | `BRAND.name` |
| service :1987-2329 | merge, set-password, welcome, login-email and role mails, plus 10× "RouteFlow Platform —" | `BRAND.name` |
| service :2366 | mailbox-revoked footer | `BRAND.name` |
| comments: layout :4, :25-28, :76, :234, :313; mail :5, :88, :159; service :294, :539-593, :608, :656, :1532, :2338-2340, :2394 | prose | neutral wording ("the platform") |

- **Allow-listed identifiers.** These are never renamed (`program-b-app.md:27-36`): `@routeflow/` imports (service :52), the `kind: "routeflow"` look, `routeflowNotice`, `routeflowFragmentMail`, `./routeflow-mail`, `data-rf-layout`, and `send.routeflow.info` (kept until B3).
- **Mailboxes:** none of `hello@`, `admin@` or `security@` appears in these files.
- **HTML rule:** every `BRAND.*` value going into html passes through `escapeHtml`. The `common/html-interpolation.spec.ts:58` allow entry `lookParts :: href BRAND_SITE_URL` is re-keyed to the new expression, never added to (that allow-list only shrinks).

## 4. Email logo
- **File:** the kit has a 360×102 PNG (10.5 KB; its README says to show it at 180 px) and a 1200×339 header PNG (37.8 KB). Use the 360×102 file as is; it is the single email PNG that 2.0a copies under a neutral name (delta:37).
- **Hosting:** the image is at `${BRAND.origin}${BRAND.emailLogo}`. That is the old host until 2A.2 flips `origin` in wave 4; both hosts serve (delta:41-50).
- **Markup:** `<img width=${BRAND.emailLogoWidth} height=${BRAND.emailLogoHeight} alt="${escapeHtml(BRAND.name)}" style="display:block;border:0">`. The size is never typed in code, and for the kit PNG it targets 113×32. Mail clients need an absolute https URL (layout :13).
- **Own-look bar:** the ink and copper logo cannot sit on Navy. The `kind: "routeflow"` look gets a `BRAND_WHITE` bar with a 1 px bottom border and no chip. Tenant and neutral looks are unchanged.

## 5. From, subjects, footer
- **From:** `${BRAND.name} <${addressOf(EMAIL_FROM ?? "invoices@send.routeflow.info")}>`. The display name in the env is ignored, so the comment at :341-342 is rewritten. With SMTP and no `EMAIL_FROM`, From is `${BRAND.name} <${smtpUser}>`.
- **T37 for mail:**
  - The name never ends a sentence. Reword `signing up for RouteFlow.` at mail :34, :37 and :46.
  - The output never contains `${BRAND.name}.`.
  - A subject never ends in `.`.
  - The fixed part of a subject is at most 60 characters with the fixture name.
  - The `— RouteFlow` suffix (service :1996, :2052, :2078) keeps its shape.
- **"Formerly" line:** the own-look footer shows `${BRAND.name}, formerly ${BRAND.formerly}` only when the two differ. Both are the old name today (`brand.json`), so the line stays hidden until the 2.5 flip. It then stays for 3-6 months, per the kit's rollout checklist.

## 6. Tests (red first)
The fixture used throughout is `F = {name:"XROV.IO", formerly:"Old Fixture", origin:"https://fixture.test", emailLogo:"/x/logo.png", emailLogoWidth:113, emailLogoHeight:32}`.

| Id | Asserts | Red today because |
|---|---|---|
| T-B1 | the `brand.spec.ts` cases and the new guard cases | `brand.ts` does not exist, and the regex misses subpaths |
| T-B2 | the own-look header: `src` = `F.origin + F.emailLogo`, the alt text, the size, a white bar, no `routeflow.</span>` | layout :14, :82, :86 |
| T-B3 | `EMAIL_FROM="RouteFlow <x@send.routeflow.info>"` produces `XROV.IO <x@send.routeflow.info>`; the via-name uses F | service :338, :345, :584 |
| T-B4 | no `XROV.IO.`; the subject rules hold | mail :34, :37, :46 |
| **T-B5** (T45 email row) | with `jest.mock("../common/brand")` set to F, render every `routeflow-mail.ts` builder, every `EmailService` platform template, both R1 files' mails, and the tenant and neutral looks. Expect zero `/route\s?flow/i` outside the allow-list; every name, `src` and link from F; the formerly line present | the literals counted in T-B6 |
| T-B6 (T35 API row) | zero `/route\s?flow\|rovio\|xrov\|routeflow\.info\|hello@/i` in B1's files after the allow-list, comments included (L-364) | about 90 hits |
| T-B7 | negatives check `BRAND.emailLogo` and the brand alt text, not `routeflow-mark` | negatives that pass vacuously after the URL change (list in §7) |

## 7. Waves and files
- **Wave 0:** this spec only; no API code (delta:122).
- **Wave 2 start:** once WP1.2 and batch 1 are in the branch (delta:125). Batch 1 is now in.
- **Source files B1 may touch:**
  - NEW `common/brand.ts` and `brand.spec.ts`
  - `common/no-runtime-workspace-imports.spec.ts`
  - `email/{email-layout,routeflow-mail,email.service}.ts`
  - `billing/billing-notification.templates.ts`, where `PLATFORM_BRAND = BRAND.name` (:19) and the inline name strings use it
  - `buyer/buyer-auth.service.ts` :125-133, :607-610
- **Specs B1 must change (pins on the new keys):**
  - `email/` specs:
    - `email-layout.spec.ts` (19 hits; :56-57 and :273; T-B7 at :143, :199, :365)
    - `email-tenant-look.spec.ts` (16)
    - `email-tenant-mail.pins.spec.ts` (12)
    - `email.service.spec.ts` (63)
    - `email-mailbox-revoked-notice.spec.ts` (10)
    - `email-smtp.smtp.spec.ts` (4)
    - `email-layout-inventory.spec.ts` (2)
  - Other specs:
    - `common/html-interpolation.spec.ts:58`
    - `tenants/tenants.service.spec.ts:143` (T37 rewording)
  - T-B7 treatment:
    - `customers/customers.service.spec.ts:3085-3086`
    - `documents/render-order-receipt.spec.ts:474-476`
    - `documents/receipt.service.spec.ts:113`
  - NEW: `email/email-brand.pin.spec.ts` and `email/email-brand-fixture.spec.ts`
- **Web:** `apps/web/app/layout.tsx`, under its own brief.
- **`brand.json`:** owned by S1. B1 reads it only; any key change goes to S1 as a brief.

## 8. Risks and guards
| # | Risk | Guard |
|---|---|---|
| R1 | mixed brand: new header, old text | the ruling above; the §1 list goes to B3 or a separate package as a precondition of the 2.5 flip |
| R2 | `brand.json` unreadable in the image, so boot fails | T-B1 case 1; Docker 2 boots `dist` (delta:128) |
| R3 | web or mobile still says "via RouteFlow" (`SendingDomainCard.tsx`, `invoices/[id]/page.tsx`, mobile `invoice-send-logic.ts`) | B3 |
| R4 | images blocked, so only the alt text shows | the alt carries the brand name; the footer names it too |
| R5 | negative pins pass vacuously (L-322) | T-B7 |
| R6 | a text sweep renames identifiers (L-347) | the §3 allow-list; T-B6 |
| R7 | a subpath import of `@routeflow/types` crashes boot | the guard hardening in §2 |

**One owner per file:**
- No B1 file is claimed by another lane in delta:118-128.
- `layout.tsx` belongs to B1 only. The 2.6 favicon change reaches it as a brief.
- `no-runtime-workspace-imports.spec.ts` and the specs outside `email/` are not in the wave table. The SA confirms them with the R1 ruling.
