# RouteFlow — Marketing Strategy

_Companion to [01-product-documentation.md](01-product-documentation.md). Everything here is
constrained to features verified working on 2026-08-19._

---

## 0. Assumptions — confirm or correct these first

The strategy inherits these assumptions; correcting any of them ripples through docs 02–03.

1. **Geography:** North America first (matches the existing site's "Built for North America,
   useful anywhere"), with copy that works anywhere English/Spanish wholesale distribution runs.
2. **Stage:** pre-launch / early launch. No paying-customer testimonials or measured case-study
   metrics exist yet. All proof placeholders stay bracketed until real data exists.
3. **Pricing:** flat monthly per-distributor pricing, retailers free — per the existing pricing
   page (Starter / Growth / Scale) — but the billing platform implements Starter / Team /
   Business / Enterprise + add-ons. **Decision needed: unify tier naming before launch.**
4. **Sales motion:** founder-led. No sales team, modest budget; content and product-led trial do
   the heavy lifting.
5. **Mobile apps:** not yet listed in app stores (site says "coming soon"). Marketing treats the
   web dashboard + buyer portal PWA as the launch surface; mobile becomes a launch beat when the
   store listings go live.
6. **Trial:** 14-day free trial, no credit card (as the site promises). Verify signup →
   onboarding actually delivers this before paid traffic.

---

## 1. What we are selling (product truth)

One sentence: **RouteFlow runs a wholesale distributor's entire order-to-cash loop — orders,
delivery, invoicing, payments, inventory, expenses, and regulated-product compliance — in one
system, with a free self-service portal their retail customers actually want to use.**

Six pillars, all verified solid:

1. **Orders** — scan-to-order, remembered pricing, margin guardrails, park/resume, standing
   orders, post-dispatch change requests.
2. **Invoicing & getting paid** — order↔invoice sync, delivered-quantity billing, check
   lifecycle with NSF, credits/advances, statements that reconcile, recurring invoices.
3. **Inventory & purchasing** — dual case/unit codes, forgiving barcode matching, weighted-
   average costing with history, scan-driven counts, forecasting, restock alerts.
4. **Regulated products** — licence enforcement at sale and delivery, four levy types, immutable
   sales ledger, filing-ready state reports. **This is the wedge.**
5. **Expenses & bookkeeping** — AI bill/receipt scanning with duplicate protection, Schedule-C
   categories, mileage, ~20 reports, real COGS-based P&L.
6. **Buyer portal** — free, seller-branded storefront with "Your Shelf" replenishment
   intelligence, promotions, statements, and licences. **This is the moat and the growth loop.**

Supporting (real, but second billing): delivery-day execution — POD photos/signature, at-door
payment with photo, run settlement. **Never** lead with routing/tracking; live GPS is roadmap.

---

## 2. Market & ICP

### Primary ICP — the buyer of the software

Small and mid-size **wholesale distributors and jobbers** supplying independent retail:
candy/snack/beverage jobbers, convenience-store and bodega suppliers, tobacco/vape distributors,
restaurant and food-service suppliers, beauty-supply distributors.

- Size: roughly 2–25 staff, 1–10 vehicles, 50–1,000 active retail customers.
- Current stack: QuickBooks/Zoho + Excel + paper order pads + a filing cabinet; often one
  "spreadsheet person" the whole business depends on.
- Buying trigger events: an excise-tax filing scare or audit; a bounced-check/receivables mess;
  the invoice-typing backlog hitting nights and weekends; a key office employee leaving; state
  licensing enforcement tightening.

### Priority segment inside the ICP — regulated-goods distributors

Tobacco/vape/nicotine and deposit-bearing beverage distributors have the sharpest, least-served
pain: licence checks, excise/deposit levies, and state filings (e.g. Texas Comptroller, CA
CDTFA). Generic SMB tools don't do this; enterprise DSD suites that do cost 10x. RouteFlow ships
it natively. **Lead generation, content, and ads should over-index on this segment first** — the
pain is urgent, searchable, and specific.

### Secondary audience — the retailer (user, not buyer)

Corner stores, bodegas, markets, restaurants. They don't pay; they adopt the buyer portal
because it's genuinely better than texting orders at 11pm. Every retailer a distributor invites
strengthens lock-in and seeds demand ("does my other supplier have this?"). Marketing to
retailers is mostly **through** the distributor (see the flyer in doc 03 §7).

### Personas

| Persona                                                 | Role                                     | Cares about                                                              | Message that lands                                                   |
| ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **The Owner** (e.g. "Nadia, Acme Distribution")         | Owner-operator, sells + manages          | Cash flow, receivables, compliance risk, not being chained to the office | "Know who owes you what, file without fear, run it from your phone." |
| **The Office** ("Rosa")                                 | Dispatcher / office manager / bookkeeper | The typing: orders, invoices, supplier bills; end-of-month chaos         | "Photograph the bill. Scan the order. The books keep themselves."    |
| **The Driver/Rep** ("Marcus")                           | Delivers + sells from the van            | Speed at the door, not eating blame for money/goods disputes             | "Scan, deliver, snap the check. Proof of everything."                |
| **The Store Owner** ("Marisol, Marisol's Corner Store") | Retail customer                          | Not running out, knowing what she owes, ordering after hours             | "Reorder in two taps, before you run out. Every bill in one place."  |

---

## 3. Positioning

**For** wholesale distributors who supply independent retail **who are** drowning in paper
orders, invoice typing, and compliance paperwork, **RouteFlow** is the operating system for
distribution **that** turns the morning's orders into delivered, compliant, paid invoices by
tonight — **unlike** QuickBooks-plus-spreadsheets (which stops at accounting) or enterprise DSD
suites (built and priced for 100-truck fleets), **RouteFlow** is purpose-built for the small
distributor, includes regulated-product compliance natively, and gives their retail customers a
free ordering portal.

**Keep** the existing brand line: _"Move stock. Move money. Move forward."_ and the category
frame _"The operating system for distribution."_

### Message house

**Roof:** Take the order. Deliver it. Invoice exactly what was delivered. Get paid. One system.

| Pillar                                | Headline message                                               | Top proof points                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Stop typing**                       | Your scanner and camera do the data entry.                     | AI bill scan builds stock + costs; scan-to-order with remembered prices; batch-scan the filing cabinet to migrate.             |
| **Get paid what you're owed**         | The invoice matches the truck, and the money matches the bank. | Delivered-qty billing; check lifecycle w/ auto-reopen on NSF; statements that reconcile to the cent; credit & advance wallets. |
| **Sell regulated goods without fear** | Licence checks at the order, the door, and the filing.         | Sale-time blocks, age/ID gates at delivery, immutable ledger, filing-ready TX/CA reports.                                      |
| **Your customers order themselves**   | A free, branded portal that reorders before they run out.      | Your Shelf replenishment, add-all-low, promotions, statements & "how to pay," notify-me restock alerts.                        |
| **See your real numbers**             | P&L, margins, and dead stock from real sales at real costs.    | Invoice-sourced COGS, margin floors at the point of sale, DSO, forecasting.                                                    |

Tone: plain, concrete, operator-to-operator. Numbers and nouns over adjectives. Bilingual
(EN/ES) assets for social and print in retailer-facing material.

---

## 4. Competitive frame

| Alternative                                                                  | Their story                | Our counter                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status quo** (paper + Excel + QuickBooks)                                  | "It works, I know it."     | Cost of the current system: nights typing invoices, filing weekends, missed collections. Migration is photographable (batch scan) and undoable (24h staging undo); invoice numbers continue where they left off. |
| **Accounting-first SMB tools** (QuickBooks, Zoho Books)                      | Cheap, familiar invoicing. | They stop at the invoice. No orders-at-the-door, no delivered-qty billing, no licence checks, no buyer portal, no case/piece math. RouteFlow syncs the whole loop.                                               |
| **Enterprise DSD/route-accounting suites** (Encompass, eoStar, Pepperi tier) | Deep, proven, fleet-scale. | Priced and implemented for fleets; months of onboarding. RouteFlow is self-serve, flat-priced, and live in days.                                                                                                 |
| **B2B ordering portals** (standalone e-commerce)                             | Nice storefront.           | A storefront without invoicing, compliance, or delivery truth creates _more_ reconciliation. Our portal is welded to the ledger.                                                                                 |

**Defensible differentiators to hammer:** (1) regulated compliance at SMB price, (2) the
order↔invoice↔delivery sync (bill what was delivered), (3) the free buyer portal with
replenishment intelligence, (4) AI-scanned accounts payable that updates stock and costs.

---

## 5. Claim discipline (non-negotiable)

Approved claims = anything in doc 01 §§3–14. Forbidden claims = doc 01 §15 verbatim, plus:

- No invented statistics, customer counts, or testimonials. Placeholders stay `[PLACEHOLDER]`
  and unfilled placeholders **do not ship**.
- The current site's stat bands (3 min / 28% / $0 / 12 hrs; +34% / −42% / +18%) are design
  targets per the source comments. Before paid traffic: reframe as targets ("built so an order
  is confirmed in minutes"), or delete, or replace with measured pilot data.
- "AI" claims are limited to what ships: bill/receipt scanning and route analysis. No "AI runs
  your business" language.
- Compliance copy never promises legal outcomes: "filing-ready reports," never "guaranteed
  compliance." Add "RouteFlow provides records and reports; confirm requirements with your
  state" to compliance-heavy assets.
- Site fixes required (list in doc 03 §9): remove/patch live-tracking, voice-ordering, ACH
  pay-link, and integrations claims; verify app-store claims.

---

## 6. Pricing & packaging strategy

- **Model (keep):** flat monthly per distributor, no per-seat games; **retailers free forever**
  — this is both an acquisition story for distributors ("give your customers a portal at no
  cost to them") and the growth loop.
- **Unify tier naming** between the site (Starter/Growth/Scale) and the billing platform
  (Starter/Team/Business/Enterprise). Recommendation: adopt the platform's names — they're what
  the in-app plan picker and entitlements actually enforce — and map the site's three public
  tiers onto Starter/Team/Business with "Enterprise → Talk to us."
- **Add-ons as expansion revenue** (already built and metered): Buyer Portal, Regulated Items,
  OCR scan packs, Forecasting, extra seats/routes. Marketing implication: the entry plan can be
  priced aggressively because regulated compliance and the portal — the two wedge features —
  carry expansion pricing. Consider bundling Regulated Items into a "Compliance" tier for the
  tobacco/vape segment rather than selling it as a nickel-and-dime add-on to the very segment we
  target.
- **Trial:** 14 days, no card. In-product first-win path: import a customer CSV → scan one
  supplier bill → send one invoice. (The importers, batch scan, and email test are all built —
  onboarding content should walk exactly this path.)

---

## 7. Go-to-market motion

**Phase model: founder-led sales, product-led proof, portal-led spread.**

1. **Land** distributors through the regulated-goods wedge and the "stop typing" story
   (outbound + content + local presence).
2. **Prove** in the trial with the three-step first win above; migration by batch-scanning
   their real filing cabinet is the single most convincing onboarding act.
3. **Spread** through the buyer portal: every distributor invites 50–1,000 retailers; retailers
   experience the portal, ask their _other_ suppliers for it, and the "Connect a seller" flow
   captures that demand. Instrument this loop from day one (portal invites sent → activated →
   cross-seller connection requests).

### Channels, ranked

| #   | Channel                                                                | Why                                                                                                                            | Motion                                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Direct/outbound to regulated distributors**                          | Sharpest pain, clear lists (state tobacco/vape wholesaler licence registries are public)                                       | Founder emails/calls + the compliance flyer + a 15-min demo of licence-block → filing export                                                              |
| 2   | **SEO / intent search**                                                | Buyers search the pain: "tobacco distributor software," "wholesale invoice app," "excise tax report software," "van sales app" | Pillar pages per pain + comparison pages ("RouteFlow vs QuickBooks for distributors"); modest Google Ads on the same terms once the site claims are fixed |
| 3   | **Short-form video (TikTok/Reels/Shorts/FB)**                          | The product is _visually_ demoable: scanning a bill, split-screen scan-to-order, a bounced check reopening an invoice          | 2–3 posts/week from the concept bank in doc 03 §4; Spanish variants of the top performers                                                                 |
| 4   | **Cash-and-carry warehouses & trade shows**                            | Where distributors physically are (regional wholesale marts, NACS-adjacent regional shows, state distributor associations)     | Print flyers + brochure (doc 03 §§5–6), live scan demo on a phone, QR to trial                                                                            |
| 5   | **Facebook groups / WhatsApp communities** of c-store owners & jobbers | High trust, zero cost                                                                                                          | Helpful posts (margin math, filing checklists), not ads; the retailer flyer doubles as shareable image                                                    |
| 6   | **LinkedIn**                                                           | Founder story + credibility for the "Business/Enterprise" conversation                                                         | Weekly build-in-public posts, feature explainers                                                                                                          |
| 7   | **Referral**                                                           | Distributors know each other                                                                                                   | Simple give-get (a free month per referred distributor) once ≥10 paying tenants                                                                           |

### 90-day launch plan

**Days 1–30 — Truth & foundation.**
Fix the website claims (doc 03 §9); unify pricing tiers; instrument analytics (trial starts,
first-win events, portal invites); produce the first 6 videos + the 3 print pieces; build the
regulated-distributor outreach list from public licence registries; recruit 3–5 design partners
(free/discounted in exchange for measurable results and quotable feedback).

**Days 31–60 — Proof & outbound.**
Run the design partners through migration; capture real numbers (time to invoice a delivery,
time to prepare a filing, DSO change) and first testimonials; start outbound at 20–30
contacts/week; publish 2 SEO pillar pages; post video 2–3×/week; first regional trade
show/warehouse visit with print materials.

**Days 61–90 — Scale what worked.**
Replace `[PLACEHOLDER]` proof with measured results across site/brochure/flyers; turn the best
organic video into paid creative; launch Google Ads on high-intent terms; publish the first case
study; ship the referral offer; decide the mobile-app-store launch beat.

---

## 8. Metrics

| Funnel stage  | Metric                                                            | 90-day target (adjust to reality)            |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Reach         | Video views + site sessions                                       | Baseline → trend up; ≥3 videos >10k views    |
| Capture       | Trial signups                                                     | 40 trials                                    |
| Activate      | First-win rate (import + 1 bill scanned + 1 invoice sent ≤7 days) | ≥50% of trials                               |
| Convert       | Trial → paid                                                      | ≥20% of activated                            |
| Spread        | Portal invite activation; cross-seller "connect" requests         | ≥30% invite activation; loop instrumented    |
| Retain/expand | Add-on attach (Regulated, OCR packs); logo churn                  | Regulated attach ≥60% in the tobacco segment |
| Proof         | Measured case-study metrics captured                              | ≥3 quantified stories                        |

Budget guidance (lean): $0 paid until site claims are fixed and activation ≥40%; then
$1–3k/month on search + retargeting of video viewers. Print run: 500 flyers × 2 + 250
brochures for the first shows.

---

## 9. Risks & mitigations

- **Overclaim debt on the current site** → fix before paid traffic (doc 03 §9). Highest-priority
  marketing task in the repo.
- **Regulated positioning attracts compliance scrutiny** → keep the "records and reports, not
  legal advice" disclaimer; never name specific legal outcomes.
- **Mobile-app expectations** (site demos phone flows while stores say "coming soon") → label
  phone footage "mobile web / early access" until store listings are live, then run a dedicated
  launch beat.
- **Single-founder bandwidth** → the calendar in doc 03 is deliberately batchable: one filming
  afternoon yields a month of clips.
- **Buyer-portal loop stalls if invites aren't sent** → make "invite your customers" an explicit
  onboarding step and a success-metric conversation with every design partner.
