# B1 spec: platform email under the new brand (wave 2)

Base `437fa4998`; binding: delta §1, §2a, §5. Re-read line numbers after UX batch 1 (it edits `routeflow-mail.ts`, delta:114).

## 0. Acceptance (business first)
- A business signing up on the new site gets verify, welcome and reset mail with the new brand's name, logo and site; the old name only in the "formerly" line. If wrong, a new payer's first mail names a company they never heard of: it reads as phishing, the trial is never verified, the sale is lost.
- A tenant's own mail keeps the tenant's look. The platform name appears only in "Sent with …" and "… via …".
- Delivery unchanged: same sender address, SPF/DKIM and inbox placement.
- Tech: every name, logo URL and site link in the three files comes from `common/brand.ts` (proof: T-B5).

## 1. Scope and non-goals
- **In:** `common/brand.ts` (NEW), `email/email-layout.ts`, `email/routeflow-mail.ts`, `email/email.service.ts`, their specs. B1 also solely owns `apps/web/app/layout.tsx` (delta:125): browser identity, separate brief.
- **Stays:** sender domain `send.routeflow.info` and the `EMAIL_FROM` address; no SPF/DKIM/DMARC change (delta:48). Link hosts come from `WEB_URL` (env flip, delta:45). Old mailboxes stay ≥ 12 months (delta:49). Program C owns old-host forwarding. Email colours (§4).
- **Not B1 (B3, unless SA widens):** `billing/billing-notification.templates.ts` (`PLATFORM_BRAND` :19, strings :30,80-81,199,208,235-257,371-374), `buyer/buyer-auth.service.ts` :125-133,607-610 `customers/portal-invite-email.ts` :21,34, `email/mailbox/mailbox-alert.copy.ts` :39-82, `email/owner-alert.service.ts` :58,70,111,213, `messaging/providers/email-channel.provider.ts` :35; see R1.

## 2. `common/brand.ts` contract
- The file reads `join(dirname(require.resolve("@routeflow/types/package.json")), "brand/brand.json")` with `readFileSync` and parses it once at module load. It exports a frozen `BRAND` and `loadBrand(path)`; the spec calls `loadBrand`.
- Validates `name`, `formerly`, `origin`, `emailLogo` as non-empty strings; `origin` is `https://`, no trailing slash; `emailLogo` ends `.png` (mail clients render no SVG).
- A missing/invalid key throws `brand.json: missing <key>`: boot fails, never a send.
- **Why no runtime import:** `@routeflow/types` has `main: ./index.ts`; a value import becomes `require()` in `dist/` and crashes boot (`no-runtime-workspace-imports.spec.ts:1-14`). Its patterns (:46-56) miss `require.resolve(".../package.json")` (gate 5 R2). The image carries `packages/` (`apps/api/Dockerfile:66-69`); Jest does not remap `@routeflow/types` (`apps/api/package.json:180-194`), so the symlink resolves in both.
- **`brand.spec.ts` cases:**
(1) real file loads, keys = delta §1 list; (2) each key deleted → throws naming it; (3) `http://`, trailing `/`, `.svg` rejected; (4) the `emailLogo` file exists under `apps/web/public/`; (5) `BRAND` frozen.

## 3. Brand sites in the three files (`Grep` over `apps/api/src`, non-spec)
| file:line | Today | New source |
|---|---|---|
| layout :14 `BRAND_LOGO_URL` | `https://www.routeflow.info/brand/routeflow-mark-192.png` | `` `${BRAND.origin}/${BRAND.emailLogo}` `` |
| layout :15 `BRAND_SITE_URL` | `https://www.routeflow.info` | `BRAND.origin` |
| layout :82 | `alt="RouteFlow"`, 24×24 chip | `alt=BRAND.name`, §4 |
| layout :86 | typed wordmark `routeflow.` | removed (the PNG carries the wordmark) |
| layout :218, :256, :296 | `Sent with RouteFlow` (html/text) | `` `Sent with ${BRAND.name}` `` |
| comments: layout :4,:25-28,:76,:313; mail :5,:81,:152; service :294,:539-593,:608,:656,:1532,:2338-2340,:2394 | prose | neutral ("the platform") |
| mail :33-48 | verify intro, preheader, footer, subject (6 sites) | `BRAND.name`, T37 wording |
| mail :56-66 | reset (4 sites) | `BRAND.name` |
| mail :109-148 | sign-in linked, new login, password set (11 sites) | `BRAND.name` |
| service :338, :345 | `RouteFlow <…>` From fallbacks | §5 display-name rule |
| service :584 | `<Biz> via RouteFlow <addr>` | `` `${biz} via ${BRAND.name}` `` |
| service :596 | display-name fallback `"RouteFlow"` | `BRAND.name` |
| service :1025 | "via RouteFlow's mail service" (UI message) | `BRAND.name` |
| service :1987-2329 | merge, set-password, welcome, login-email, role mails: subjects, bodies, 10× footer "RouteFlow Platform —" | `BRAND.name` |
| service :2366 | mailbox-revoked footer | `BRAND.name` |

- **Allow-listed identifiers** (never renamed, `program-b-app.md:27-36`): `@routeflow/` imports (service :52), the `kind: "routeflow"` look, `routeflowNotice`, `routeflowFragmentMail`, `./routeflow-mail`, `data-rf-layout`, and the host `send.routeflow.info` (until B3).
- **No host/mailbox strings** besides these: no `hello@`/`admin@`/`security@` in the three files.
- **Specs to change:** `email-layout.spec.ts` (19 hits; :56-57 and :273 pin the alt text and old URL), `email-tenant-look.spec.ts` (16), `email-tenant-mail.pins.spec.ts` (12), `email.service.spec.ts` (63), `email-mailbox-revoked-notice.spec.ts` (10), `email-smtp.smtp.spec.ts` (4) and `email-layout-inventory.spec.ts` (2). Pins read `BRAND`, never a new literal.

## 4. Email logo
- The kit has two PNGs: 360×102 (10.5 KB; README: show at 180 px) and a 1200×339 header (37.8 KB). Use the 360×102 as is: the single email PNG 2.0a copies under a neutral name (delta:37).
- **Hosting:** web `public/site/img/brand/` via `BRAND.emailLogo`, served from `BRAND.origin` (old host until 2A.2 flips `origin` in wave 4; both serve, delta:41-50). Never delete `public/brand/routeflow-mark-192.png`: sent mail hot-links it.
- **Markup:** `<img src width="113" height="32" alt="${BRAND.name}" style="display:block;border:0;height:32px;width:113px">`. Mail clients need an absolute https URL (layout :13).
- **Own-look bar:** the ink/copper logo cannot sit on Navy. `kind: "routeflow"` gets a `BRAND_WHITE` bar, 1 px bottom border, no chip. Tenant and neutral looks unchanged.
- **Default:** button/heading colours stay (palette in email = B2/B3). Alternative (XS): own-look button reads palette ink. SA decides.

## 5. Display name, subjects, footer
- **From:** `platformFrom = ${BRAND.name} <${addressOf(EMAIL_FROM ?? "invoices@send.routeflow.info")}>`: env owns the address (SPF/DKIM aligned), the brand owns the name, so a stale env display name cannot leak (rewrite comment :341-342). SMTP without `EMAIL_FROM`: `${BRAND.name} <${smtpUser}>`.
- **T37 for mail:**
  - The name never ends a sentence. Reword `signing up for RouteFlow.` (mail :34,37,46) so it does not end on the name.
  - Rendered html and text never contain `` `${BRAND.name}.` ``.
  - Subjects never end with `.`. Each subject's fixed part (tenant values excluded) is ≤ 60 chars with the fixture name. The `— RouteFlow` suffix (service :1996, :2052, :2078) keeps its shape.
- **Formerly line:** own-look footer adds `${BRAND.name}, formerly ${BRAND.formerly}` only when the two differ. In wave 0 both are the old name (gate 5), so it is hidden until the 2.5 flip. It stays for the period in the kit's rollout checklist (3-6 months).

## 6. Tests (red first)
| Id | Asserts | Red today because |
|---|---|---|
| T-B1 | `brand.spec.ts` cases above | `common/brand.ts` does not exist |
| T-B2 | the own-look header has `src` = `BRAND.origin` + `emailLogo`, `alt=BRAND.name`, white bar, no `routeflow.</span>` | layout :14, :82, :86 |
| T-B3 | From = `BRAND.name` + env address. `EMAIL_FROM="RouteFlow <x@send.routeflow.info>"` gives `Fixture <x@send.routeflow.info>`. Tenant via-name uses the fixture | service :338, :345, :584 |
| T-B4 | no `` `${name}.` `` in output; subject rules | mail :34, :37, :46 |
| **T-B5** (T45-style) | `jest.mock("../common/brand")` → `{name:"Fixture Co", formerly:"Old Fixture", origin:"https://fixture.test", emailLogo:"x/logo.png"}`; renders every `routeflow-mail.ts` builder, every `EmailService` platform template (merge, set-password, welcome, login-email ×4, role, mailbox-revoked) and the tenant/neutral looks; zero `/routes?flow/i` outside the allow-list and `send.routeflow.info`; every name, `src`, link from the fixture; formerly line present | the T-B6 literals |
| T-B6 | API pin: zero `/route\s?flow\|routeflow\.info\|hello@/i` in the three files after the allow-list (comments included, L-364 shapes) | about 90 hits |
| T-B7 | tenant/neutral negatives use `BRAND.emailLogo` and `alt=BRAND.name`, not `routeflow-mark` | `email-layout.spec.ts:143,199,365` would pass vacuously after the URL change |

T-B6 = the delta's T35 row for these files, kept in apps/api (`email/email-brand.pin.spec.ts`) so B1 never edits T35, whose exemption table other wave-2 lanes edit. **Deviates from delta:22: SA yes needed.**

## 7. Waves
- **Wave 0:** this spec only. No API code and no test files (delta:122).
- **Wave 2** starts when WP1.2 and batch 1 are in the branch (delta:125). B1 may touch:
NEW `apps/api/src/common/brand.ts` + `brand.spec.ts`; `email/{email-layout,routeflow-mail,email.service}.ts`; the seven §3 specs; NEW `email/email-brand.pin.spec.ts`, `email/email-brand-fixture.spec.ts`; `apps/web/app/layout.tsx` (own brief).
- B1 reads `packages/types/brand/brand.json` (S1-owned) and never edits it; a missing key goes to S1 as a brief.

## 8. Risks and guards
| # | Risk | Guard |
|---|---|---|
| R1 | Mixed brand: the trial-ending and buyer-verify mails get the new header but old text (§1 Not B1) | ask the SA to add `billing-notification.templates.ts` (`PLATFORM_BRAND = BRAND.name`) and `buyer-auth.service.ts` :125-133, :607-610 to B1. No wave-table owner holds them (delta:118-128) |
| R2 | `brand.json` unreadable in the image, so boot fails | T-B1 case 1; the Docker 2 smoke (delta:128) boots `dist` |
| R3 | Web/mobile UI still says "via RouteFlow" (`SendingDomainCard.tsx`, `invoices/[id]/page.tsx`, mobile `invoice-send-logic.ts`) | B3 |
| R4 | Images blocked: only alt shows | `alt=BRAND.name`; footer names it |
| R5 | Vacuous negative pins (L-322) | T-B7 |
| R6 | A text sweep renames identifiers (L-347) | the §3 allow-list; T-B6 fails on anything else |

**One owner per file:** no B1 file is claimed by another lane in delta:118-128; `layout.tsx` is B1-only (2.6 favicon = brief, delta:125); batch 1 edits `routeflow-mail.ts` before wave 2 (delta:114), sequenced, never parallel.
