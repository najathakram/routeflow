# Messaging guardrails

_The rules every public sentence about the product follows: the website, decks, sales copy, emails,
posts, ads and the app store listing. Set 2026-11-23; corrected 2026-11-24._

The source of truth for what the product does is [the claims register](../product/claims-register.md).
Where this page and the register disagree, the register wins. Prices come from the catalog on sale
([billing-plans.md](../product/billing-plans.md)), never from a document.

## The core message

> **Your business shouldn't live in your head.**

Supporting lines say what changes for the owner: prices, orders, who owes what, and what is in stock
live in one place that the whole team and every store can see.

## The rules

1. **Every public sentence is backed by code and by a register row.** If the register says
   `not built`, `partly true` or `UNKNOWN`, the sentence does not ship. Any PR that changes what a user
   can do updates its register row.
2. **Do not claim these until the register says `live`:**
   - a driver photo, signature or payment at the door;
   - invoices that follow delivered quantities;
   - a live map of drivers;
   - text messages;
   - a QuickBooks, Xero or Zoho link;
   - several warehouses;
   - lots, expiry dates or bins;
   - EDI;
   - an API;
   - two-step login;
   - credit limits that stop a new order;
   - message threads with stores and drivers;
   - a tobacco license "flagged when it expires" (claims register A1);
   - a plan that takes payment before it goes active.
3. **No reviews, testimonials, client names, logos or client counts** on any page for now. The owner
   says when that changes, and each one needs the client's written consent.
4. **No invented numbers.** No hours saved, no percentage gains, no "trusted by". The only figures
   allowed are prices and arithmetic on prices. Figures on a product screenshot are sample data and
   are labelled as such.
5. **No false urgency.** No countdown, no "was" price that was never charged, and no "most popular"
   label until sign-up data supports it. "Recommended" is fine.
6. **Guarantees stay private until legal review is done.** That covers live in 7 days, a 30-day money
   back offer, the 24-month price lock, and any comparison with a named competitor.
7. **Competitor figures** in internal documents carry the date they were checked and are re-checked
   before anyone quotes them. No competitor is named on a public page without review.
8. **A price rises only when a feature ships**, only for new accounts, and never without the notice
   periods in `billing-plans.md` ([pricing-roadmap.md](../product/pricing-roadmap.md)).
9. **Prices on a page come from the catalog on sale.** The site reads one price object
   (`apps/web/public/site/js/prices.js`), and a static test pins it and every price on the page to the
   catalog on sale. A new plan is not shown in public before its catalog is on sale.
10. **Motion on the marketing site** follows the standing ruling of 2026-11-03 and
    `site-motion-always.static.test.ts`. Pricing and copy work does not change it.
11. **No new brand name in public text** until the owner and the lead say the rename ships. Use
    today's name.

## The "does and doesn't" list

This list is public on purpose (`apps/web/public/site/does-and-doesnt.html`). Saying plainly what the
product does not do is part of the message. A guarded-phrase test lists every sentence on the site
that names one of these things. A new sentence needs a ledger entry and a reviewer.

**What it does:** sell (orders, prices, promotions, estimates), let stores order online at their own
prices, get paid (bills, payments, returns), buy and keep stock (suppliers and one count per product),
deliver (routes and stops for drivers), sell at the counter (scan and print a receipt), see your
numbers (sales, profit, who owes you), and sell regulated items such as tobacco.

**What it does not do:**

| Not in the product                                       | What you get instead                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| Separate warehouses                                      | One stock count per product                                |
| A general ledger                                         | Reports from sales and expenses; keep your accounting tool |
| FIFO or LIFO costing                                     | Weighted average cost by default, or last cost             |
| Lots, expiry dates, bins                                 | Not tracked                                                |
| EDI                                                      | Not connected                                              |
| QuickBooks, Xero or Zoho                                 | CSV files                                                  |
| A carrier connection                                     | An order can keep the carrier's name                       |
| A live map of drivers                                    | Each stop on the web; no truck on a map                    |
| Text messages                                            | Email notices                                              |
| Two-step login, company single sign-on, an API, webhooks | Password or Google sign-in                                 |
| A driver photo, signature or payment at the door (web)   | The office records the payment                             |

## How to check a sentence before it ships

1. Find its row in the claims register. If there is none, add one with a code path or test as proof.
2. If the row is not `live`, change or cut the sentence.
3. If the sentence names something in the "does not do" list, add it to the guarded-phrase ledger in
   the same PR, with its page and exact wording.
4. If the sentence has a price in it, the price comes from the catalog on sale.
