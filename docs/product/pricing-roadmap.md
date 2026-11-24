# Pricing roadmap: which feature moves which price

_Decided 2026-11-23 by the owner. This page documents the path. It starts nothing: no row below is
built without the owner's go-ahead._

The plans and add-ons are in [billing-plans.md](billing-plans.md). Why plans follow features:
[ADR 0005](../adr/0005-feature-based-plans.md).

## The rule

1. **A price moves only when its feature is live.** "Live" means its row in
   [claims-register.md](claims-register.md) says `live`, not "merged" and not "behind a flag".
2. **Only for new accounts.** Paying accounts keep their price through their protection (12 months,
   then a review with 90 days' written notice; founding accounts 24 months).
3. **Never without notice.** A scheduled price, such as delivery's $49, is stored in the catalog with
   its notice date before it applies.
4. **The ladder rule still holds after the move.** Each move goes through a new catalog version, and
   the ladder spec re-checks it (`billing-plans.md`, "The ladder rule"). A published catalog version is
   never amended.
5. **No public price ahead of the code.** The pricing page is pinned to the catalog on sale by a static
   test, so the page cannot show a price the catalog does not sell.

## The path to $449

| Roadmap row                   | Feature                              | Price effect when live                                                        |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| F-18                          | QuickBooks Online sync               | A $49 add-on on Essentials and Growth; included in Pro                        |
| F-20                          | Multi-warehouse and transfers        | A $49 add-on on Essentials and Growth; included in Pro                        |
| F-18 and F-20 both live       |                                      | Pro's parts total $473 ($375 + $49 + $49); Pro moves to $449 for new accounts |
| F-21                          | MSA filings and purchase-time excise | The filings add-on moves from $79 to $99; Pro's parts total $493              |
| F-17, or another paid feature | Delivery notices and a tracking link | Pro can reach $499 only if its parts then total more than $499                |

"Pro's parts" means Growth ($199) plus every add-on Pro includes, at their scheduled prices. Pro stays
below that total (ladder check 2).

## Before any of it: what Pro needs to be sold

These come first. They are prerequisites, not price moves.

| Need                                                 | Why                                                                                                                                    | State today                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Drivers can complete a stop that has regulated items | Pro is aimed at tobacco wholesalers with their own vans. The owner decided on 2026-11-23 that this is fixed before Pro is sold to them | The web driver screen cannot; the stop needs a signature and an age or ID check (claims register A3). No roadmap row yet |
| Card checkout before a plan goes active              | A self-serve pick goes active with no payment today (claims register A12)                                                              | Built behind a flag that is off; no checkout                                                                             |
| A store-count allowance                              | Essentials sells 25 stores ordering online                                                                                             | Not built                                                                                                                |
| Message threads that work                            | A Growth feature                                                                                                                       | API only (claims register A9)                                                                                            |

Until the first row ships, wherever Pro is described to tobacco businesses, say that drivers cannot
complete a stop with regulated items yet.

## Pro extras promised "when each is live"

None appears on a public page until its register row says `live`.

| Extra                      | State today                                         | Left to do                                                                          |
| -------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Own-mailbox sending (F-10) | Built behind a dark add-on; 85%                     | The owner's console steps for Google and Microsoft; an end-to-end test (D-14)       |
| Statement matching         | Built, on every plan                                | Decide whether it stays on every plan or becomes a Pro extra                        |
| Margin warnings            | Margin alerts exist in analytics (`flag.analytics`) | Decide what "warning" adds beyond today's alert. No roadmap row                     |
| Priority support           | Not a code feature                                  | A support promise and a way to tell Pro accounts apart in the inbox. No roadmap row |

## Scoping notes

### F-18: QuickBooks Online sync

- **Smallest version worth $49:** one-way, from the product to QuickBooks. Invoices, payments and
  customers go out daily, with a mapping screen for income and tax accounts and a log of what was
  sent. No import from QuickBooks.
- **Main risks:** Intuit app review and OAuth token upkeep; double posting when an invoice changes
  after it was sent; boxed lines and regulated tax lines that QuickBooks has no shape for.
- **Rough size:** L. It needs a new connector module, a sync ledger table (a migration), and a
  settings screen. Several PRs.
- **Until it ships:** a QuickBooks-ready CSV export is the honest answer to "I already use QuickBooks".

### F-20: Multi-warehouse and transfers

- **Smallest version worth $49:** two or more stock locations per account, stock counted per
  location, transfers between them, and an order that picks from one location. No bins, no lots.
- **Main risks:** every stock read today assumes one count per product (claims register, section D),
  so this touches inventory, counts, purchase receiving, returns and the regulated ledger. Moving
  existing stock into a default location is a data migration.
- **Rough size:** L. It reworks a shipped model and needs a migration and a census of every stock
  writer. It should get its own spec and a Design Gate.
