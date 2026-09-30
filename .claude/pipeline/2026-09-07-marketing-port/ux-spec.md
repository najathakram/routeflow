# UX spec — marketing interface port + logo update

Status: PLANNED · derives from `.claude/pipeline/design-system.md` (the live Ledger system) and extends it with a
**scoped marketing surface**. Every visual fact below is a fact from the redesign inventories (M1 §1–§8, M3), not a
proposal. The redesign preview is not serving at plan time; fidelity is judged against these facts and, at review, by
the owner against their preview.

## 1. How the marketing surface attaches to the design system (extend, don't reinvent)

- The live app already isolates marketing under `<div className="rf-marketing" data-side=…>` (`app/(marketing)/layout.tsx`).
  Keep `.rf-marketing` as the ONLY scope; drop `data-side`/`use-side.ts`. All marketing tokens are declared on
  `.rf-marketing`, never on `:root`. The app's Ledger tokens (`--ink-*`, `--brand-*`, `--primary` runtime override,
  `--r-*`, `--sh-*`, `--font-*`) stay untouched (pinned by T7).
- Fonts: Geist (sans) and Geist Mono (mono) loaded once at the root via `next/font/local` as `--font-geist-sans` /
  `--font-geist-mono` (the same names the redesign's CSS consumes); `.rf-marketing { font-family: var(--font-geist-sans), Arial, sans-serif; }`.
  The dashboard keeps Spline Sans; nothing outside `.rf-marketing` reads the Geist variables.
- One stylesheet, `app/(marketing)/marketing.css`, REPLACES the old 407-line file. It is a consolidation of the
  redesign's painted rules (the ten overlapping files, with `charcoal.css` winning every `:root` token): port the rules
  that actually paint, drop dead/duplicated declarations, translate the two Tailwind-4-only at-rules
  (`@custom-variant`, `@theme inline`) into plain CSS variables, keep class names so the component markup ports
  verbatim. Target ≤ 3,500 lines; prettier-formatted.

### Token table (`.rf-marketing`, M1 §8 painted values)

| token                                                        | value                                                       | role                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--background`                                               | `#ffffff`                                                   | page                                                                                                                 |
| `--foreground`                                               | `#292c33`                                                   | text (charcoal)                                                                                                      |
| `--primary`                                                  | `#10264d`                                                   | actions, wordmark period, links                                                                                      |
| `--muted` / `--muted-foreground`                             | `#f5f5f7` / `#5b5c63`                                       | surfaces, secondary text                                                                                             |
| `--accent`                                                   | `#e8eef8`                                                   | soft highlights                                                                                                      |
| `--border`                                                   | `#e1e1e6`                                                   | hairlines                                                                                                            |
| `--navy` `--charcoal` `--plum` `--copper` `--green` `--lime` | `#10264d` `#292c33` `#7b49ab` `#a45b27` `#087c78` `#b7e7d0` | named palette (plum ring, copper/green accents, lime = distributor CTA `button-lime`, retailer green `button-green`) |
| `--ring`                                                     | `#7b49ab`                                                   | focus ring                                                                                                           |
| `--radius-sm/md/lg/xl`                                       | `6px 8px 12px 18px`                                         | corners                                                                                                              |

Semantic colours for status are not used on marketing pages. The dark distributor hero (`/wholesalers`) and the
light-green retailer hero (`/retailers`) are section-level backgrounds in the stylesheet, not themes.

## 2. Brand

- `apps/web/components/brand/BrandMark.tsx`: `<Image src="/brand/routeflow-mark-192.png" width={size} height={size} alt="" aria-hidden />`,
  `size` default 34 (header), 29 at ≤ 480 px via CSS, 48 in the comparison table / connection diagram.
- `BrandSignature`: mark + `<span class="brand-wordmark">routeflow<span class="brand-period">.</span></span>`; the
  wordmark inherits the surrounding text colour (cream on the dark footer/hero, charcoal on light); the period is
  `var(--primary)` inside `.rf-marketing` and `var(--brand-500)`-teal? **No** — outside marketing the period uses
  `#10264d` explicitly so the mark reads identically everywhere.
- `Brand`: `<Link href="/" aria-label="RouteFlow home">` around the signature.
- Sizes at the existing app sites (M2 Part B table): keep each site's current box (`h-8 w-8`, `h-9 w-9`, `h-10 w-10`,
  `h-12 w-12`, 48 px on the login panel) — the mark is square, `object-contain`, `rounded-lg` where the old
  `TenantLogo` applied it. On dark backgrounds (dashboard sidebar `bg-navy`, buyer sidebar gradient, login left panel)
  the PNG is used as-is (the redesign uses it on its dark distributor hero the same way).
- Wordmark appears only where the old sites showed a name next to the mark (marketing header/footer, login panel,
  404, platform-admin shell "RouteFlow / Platform Admin"); tenant names still replace it where `TenantLogo` shows the
  business name.

## 3. Page anatomy (order is the redesign's; copy verbatim from M1)

- **Header** (sticky, light, hairline bottom): brand left; nav centre (Platform, Distributors, Retailers, Pricing,
  Company; active item underlined via `usePathname`); right: "Sign in" (DropdownMenu: Distributor sign in →, Retailer
  sign in →) and "Book a demo" (primary button). ≤ 960 px: hamburger → right-side sheet (Radix Dialog, 3/4 width, slide
  in, overlay) listing the five items + Contact + both sign-ins + Book a demo.
- **Footer** (dark, `--navy` background, cream text): brand + tagline "Keep your delivery day on track." + mailto;
  Platform / Company / Your workspace columns (R2); bottom bar © year.
- **Home** `/`: glass hero (eyebrow, H1 with italic second line, body, assurance line, three CTAs) with `DeliveryDemo`
  right → CapabilityStrip (9 chips) → ProblemSection (3 cards) → AISpotlight (3 steps) → How RouteFlow solves it
  (FeatureCatalog 9 + 6 extras + CTA) → DifferenceSection (2-column table headed by the mark) → AudienceCards (2) →
  BuyingConfidence (3 points) → FAQ (5) → CTA block.
- **Product**: centred hero → full DeliveryDemo → CapabilityStrip → AISpotlight → Features (FeatureCatalog on
  `surface`) → Keep your team connected (checklist + connection diagram with the mark centre, 4 nodes) →
  DifferenceSection → BuyingConfidence → FAQ → CTA.
- **Wholesalers**: dark distributor hero (lime CTA) with compact DeliveryDemo → FeatureCatalog → WorkflowTour (4
  tabs on Radix Tabs) → 3-step getting-started → CTA.
- **Retailers** (`.retailer-page`): light-green hero (green CTA → `/buyer/register`, secondary → `/buyer/login`) with
  RetailerArt image → 3 benefit cards → 3-step "Before your first order" → RetailerDetail (sample order card,
  "Illustrative products and prices.") → FAQ (retail set, 4) → retailer CTA.
- **Pricing**: centred hero → banner note → 3 plan cards (Growth featured with ribbon; no numeric prices; "Discuss
  <Plan> →" → `/contact`) → "Ordering as a retailer?" callout → "Before you choose" checklist (4) → CTA.
- **Company**: hero (two paragraphs) → full-width warehouse image with overlay label + Pexels credit (external link,
  `rel="noopener"`) → 3 principles → "Tell us about your delivery day" (mailto) → CTA.
- **Contact**: two columns — left: eyebrow, H1, body, 3-item agenda, "Prefer to email?" block; right: `DemoForm`
  (Name, Email, Company, Notes; button "Prepare my demo request"; success state with "Open email app" + "Start a new
  draft"). No CTA block.
- **Privacy / Terms**: eyebrow "ROUTEFLOW", H1, the interim paragraph (R9), mailto, "Return to RouteFlow →".
- **404**: eyebrow "404 · PAGE NOT FOUND", H1 "Let's get you back on track.", body, CTA "Back to RouteFlow →".

## 4. States and motion

- `EditorialMotion`: IntersectionObserver adds `.editorial-reveal` to the selector list in M1 §9 once; under
  `prefers-reduced-motion: reduce` every target is revealed immediately with no transition.
- `OperationStory`: chapter change 3.3 s autoplay; pauses when not visible or when the tab is hidden; buttons:
  Play/Pause, Restart, chapter dots (aria-pressed), quantity − / + (1–12), route A/B, "Confirm sample delivery",
  "Record sample payment"; SR live region announces the chapter; reduced motion disables autoplay (manual only).
- Sheet/DropdownMenu enter/exit: `data-[state=open]:animate-in fade-in-0 slide-in-from-right` (tailwindcss-animate
  vocabulary); focus trapped and restored (Radix).
- FAQ: `<details name="faq">`-style single-open (a small client handler closes siblings for browsers without
  `name` support); panel height animates with a CSS grid-rows transition; chevron rotates on open.

## 5. Accessibility

Skip link first in the marketing layout; exactly one `h1` per page; landmarks: `header`, `nav[aria-label="Primary"]`,
`main#main-content`, `footer`; buttons are `<button>`, links are `<a>`; sheet trigger `aria-label="Open menu"`,
`aria-expanded`; contrast: charcoal on white ≥ 12:1, cream on navy ≥ 12:1, copper on white ≥ 4.6:1 (body text never
copper); focus rings 2 px plum offset 2 px; images have alt text (decorative mark `alt=""`).

## 6. Verification surfaces

Playwright project `marketing` (spec 36) post-deploy; UI verify in the engine drives the same pages on a local
`next dev` at desktop (1280) and mobile (375) with console/network/a11y/design-system checks; screenshots per page are
evidence for the Opus judge and the owner.

## 7. Deviations (accepted)

- **marketing.css is imported from the ROOT layout, not from `app/(marketing)/layout.tsx`.** The App Router drops the
  `not-found` segment's own CSS chunk on hydration, so `app/not-found.tsx` rendered completely unstyled (observed in
  the browser against `next dev`); importing the stylesheet at the root is the only fix verified against a browser.
  **Cost, measured on this tree:** `app/(marketing)/marketing.css` = 214,999 B raw / 35,939 B gzip (against
  `app/globals.css` at 6,433 / 2,328) now ships in the shared root chunk on every route, authenticated ones included.
  **Why it is visually safe:** every rule in the file is scoped under `.rf-marketing`, it declares no `:root`, no
  `@font-face`/`@import`/`@layer`, and none of its 9 `@keyframes` names collide with globals.css (asserted by
  `app/(marketing)/marketing-port.static.test.ts`, R-MKT T6/T7). **Follow-up condition:** the defect was only ever
  observed against `next dev` — `npx next build` fails on this tree for the pre-existing ReactCurrentDispatcher
  reason. Once `next build` succeeds on master, verify against a PRODUCTION build whether importing marketing.css
  from `app/(marketing)/layout.tsx` + `app/not-found.tsx` keeps the 404 styled; if it does, move the import back out
  of the root. Until then the stylesheet must be imported exactly once, from `app/layout.tsx` (asserted by the same
  static test).
