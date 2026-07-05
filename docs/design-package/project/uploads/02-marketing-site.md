## 2. Marketing / Public Site — (marketing)

**Audience:** Anonymous visitors (no auth). Two buyer personas the site explicitly forks between — **wholesalers/distributors** (the paying operator side) and **retailers** (the free buyer side).  •  **Entered via:** the site root `/` and its sibling public routes. Every logged-out person who lands on `routeflow.info` sees this before any auth surface. There is no bottom nav — a sticky top nav with a centred **side-switch** is the primary way to move between the two audience worlds.

The marketing site is a static, mostly server-rendered brochure: a neutral home that funnels visitors into one of two audience "sides," per-audience landing pages, a product tour, a company/about page, and a pricing page. It is **completely visually isolated** from the rest of the app — a scoped `.rf-marketing` CSS wrapper (teal/cream palette + Instrument Serif display type) that never leaks into the operator dashboard or buyer portal. All real actions leave the site: every CTA routes to an existing auth page (`/signup`, `/login`, `/buyer/register`, `/buyer/login`) or to the top-level `/contact` form.

### Layout & theming mechanism

#### Marketing shell — `(marketing)/layout.tsx`
- **File:** `apps/web/app/(marketing)/layout.tsx`
- **Purpose:** Wrap every marketing page in the scoped design system and set the current "side."
- **Shows:** `<div className="rf-marketing" data-side={side}>` → `<MarketingNav />` + `{children}` + `<MarketingFooter />`. Imports `./marketing.css` (scoped tokens).
- **Actions:** None itself — it is a pure wrapper. It computes `side = getSideFromPath(pathname)` and stamps it onto the wrapper `data-side` attribute.
- **States:** `data-side` ∈ `neutral | retailer | wholesaler`. Because `side` is derived from the pathname during render, the wrapper attribute is correct on first paint (no theme flash). **Historical note in the source:** an `AutoRedirectIfAuthed` that bounced logged-in users from `/`, `/retailers`, `/wholesalers` to `/dashboard` was **removed** — its localStorage-only token check false-fired on stale tokens and trapped users in a `/` → `/dashboard` → `/login` loop. Marketing pages now always render; logged-in users re-enter via the nav "Sign in".

#### Side theming — `(marketing)/marketing.css` + `components/use-side.ts`
- **Files:** `apps/web/app/(marketing)/marketing.css`, `apps/web/app/(marketing)/components/use-side.ts`
- **Mechanism.** All tokens live under the `.rf-marketing` scope. A base palette is declared once (teal `#0B6E6B`, cream `#FAF6EE`, ink `#0E1F36`, plus rust/citron/plum accents), and a set of **`--rf-side-accent*` variables** default to teal. Two attribute selectors override just those side-accent vars (and the page background) — nothing else re-declares colors, so re-theming is a handful of variable swaps:

  | `data-side` | Accent (`--rf-side-accent`) | Deep | Soft / wash | Background |
  |---|---|---|---|---|
  | `neutral` (default) | teal `#0B6E6B` | `#073F3D` | `#E8F2F1` | cream `#FAF6EE` |
  | `retailer` | **rust `#C75A3D`** | `#8B3520` | `#FFF4E0` / rust wash | warm cream `#FBF6E9` |
  | `wholesaler` | **teal `#14a39f`** | `#0B6E6B` | `#E8F2F1` / teal wash | cream `#FAF6EE` |

  Consumers of the swap: `.eyebrow` (dot + text recolor on side pages), `.display em` (italic emphasis recolors — rust on retailer), `.btn-side` (audience CTA fill), `.side-tag` pill, and the active `.side-switch` tab. So switching side re-themes accents/emphasis/CTAs while ink + cream body stay constant.
- **`getSideFromPath(pathname)` mapping** (the single source of truth):
  - `/retailers*` → `retailer`
  - `/wholesalers*`, `/distributors*`, **and `/pricing*`** → `wholesaler`
  - everything else (`/`, `/product`, `/company`) → `neutral`
- **Other primitives in `marketing.css`:** `.wrap`/`.wrap-narrow` containers (1240/920px), `.sect*` section paddings, sticky blurred `.nav`, `.btn*` pill buttons (primary=ink, teal, ghost, side, sizes lg/sm), `.display` serif headings, `.card`/`.chip`, an animated `@keyframes rfMarquee` (industries strip) + `rfFadeUp` reveal, and a dark `.footer`. Responsive: side-switch hidden < 768px; nav side-links hidden < 1024px; audience grid collapses to 1 column < 1024px.

#### Nav — `components/nav.tsx`
- **File:** `apps/web/app/(marketing)/components/nav.tsx`
- **Purpose:** Sticky top bar; the centred side-switch is the site's main navigation device.
- **Shows:**
  - **Brand** (left): `Logo` + "RouteFlow". On a themed page, a `.side-tag` pill reads "Retailers" or "Wholesalers".
  - **Side-switch** (absolutely centred, `role="tablist"`): three links — **"Overview"** (`/`, active when neutral), **"I'm a retailer"** (`/retailers`), **"I'm a wholesaler"** (`/wholesalers`). The active tab gets a white pill; on themed pages its text takes the side-accent-deep color.
  - **Right side:** rendered **only on themed pages** (`side !== "neutral"`) — a **"Sign in"** text link + a filled `.btn-side` CTA. Neutral pages deliberately render nothing here (the centre switch is the only entry point).
- **Actions / CTA targets** (all via `getAuthHref(side, mode)` in `components/auth-links.ts`):
  | Side | "Sign in" → | CTA label | CTA → |
  |---|---|---|---|
  | retailer | `/buyer/login` | **"Sign up"** | `/buyer/register` |
  | wholesaler | `/login` | **"Start free trial"** | `/signup` |
  | neutral | (hidden) | (hidden) | — |
  - Note in source: retailer CTA says **"Sign up"** (free portal account), not "Get the app" — the standalone mobile app isn't shipped yet.
- **States:** Side-specific links (Features/Pricing/Help/Company) were **intentionally removed** from the nav-right because they overlapped the centred switch; they live only in the footer. Side-switch hidden entirely on mobile (< 768px).

#### Footer — `components/footer.tsx`
- **File:** `apps/web/app/(marketing)/components/footer.tsx`
- **Purpose:** Dark ink footer, shared across all marketing pages.
- **Shows:** Brand blurb + `mailto:hello@routeflow.info`; three link columns — **Product** (Features→`/product`, For wholesalers→`/wholesalers`, For retailers→`/retailers`, Pricing→`/pricing`), **Company** (About→`/company`, Contact→`/contact`), **Sign in** (Wholesaler portal→`/login`, Retailer portal→`/buyer/login`); copyright "© {year} RouteFlow · Austin, Texas"; a giant faded "RouteFlow" tail mark.
- **Actions:** Static links only. Source note: columns are deliberately minimal — no dead `#` links, no legal/social/app-store links because those pages don't exist yet.
- **States:** Not side-themed (always ink/cream). Tail mark shrinks on < 1024px.

### Pages

#### Home / Landing — `/`
- **File:** `apps/web/app/(marketing)/page.tsx` (+ `components/audience-split.tsx`, `flow-spotlight`, `get-app-section`, `industries-marquee`, `testimonial`)
- **Purpose:** Neutral top-of-funnel; explain the two-sided model and route visitors to their side.
- **Shows (top → bottom):**
  1. **Hero** — eyebrow "The operating system for distribution"; serif H1 "One platform for the people who *move stock* and the people who *stock shelves.*" (`clamp(54–104px)`); subhead about connecting wholesalers/distributors/jobbers with corner stores/bodegas; kicker "Pick your side below to see how it works for you." Two blurred radial glows (teal + rust) behind it.
  2. **`<AudienceSplit>`** — the marquee element (see below).
  3. **Pillars** — eyebrow "What's inside" + H2 "Six modules. One *continuous* flow."; a **3-col grid of 6 feature cards** (`PILLARS`): Order intake, Route planning, Smart invoicing, Customer portal, Finance & books, Run your way — each icon + title + body.
  4. **`<FlowSpotlight>`** and **`<GetAppSection>`** components.
  5. **Numbers strip** — 4 stat cells: "3 min" (avg confirm), "28%" (on-time lift), "$0" (reconciliation errors), "12 hrs" (saved/week). Source comment: these are **product-design targets, not metric claims**.
  6. **`<Testimonial>`** and **`<IndustriesMarquee>`** (the animated `.marquee`).
  7. **Big CTA** — serif "Try it on a *real route.*", subhead "Spin up an account in 4 minutes…", **"Start free trial"** → `/signup` + **"Talk to sales"** → `/contact`, microcopy "14-day trial · No credit card · Cancel anytime".
- **Actions:** Audience cards (see below); hero/CTA buttons → `/signup`, `/contact`.
- **States:** `neutral` theming (teal accents). Static — no auth-gated content.

#### Audience split — `components/audience-split.tsx` (on `/`)
- **File:** `apps/web/app/(marketing)/components/audience-split.tsx`
- **Purpose:** The two big clickable "choose your world" cards — the single most important conversion element on the home page.
- **Shows:** Eyebrow "Pick your side" + H2 "Two sides of the same trade. *Tap into yours.*"; a 2-col grid:
  - **Retailer card** (warm rust/peach gradient): segment line "Corner stores · Bodegas · Cafés · Salons · Convenience", **"Free forever"** badge, H3 "I'm a *retailer.*", copy about wanting suppliers' catalogs at *my* price, feature chips (📦 Reorder / 🎤 Voice search / 🚚 Live ETAs / 💳 Pay invoices), a `PhoneRetailerHome` mock, and an **"Enter retailer site"** pill.
  - **Wholesaler card** (dark teal/navy gradient + grid pattern): segment line "Distributors · Wholesalers · Jobbers · FMCG", **"14-day trial"** badge, H3 "I'm a *wholesaler.*", copy about running trucks/routes on one rail, chips (🗺 Route opt. / 📋 Dispatch / 🧾 Auto-invoice / 💰 Collections), a `MockOrdersTable`, an **"Enter wholesaler site"** pill.
  - Kicker: "Already use RouteFlow? Pick your side above to sign in."
- **Actions:** Retailer card → `/retailers`; wholesaler card → `/wholesalers`. Hover lifts the card (3D translate/rotate + shadow, `useState` hover).
- **States:** Hover-only interactivity; collapses to 1 column < 1024px.

#### For Retailers — `/retailers`
- **File:** `apps/web/app/(marketing)/retailers/page.tsx`
- **Purpose:** Retailer-side landing — pitch the free buyer app/portal.
- **Shows:** **Hero** (2-col) — eyebrow "For retailers", H1 "Order stock *between customers.*", copy for corner stores/salons/restaurants/hardware, **"Sign up"** → `/buyer/register` + **"Sign in"** → `/buyer/login`, kicker "Free forever — no fees, no card."; two overlapping phone mocks (`PhoneShop` + `PhoneRetailerHome`). **Feature grid** (3-col, 6 cards `FEATURES`): 🎤 Voice ordering, 📦 Reorder in 2 taps, 📍 Live tracking, 💸 Pay your way, 🧾 Every bill in one place, 🌐 Multiple suppliers — each with body + chips. **Sign-up CTA band** (ink bg): "Create your free *retailer account.*", copy "your suppliers pay for the platform", **"Sign up"** → `/buyer/register` + **"Already have an account? Sign in"** → `/buyer/login`, footnote "Mobile app for iOS & Android — coming soon."
- **Actions:** All CTAs → buyer auth (`/buyer/register`, `/buyer/login`).
- **States:** **`retailer` theming — rust accent** (`#C75A3D`), warm cream bg, rust italic emphasis; nav shows "Retailers" tag + rust `.btn-side` CTA.
- **Source note:** the old "Get the RouteFlow Shop app" section was replaced by the sign-up band because the standalone app isn't shipped.

#### For Wholesalers — `/wholesalers`
- **File:** `apps/web/app/(marketing)/wholesalers/page.tsx`
- **Purpose:** Wholesaler/distributor-side landing — the paying operator pitch.
- **Shows:** **Hero** (2-col) — eyebrow "For wholesalers", H1 "Run your routes *like clockwork.*", copy for distributors/jobbers/supply, **"Start free trial"** → `/signup` + **"Book a demo"** → `/contact`; a rotated `MockOrdersTable`. **Pain → fix grid** (3-col, 6 `PAINS` cards, mono "THE PAIN"/"THE FIX" labels): phone/notebook order chaos, drivers calling dispatch, 3 hrs of QuickBooks typing, unknown route profitability, "$25,000 in follow-up later", key-staffer-leaves knowledge loss. **Targets band** (ink bg) — H2 "What we're building toward, *per route:*" with disclaimer "Targets from internal pilots — numbers refresh as we scale."; 4 stats: +34% orders/dispatcher, −42% order→paid time, +18% weekly-ordering customers, 12 hrs saved/week. **Final CTA** — "Ready to *tighten* the wheel?", **"Start free trial"** → `/signup` + **"Sign in"** → `/login`.
- **Actions:** CTAs → operator auth (`/signup`, `/login`) + `/contact`.
- **States:** **`wholesaler` theming — bright teal accent** (`#14a39f`); nav shows "Wholesalers" tag + teal `.btn-side` CTA.

#### Distributors — `/distributors` ⚠️ (redirect only)
- **File:** `apps/web/app/(marketing)/distributors/page.tsx`
- **Purpose:** Legacy-URL compatibility. **Not a real page** — `redirect("/wholesalers")` server-side.
- **Shows / Actions / States:** Nothing rendered. Source comment: `/distributors` was the original design's URL for the wholesaler side; `/wholesalers` was chosen as canonical to match nav copy ("I'm a wholesaler"), and this redirect keeps old links working. (Note: `use-side.ts` still maps `/distributors*` → `wholesaler`, but the redirect fires before any theming matters.)

#### Product — `/product`
- **File:** `apps/web/app/(marketing)/product/page.tsx`
- **Purpose:** Full feature tour (neutral).
- **Shows:** Header — eyebrow "Product", H1 "One platform. The *whole* distribution flow." Then **6 alternating `FeatureBlock`s** (each eyebrow + serif title + intro + 3 titled points + a mock, alternating `reverse`):
  1. **Order intake** — smart dedup, auto tier pricing, credit/overdue checks — `MockOrdersTable`.
  2. **Route planning** — one-click build, offline driver app, live ETA + photo POD — `MockRouteMap`.
  3. **Smart invoicing** — auto-generate from POD, multi-channel send/ACH, credit notes & part-payments — `MockInvoice`.
  4. **Customer portal & app** — branded, voice search EN/ES, reorder lists/favourites — `PhoneShell`+`PhoneShop`.
  5. **Finance & books** — ACH/card reconciliation, tax-ready exports, real-time P&L by route — a cash-collected card ($184,200) with `Spark` + `StatTile`s.
  6. **Run your way** — custom roles, multi-warehouse stock, open API/webhooks — a mock `POST /api/orders` JSON snippet.
  Ends with an **ink CTA strip** — "See it on *your data.*", **"Start free trial"** → `/signup` + **"Book a guided demo"** → `/contact`.
- **Actions:** CTAs → `/signup`, `/contact`.
- **States:** `neutral` theming (teal). Note: `/product` is neutral, so nav shows no side tag or right-side CTA — only the centre switch.

#### Company / About — `/company`
- **File:** `apps/web/app/(marketing)/company/page.tsx`
- **Purpose:** Founder story + values (neutral).
- **Shows:** Hero — eyebrow "Company", H1 "We grew up in the *warehouse.*", subhead "started by people who'd actually run distribution businesses". **Story** (2-col) — founders ran a multi-van FMCG business in Central Texas, tried every tool, built RouteFlow; a rust→plum gradient tile "Built for distributors of every size / From one van to fifty / Operating from *Austin, Texas*". **Values** — H2 "What we *care about.*", 3 numbered cards (01 Real businesses not slide decks, 02 Built for North America EN/ES/rural, 03 Software that gets out of the way). **Contact band** (cream-2 bg) — "Get in *touch.*", **"Book a demo"** → `/contact` + **"Email us"** → `mailto:hello@routeflow.info`.
- **Actions:** → `/contact`, mailto.
- **States:** `neutral` theming.

#### Pricing — `/pricing`
- **File:** `apps/web/app/(marketing)/pricing/page.tsx` (+ `components/pricing-tiers.tsx`, `components/pricing-faq.tsx`)
- **Purpose:** Plans, billing toggle, FAQ.
- **Shows:**
  - Header — eyebrow "Pricing", H1 "One clear price. No *seat games.*", subhead "Distributors pay a flat monthly fee. Retailers use the app for free."
  - **`PricingTiers`** — a **monthly/yearly toggle** ("Yearly · save 16%", `useState`). 3 tiers:
    | Tier | Monthly | Yearly | CTA → | Notes |
    |---|---|---|---|---|
    | **Starter** | $49/mo | $41/mo | "Start free trial" → `/signup` | 200 customers, 1k orders/mo, 1 warehouse, 2 seats |
    | **Growth** ⭐ *Most popular* | $129/mo | $108/mo | "Start free trial" → `/signup` | 1k customers, 8k orders/mo, 3 warehouses, 10 seats, route opt. |
    | **Scale** | "Let's talk" | — | "Talk to sales" → `/contact` | Unlimited, SSO, SLA, on-site training |
    - An **"Included on every plan"** band: mobile retailer app (free for customers), unlimited products, unlimited runs, bookkeeping/tax exports, bank-grade security, iOS & Android apps, API access.
  - **`PricingFaq`** — H2 "Common *questions.*"; 6 native `<details>` accordions (no JS): retailers pay nothing, >8k orders → Scale, import from QuickBooks/Zoho/Excel, sales-tax filing, cancel anytime, price-lock-for-life.
- **Actions:** Billing toggle (client state); tier CTAs → `/signup` / `/contact`.
- **States:** **`wholesaler` theming** (pricing maps to wholesaler via `use-side.ts`) — so nav shows a "Wholesalers" tag + teal CTA even though the page itself is audience-agnostic. Featured "Growth" tier renders inverted (ink bg).

### Cross-link: `/contact` (marketing contact form — lives outside this group)
- **File:** `apps/web/app/contact/page.tsx` (top-level, **not** in `(marketing)`).
- Every marketing "Talk to sales" / "Book a demo" CTA targets `/contact`. It is the marketing lead-capture / demo-booking form, but it does **not** use the `.rf-marketing` shell — it renders its own Tailwind nav (navy/`brand-*`, lucide icons, "Book a Demo" heading, first/last name + form fields). **Full documentation of the contact form belongs to `01-auth-and-entry.md`** (it's grouped with the top-level auth/entry surfaces there); this section only notes the relationship: it is a marketing destination reached from marketing CTAs, styled in a *third*, unrelated design language.

### Key flows (end-to-end journeys through this area)
- **Neutral → pick a side → convert:** `/` hero → `<AudienceSplit>` (or nav side-switch) → `/retailers` (rust) *or* `/wholesalers` (teal) → side CTA → the matching auth page (`/buyer/register` or `/signup`).
- **Side-switch re-theming:** clicking "I'm a retailer" / "I'm a wholesaler" / "Overview" changes the pathname → `getSideFromPath` recomputes `side` → layout re-stamps `data-side` → accent/emphasis/CTA colors and the nav CTA target all swap in one paint.
- **Compare plans → trial:** any nav/page CTA → `/pricing` → billing toggle → tier CTA → `/signup` (Starter/Growth) or `/contact` (Scale).
- **Learn more → demo:** `/product` or `/company` → "Book a demo" / "Talk to sales" → `/contact` form.

### Use cases
- As a retailer, I want to see the app is free and sign up for a portal account. (path: `/` → retailer card → `/retailers` → `/buyer/register`)
- As a wholesaler, I want to see it solves my order/route/collections chaos and start a trial. (path: `/` → wholesaler card → `/wholesalers` → `/signup`)
- As a visitor unsure which I am, I want a neutral overview of the whole platform. (path: `/` → `/product`)
- As a buyer comparing tools, I want transparent pricing with no per-seat games. (path: nav → `/pricing`)
- As an existing user, I want to sign in from the marketing site. (path: pick side → nav "Sign in" → `/login` or `/buyer/login`)

### Business rules & edge cases
- **Side is 100% pathname-derived** (`getSideFromPath`) — there is no cookie/state; theming is deterministic and SSR-safe (no flash).
- **Pricing counts as "wholesaler"** for theming even though the page serves both audiences — a deliberate mapping, not a bug, but it means the nav shows a "Wholesalers" tag on a shared page.
- **Neutral pages hide the nav Sign-in + CTA** — on `/`, `/product`, `/company` the only nav entry point is the centre side-switch. Confirm the redesign preserves an obvious sign-in affordance on neutral pages.
- **`getAuthHref` is the single source of truth** for auth targets across nav, audience cards, and hero CTAs. Retailer → buyer auth (`/buyer/*`); neutral + wholesaler → operator auth (`/login`/`/signup`).
- **No logged-in redirect** — marketing always renders even for authed users (the removed `AutoRedirectIfAuthed`); returning users must click "Sign in".
- **All stats are aspirational** — the source explicitly labels the home "Numbers" and wholesaler "Targets" as design targets / internal-pilot numbers, not verified metrics. Any redesign copy must keep them clearly non-claims.
- **Footer links only where real pages exist** — no legal/social/app-store links by design (avoids 404s).
- **Mobile app is "coming soon"** — retailer copy and the "Sign up" CTA (instead of "Get the app") both reflect that the standalone consumer app isn't shipped; pricing/footer still list "iOS & Android apps" as included, a copy inconsistency worth reconciling.

### 💡 Faster ways (redesign suggestions — quarantined, not baked in)

1. **Consolidate `/distributors` and `/wholesalers`.** `/distributors` is a pure server redirect to `/wholesalers`. `use-side.ts` still carries dead `/distributors*` branch logic. Keep the redirect for old links but treat wholesalers as the only canonical file, and drop the distributors branch from `getSideFromPath` (unreachable after redirect).
2. **The two role landing pages are near-symmetric.** `/retailers` and `/wholesalers` are the same skeleton (hero + 2-col mock, 3-col feature/pain grid, ink CTA band) differing only in copy, accent, and auth target. Consider a **single data-driven audience template** parameterised by `side` — one component, two content objects — to guarantee they never drift visually.
3. **Unify the marketing nav CTA into the single auth entry.** CTA label + target already funnel through `getAuthHref`; the redesign could make **every** marketing sign-in/sign-up land on one auth entry that routes by role, rather than four distinct pages (`/login`, `/signup`, `/buyer/login`, `/buyer/register`). This also fixes the neutral-page "no visible sign-in" gap.
4. **Fold `/contact` into the marketing design system.** It's a *third* visual language (Tailwind navy/`brand-*` + lucide, its own nav) reached only from marketing CTAs. Rehousing it under `.rf-marketing` (or the unified system) removes one of the "different apps" surfaces flagged in the README catalogue.
5. **Reconcile "coming soon" vs "iOS & Android apps included."** Retailer page says the app is coming soon; pricing "Included on every plan" and the FAQ say the mobile app ships today. Pick one truth for the redesign copy.
6. **Home has heavy per-element inline styles.** Nearly every home/landing block uses inline `style={{…}}` rather than the `marketing.css` primitives. The redesign should push these into tokenised classes so side-theming and future restyles are single-source.

### Relevant files (all absolute)
- `C:\ClaudeCode\routeflow\apps\web\app\(marketing)\layout.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(marketing)\marketing.css`
- `C:\ClaudeCode\routeflow\apps\web\app\(marketing)\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(marketing)\{product,company,pricing,retailers,wholesalers,distributors}\page.tsx`
- `C:\ClaudeCode\routeflow\apps\web\app\(marketing)\components\{nav,footer,use-side,auth-links,audience-split,pricing-tiers,pricing-faq}.tsx`
- Supporting components: `components\{flow-spotlight,get-app-section,industries-marquee,testimonial,feature-block,logo,icons}.tsx`, `components\mocks\*` (orders-table, route-map, invoice, spark, stat-tile, phone-shell, phone-shop, phone-retailer-home)
- Cross-link (documented in `01-auth-and-entry.md`): `C:\ClaudeCode\routeflow\apps\web\app\contact\page.tsx`
