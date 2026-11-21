# Copy ledger (WP1.3a wording audit)

Status: DRAFT for the owner's one-sitting approval. Read-only audit; no code changed. Written against branch files in `C:/ClaudeCode/wt/rovio-site` (the planned `live-now/text/` folder does not exist). Style: `apple-write` (plain, "you", present tense, one term per thing, no filler). The product name stays "RouteFlow" in every proposal; the rename is a separate package.

How to read it
- One table per page or file. `file:line` is the line in the file as it stands on the branch. `current` is the visible text, title, meta description, alt or aria-label, shortened with an ellipsis where a row groups several lines of one block.
- `proposed` is `KEEP` unless the text is unclear, wordy, inconsistent with another page, wrongly cased, or duplicated. A row that groups lines marked KEEP means every line in it was read.
- Flags: `NAME` product name, `HOST` domain, `EMAIL` address, `PRICE` typed price or tier ("typed" when written in the file rather than read from `js/prices.js`), `LEGAL` flag only, `CLAIM` a factual statement someone should verify (no claim was invented or strengthened).
- The ten static pages repeat the same header, mobile menu and footer; they are audited once in table SH and the per-page tables skip them.
- `home.html` mirrors the wheel strings from `graphics/rf-wheel-up.js` (table WH); change both together.
- D1 to D10 refer to the decisions list at the end.

## SH. Shared frame (header, menu, footer on every page)

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| SH-01 | components/site-frame/site-frame-nav.ts:6-12 | Product, Use cases, For stores, Pricing, Getting started, Company | KEEP | Plain, short nouns | |
| SH-02 | components/site-frame/site-frame-nav.ts:15-21 | Mobile menu adds "What it does and doesn’t do", "Data in and out", "Security and your data", "Questions" | KEEP | Plain; mirrors the footer | |
| SH-03 | components/site-frame/site-frame-nav.ts:24-40 | Footer column "Company" with link "About us" to /company | KEEP | Nav says "Company", footer says "About us" (D4) | |
| SH-04 | components/site-frame/site-frame-nav.ts:44 | `SITE_EMAIL = "hello@routeflow.info"` | KEEP | Second source of the address; `lib/site.ts` has one too | EMAIL |
| SH-05 | components/site-frame/SiteFrame.tsx:45-48 | "RouteFlow" / "We make wholesalers’ lives easier." | KEEP | Owner's slogan; "We" is fine in company voice | NAME |
| SH-06 | components/site-frame/SiteFrame.tsx:66-77 | Account: "Start free trial", "Sign in", "Store sign in" | KEEP | One label per action | |
| SH-07 | components/site-frame/SiteFrame.tsx:83-86 | "© 2026 RouteFlow", "Privacy Policy", "Terms of Service" | KEEP | Year is typed | NAME |
| SH-08 | components/site-frame/SiteFrameHeader.tsx:54,59,102 | aria-label "RouteFlow home", "Main", "Mobile" | KEEP | Clear | NAME |
| SH-09 | SiteFrameHeader.tsx:48,85; js/auth-nav.js:33; js/site.js:38; js/home-up.js:51 | "Open dashboard", "Open menu", "Close menu" | KEEP | Same words in 3 files; consistent | |
| SH-10 | pricing.html:158 (every page footer; contact.html:103) | "RouteFlow We make wholesalers’ lives easier. Email: hello@routeflow.info" | KEEP | Slogan and address repeat on all ten pages | NAME, EMAIL |
| SH-11 | each *.html `<title>` | "Pricing \| RouteFlow", "Product \| RouteFlow", "Contact \| RouteFlow", etc. | KEEP | Page then name; all ten agree | NAME |
| SH-12 | app/layout.tsx:53 and (auth)/signup/layout.tsx:5 | Title template "%s · RouteFlow" (React pages) | "%s \| RouteFlow" | Static pages use "\|", React pages use "·" | NAME |

## PR. pricing.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| PR-01 | pricing.html:6-7,12-13 | "Pricing \| RouteFlow"; "RouteFlow plans from $99 a month. Starter, Growth, Scale, and Enterprise. 14 days free, no card needed. Pay for a year and get 2 months free." | KEEP | Clear; "$99" is typed in the meta lines | NAME, PRICE |
| PR-02 | pricing.html:94 | "Plans from $99 a month. Pay for a year and get 2 months free." | KEEP | Number read from prices.js | PRICE |
| PR-03 | pricing.html:96,98,100 | "For a small wholesaler moving off paper and texts." / "For a wholesaler with many store buyers." / "…with a long list of stores." | KEEP | Plain | |
| PR-04 | pricing.html:97 | "And the rest of what every plan includes" | KEEP | | |
| PR-05 | pricing.html:102 | "Price Custom Based on your size." | "Custom price. Based on your size." | Label and value read as one broken phrase | PRICE |
| PR-06 | pricing.html:103 | "Unlimited customers / A custom price / Email us" | Drop the "A custom price" bullet | Repeats the card's price line | PRICE, EMAIL |
| PR-07 | pricing.html:105-111 | Table "Plan, Customers, From a month, Each year" and rows | KEEP | Read from prices.js | PRICE |
| PR-08 | pricing.html:115 | Bold line: "Every trial starts on Starter, 14 days free. No card needed." | "Every trial starts on Starter and lasts 14 days. No card needed." (same weight as the lines below) | One bold line among three plain ones; wording repeats FAQ | |
| PR-09 | pricing.html:116 | "The plans differ by how many customers and logins they include. Scale and Enterprise also get regulated items at no fee." | KEEP; owner decision (D1) | `prices.js` header says seats are not enforced | CLAIM, PRICE |
| PR-10 | pricing.html:117 | "Includes your team." | Delete | Stray; no subject; logins already in line above | CLAIM |
| PR-11 | pricing.html:118 | "Need more than Scale? Email hello@routeflow.info about Enterprise." | Delete; keep `id="contact"` on the Enterprise card's "Email us" | Enterprise email asked 3 times on this page (103, 118, 149) | EMAIL |
| PR-12 | pricing.html:122 | "Options and add-ons. Some are free to set up. Others may add a monthly fee." | KEEP | Plain | |
| PR-13 | pricing.html:124 | Free to set up: routes and delivery, counter sales, where your orders go, promotions, product varieties | KEEP | Matches home 272, 439 | |
| PR-14 | pricing.html:126 | "Regulated items We turn it on for you. $39 a month on Starter and Growth. No fee on Scale and Enterprise." | KEEP | Price read from prices.js | PRICE, CLAIM |
| PR-15 | pricing.html:127 | "Customer pack 100 more customers. Add more than one. $50 a month" | "Add 100 more customers in each pack. You can add more than one pack." | Names the action; "Add more than one" is vague | PRICE |
| PR-16 | pricing.html:134 | "What every plan includes" list: "…Estimates, recurring invoices…" | "repeat invoices" | Product page and home say "repeat invoices" (D2) | CLAIM |
| PR-17 | pricing.html:137-149 | FAQ: What is RouteFlow? Who is it for? How much does it cost? Do I need a card? Can I bring my data? Can I get my data out? Does it connect? What doesn’t it do? What do drivers and stores need? More questions? | KEEP | Plain, honest answers; same FAQ is on home | NAME, EMAIL, CLAIM |
| PR-18 | pricing.html:141 | "…The plans differ by how many customers and logins they include. Scale and Enterprise also get regulated items at no fee. Pay for a year and get 2 months free." | KEEP (D1) | Same sentence as 116 | CLAIM, PRICE |
| PR-19 | pricing.html:143 | "You can undo a product import for 24 hours, unless a product is already on an order." | KEEP | Clearer than home 501 | CLAIM |
| PR-20 | pricing.html:144 | "…Orders and invoices download as summaries, without line items, up to 1,000 rows at a time." | KEEP | Matches data-in-and-out | CLAIM |
| PR-21 | pricing.html:152 | "Try RouteFlow free. 14 days free. No card needed." | "Try RouteFlow free for 14 days. No card needed." | "free" twice; same closing band on 8 pages | NAME |
| PR-22 | pricing.html:7,13,21 | meta description with typed "$99" | Read the number from prices.js or one brand source | Number written by hand in 3 lines | PRICE |

## HM. home.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| HM-01 | home.html:6-7,12-13 | "RouteFlow \| We make wholesalers’ lives easier"; "Software for businesses that sell to stores. Take orders by the box or the piece, send invoices, record payments, and let your stores order online. 14 days free. No card needed." | KEEP | Name-first title is fine on a home page | NAME |
| HM-02 | home.html:104-106 | "For wholesalers and distributors" / "Sell to stores. Get paid." / "RouteFlow is software for businesses that sell to stores. Take the order, send the bill, and see who paid." | KEEP | Clear; "bill" vs "invoice" is D2 | NAME |
| HM-03 | home.html:108-111 | "Start free trial" / "See what you can do" / "14 days free. No card needed." | "See what it does" for the second link | Company, product, security links say "See what it does" | |
| HM-04 | home.html:114,126,128 | Wheel pieces and captions | see WH | Home repeats the wheel text | NAME |
| HM-05 | home.html:120 | "Try it with your own orders." | KEEP | | |
| HM-06 | home.html:128 | "Each buyer’s price Give one store its own price." | "Each store’s price" | "Buyer" is used nowhere else on the static site | |
| HM-07 | home.html:128 | "Counter sales Select it when you set up your account. No fee. Scan, record the payment, print a receipt." | "Scan, record the payment, print a receipt. Select it when you set up your account. No fee." | Benefit first, condition second | |
| HM-08 | home.html:136-155 | "Orders in texts. Prices in your head. Bills on paper." and the messy-texts mock | KEEP | Sample data; "Mkt", "bx" are on purpose | |
| HM-09 | home.html:163-169 | "The order becomes the invoice. Nobody types it again." and step 1 | KEEP | | |
| HM-10 | home.html:182 | aria "…Send is greyed out: you send it after delivery." | "Send is dimmed" | House style: dimmed; US spelling | |
| HM-11 | home.html:181,191 | "Send it by email after the order is delivered." / "You send it after delivery." | KEEP | Product page says "delivery or shipment" (D3) | CLAIM |
| HM-12 | home.html:195,272,439,509 | "…Select that when you set up your account, and routes and drivers are on, at no added fee. To change it later, email us." | KEEP | Repeated 4 times, consistent with pricing | CLAIM |
| HM-13 | home.html:217-224 | "Record the check. The balance goes to zero, and you see who still owes you." and mock | KEEP | | |
| HM-14 | home.html:285-326 | App mock: "Create Order", "Requested Delivery Date (optional)", "Search by name, SKU or scan barcode…", "Payment History", "Cost of Goods Sold" | KEEP | Mock of real screens; must equal app labels | CLAIM |
| HM-15 | home.html:341-342 | "Sell by the box or the piece." / "Each product has one record. A piece costs its share of the box price." | KEEP | Arithmetic checked: $18 / 12 = $1.50 | CLAIM |
| HM-16 | home.html:377 | Caption "Sparkling water 12-pack, sample prices. Sample prices for one piece." | "Sparkling water 12-pack. Sample prices for one piece." | "Sample prices" twice | |
| HM-17 | home.html:386 | "Each store sees its own prices, your stock, and, after its first order, what it usually reorders. After a store has ordered, one tap adds its low items to the cart." | "Each store sees its own prices and your stock. After its first order, it also sees what it usually reorders, and one tap adds its low items to the cart." | "After" said twice; first sentence too long | CLAIM |
| HM-18 | home.html:394-426 | Buyer portal mock: "Buyer Portal", "Your sellers", "$18.00 per case (12/box)", "Only 4 left" | KEEP | Mock; "case" vs "box" mismatch with the site (D5) | CLAIM |
| HM-19 | home.html:436-439 | "Sell at the counter, too. Scan, record the payment, print a receipt." | KEEP | | |
| HM-20 | home.html:477-479 | "What you can do with RouteFlow. Every trial includes all of these." | KEEP (verify) | Regulated items cost $39; routes and counter need a selection | CLAIM, NAME |
| HM-21 | home.html:482-500 | 19 use-case lines (Take orders … See your numbers) | KEEP | Plain, short, parallel | |
| HM-22 | home.html:495 | "Send estimates and repeat invoices" | KEEP | The wording other pages should match | |
| HM-23 | home.html:501 | "Import your products from a CSV file. You can undo the import for 24 hours, unless a product is already on an order." | "…You can undo a product import for 24 hours, unless…" | Only the product import can be undone (data-in-and-out:110) | CLAIM |
| HM-24 | home.html:504-507 | Use-case illustration cards (purchases, supplier bills, returns, reports) | KEEP | Labelled sample data | |
| HM-25 | home.html:520-525 | Founder letter summary: "We built this with the people who use it every day… starting with my co-founder’s father… We’ll customize it for your business at no cost." | KEEP | First person is right for a founder letter | NAME, CLAIM |
| HM-26 | home.html:528-536 | The full letter, word for word the same as company.html:98-106 | Link to /company, or keep one copy | Same 9 paragraphs on two pages (D6) | NAME, EMAIL, CLAIM |
| HM-27 | home.html:535 | "I want to be honest with you. RouteFlow is still new." | "RouteFlow is still new." | "I want to be honest" is filler | NAME |
| HM-28 | home.html:533 | "When a line has 2 boxes and 3 pieces, the bill adds up right." | KEEP | Verify against the pricing tests | CLAIM |
| HM-29 | home.html:539 | Signature "Dr. Najath Akram, Co-founder" | KEEP | A real person (the founder), not a customer | |
| HM-30 | home.html:545-573 | Pricing teaser: plans, taglines, "Every plan includes … Your team", "The plans differ by how many customers and logins…" | KEEP (D1 for the "logins" line) | Mirrors pricing.html; list differs (D7) | PRICE, CLAIM |
| HM-31 | home.html:556 | "…Orders, invoices, estimates, and recurring invoices … Your team" | "repeat invoices"; delete "Your team" | Matches PR-16 and PR-10 | CLAIM |
| HM-32 | home.html:579-589 | FAQ (same as pricing.html:137-149) | KEEP | Full repeat of the pricing FAQ | NAME, EMAIL, CLAIM, PRICE |
| HM-33 | home.html:591,600 | "More questions? Email hello@routeflow.info." and "Questions? Email hello@routeflow.info." | Keep 591, delete 600 | Same ask 9 lines apart | EMAIL |
| HM-34 | home.html:598 | "Try RouteFlow free." | KEEP | | NAME |
| HM-35 | home.html:278,330,390,442 | aria-labels and captions for app mocks ("An order in RouteFlow", "…with sample data") | KEEP | Describe what a person sees | NAME |

## LD. landing.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| LD-01 | landing.html:6-7,12-13 | "RouteFlow \| Software for wholesalers and distributors"; "Take orders, send bills, and get paid in one system. For wholesalers and distributors who sell to stores. 14 days free. No card needed." | KEEP | Clear; three product descriptions across the site (D8) | NAME |
| LD-02 | landing.html:38-39 | "Software for businesses that sell to stores. Take orders. Send bills. Get paid." / "Start free trial 14 days free. No card needed." | KEEP | | |
| LD-03 | landing.html:41,46-52 | aria and the five "What you do with RouteFlow" lines | KEEP | Plain; "bill" vs "invoice" is D2 | NAME |
| LD-04 | landing.html:57 | "From $99 a month. First 14 days free." | "From $99 a month. 14 days free." | Other pages say "14 days free" | PRICE |
| LD-05 | landing.html:58 | "Up to 100 customers. Up to 250: $249. Up to 500: $499. No card needed." | "Up to 100 customers. Up to 250 customers: $249. Up to 500 customers: $499. No card needed." | Elliptical; elsewhere "100 customers included"; prices typed | PRICE |
| LD-06 | landing.html:59,62 | "Start free trial" | KEEP | | |
| LD-07 | landing.html:65 | "© 2026 RouteFlow hello@routeflow.info Privacy Policy Terms of Service" | KEEP | Different footer from the other pages | NAME, EMAIL |

## PD. product.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| PD-01 | product.html:6-7,12-13 | "Product \| RouteFlow"; "What RouteFlow does for businesses that sell to stores: orders, bills, payments, stock, delivery, and counter sales. 14 days free, no card needed." | KEEP | "Bills" here means invoices (D2) | NAME |
| PD-02 | product.html:79-85 | "What RouteFlow does." / "RouteFlow is software for businesses that sell to stores. A store orders. You deliver it or hand it over. You send the bill. You get paid." / "See what it does" | KEEP | Clear | NAME |
| PD-03 | product.html:87-101 | Loop aria and four steps | KEEP | | NAME |
| PD-04 | product.html:108-117 | "The main things you can do." and 8 cards (Sell … Sell regulated items) | KEEP | Same 8 lines on does-and-doesnt.html:104-111 (D6) | CLAIM |
| PD-05 | product.html:124-132 | "How do orders reach your customers? We ask this one question when you set up your account. Select one or more." and three options | KEEP | "customers" here, "stores" elsewhere (D9) | CLAIM |
| PD-06 | product.html:139 | "Most of it is on when you start. If something needs a selection or a fee, it says so." | KEEP | | CLAIM |
| PD-07 | product.html:143-152 | Sell: take orders, repeat orders, box or piece, price levels, store’s own price, last price, promotions, estimates | KEEP | | |
| PD-08 | product.html:154-160,172-177,218-223,252-258 | Illustration aria-labels and sample rows | KEEP | | |
| PD-09 | product.html:165-170 | Let stores order: "Store ordering … It’s free for the store." | KEEP | | CLAIM |
| PD-10 | product.html:182-197 | Get paid list (invoices, payments, returns, credit notes, repeat invoices, credit limits, who’s late, statements, reminders, checks, part payments, advances, sales tax, tax-exempt) | KEEP | | CLAIM |
| PD-11 | product.html:189 | "Set a limit for each store. RouteFlow stops a change to an order that takes the store over it." | "Set a limit for each store. RouteFlow blocks an order change that would take the store over it." | Clearer | NAME, CLAIM |
| PD-12 | product.html:193 | "…If a check bounces, the payment is voided and the invoice opens again. For a post-dated check, enter the day the money reaches your bank." | KEEP | | CLAIM |
| PD-13 | product.html:185 | "Record cash, check, ACH, card, Zelle, credit, or an advance. … Recording a payment doesn’t move any money." | KEEP | Plain and honest | CLAIM |
| PD-14 | product.html:209-216 | Buy and keep stock | KEEP | | |
| PD-15 | product.html:228-236 | Deliver; "Finishing a stop …"; "Three limits." | KEEP | Long block of short sentences | CLAIM |
| PD-16 | product.html:240-250 | Counter sales; See your numbers | KEEP | | |
| PD-17 | product.html:263-267 | Regulated items: "RouteFlow keeps a ledger, prepares filings, and gives you compliance reports. … $39 a month on Starter and Growth." | KEEP | Compliance claim needs a check | NAME, CLAIM, PRICE |
| PD-18 | product.html:199 | aria "Send is greyed out, because you send it after delivery or shipment." | "Send is dimmed" | House style: dimmed | |
| PD-19 | product.html:275-284 | "Who uses it. There are four kinds of login. Each one reaches different things." and roles | KEEP | Same text as security.html:116-125 | CLAIM |
| PD-20 | product.html:290-291 | "What changes as you add customers. The plans differ by how many customers and logins they include." | KEEP (D1) | Same claim as pricing 116 | CLAIM |
| PD-21 | product.html:300-303 | "Over your limit. You get 7 days…" / "More customers. Add 100 more customers for $50 a month…" / "Smaller plan… logins over its limit can be turned off." | KEEP | | CLAIM, PRICE |
| PD-22 | product.html:310-325 | "The details", "What happens to an order?" table | KEEP | | CLAIM |
| PD-23 | product.html:332-335 | "What can a driver do?" can / can’t | KEEP | | CLAIM |
| PD-24 | product.html:339-342 | "Each product has one count. Cost is a weighted average by default. You can switch to last cost." | KEEP | Said 3 times across 2 pages | CLAIM |
| PD-25 | product.html:345-362 | "Where does it stop?" / "Where are the books?" | KEEP | Same as does-and-doesnt.html:144-146 | CLAIM |
| PD-26 | product.html:366 | "Both the screen and the server check the login’s role." | KEEP | Security page says it differently (SC-12) | CLAIM |
| PD-27 | product.html:370-375 | "Who is it best for?" 4 lines | KEEP | | |
| PD-28 | product.html:391 | "Try RouteFlow free. 14 days free. No card needed." | As PR-21 | "free" twice | NAME |

## CO. company.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| CO-01 | company.html:6-7,12-13 | "Company \| RouteFlow"; "We make wholesalers’ lives easier. Why we built RouteFlow, and who to write to." | KEEP | | NAME |
| CO-02 | company.html:82-86 | "We make wholesalers’ lives easier." / "RouteFlow helps a business that sells to stores take orders, send bills, get paid, keep stock, and deliver." | KEEP | | NAME |
| CO-03 | company.html:98-106 | The letter (9 paragraphs; see HM-25 to HM-29) | Line 105: cut "I want to be honest with you." | Filler | NAME, EMAIL, CLAIM |
| CO-04 | company.html:104,105,106,113 | "…at no cost." / "…our first customers get setup help from us by email." / "We reply within one business day." | KEEP | Promises someone must confirm are true today | CLAIM |
| CO-05 | company.html:107 | Signature "Dr. Najath Akram, Co-founder" | KEEP | Real person, not a customer | |
| CO-06 | company.html:112-116 | "Have a question? Email us. We reply within one business day. hello@routeflow.info Contact us" | KEEP | | EMAIL, CLAIM |

## CT. contact.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| CT-01 | contact.html:6-7,12-13 | "Contact \| RouteFlow"; "Write to hello@routeflow.info and we reply within one business day." | KEEP | | NAME, EMAIL, CLAIM |
| CT-02 | contact.html:82-83 | "Email us." / "Write to us. Tell us your business name and what you need. We reply within one business day." | "Tell us your business name and what you need. We reply within one business day." | "Write to us" repeats the heading | CLAIM |
| CT-03 | contact.html:85 | hello@routeflow.info | KEEP | | EMAIL |
| CT-04 | contact.html:95-96 | "New here Try RouteFlow free for 14 days. No card needed." / "A question first Ask us anything about what RouteFlow does or costs. Email us" | KEEP | | NAME |
| CT-05 | contact.html:97 | "You order from a seller. If your seller uses RouteFlow, sign in to see your orders and bills. Sign in as a store" | Link: "Store sign in" | Footer calls it "Store sign in" | NAME |

## DI. data-in-and-out.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| DI-01 | data-in-and-out.html:6-7,12-13 | "Data in and out \| RouteFlow"; "How data moves in and out of RouteFlow: CSV files in, CSV files out, what you can download, and what you can’t. There is no API." | KEEP | | NAME, CLAIM |
| DI-02 | data-in-and-out.html:83-84 | "Your data, in and out. RouteFlow moves data with CSV files. It has no API. Below is exactly what you can bring in and take out." | "…Below is what you can bring in and take out." | "exactly" is an unsupported intensifier | NAME, CLAIM |
| DI-03 | data-in-and-out.html:91-96 | Diagram aria and labels "CSV files in", "RouteFlow Your orders, bills, and stock", "CSV files out" | KEEP | | NAME |
| DI-04 | data-in-and-out.html:103-111 | "You import CSV files yourself. Only admins can." / what you can import / preview / invoice numbers | KEEP | Preview paragraph repeats getting-started 156 | CLAIM |
| DI-05 | data-in-and-out.html:110 | "Check the preview. An import from this screen can’t be undone after you run it. A product import through Migration can be undone for 24 hours…" | "…An import from [name the import screen] can’t be undone…" | "this screen" and "Migration" have no referent on a web page | CLAIM |
| DI-06 | data-in-and-out.html:124-135 | "What can I download?" table | KEEP | | CLAIM |
| DI-07 | data-in-and-out.html:134 | "One invoice A PDF. You download them one at a time." | "Each invoice A PDF. You download each one at a time." | Singular label, plural "them" | |
| DI-08 | data-in-and-out.html:142-152 | "What can’t I download in bulk?" and the 7-item list | KEEP | | CLAIM |
| DI-09 | data-in-and-out.html:155-157 | "What if I leave? Cancel from your account. Only admins can. It takes effect at the end of the billing period." | KEEP | | CLAIM |
| DI-10 | data-in-and-out.html:160-172 | "What does it connect to?" / "Is there an API?" | KEEP | Same "no API" list on does-and-doesnt:137, security:169 | CLAIM |
| DI-11 | data-in-and-out.html:183 | "Try RouteFlow free. 14 days free. No card needed." | As PR-21 | "free" twice | NAME |

## DD. does-and-doesnt.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| DD-01 | does-and-doesnt.html:6-7,12-13 | "What it does and doesn’t do \| RouteFlow"; "…It runs the selling side, from order to payment, and doesn’t keep your books." | KEEP | | NAME, CLAIM |
| DD-02 | does-and-doesnt.html:82-96 | "Where RouteFlow stops." / "RouteFlow runs the selling side… It doesn’t keep your books." / diagram | KEEP | | NAME, CLAIM |
| DD-03 | does-and-doesnt.html:102-111 | "What it does." 8 lines | KEEP | Same 8 lines as product.html:110-117 | |
| DD-04 | does-and-doesnt.html:119-136 | "What it doesn’t do" and the 10-row table | KEEP | | CLAIM |
| DD-05 | does-and-doesnt.html:137 | "Two-step login, company single sign-on, an API, or webhooks you set up … You sign in with a password or a Google account." | KEEP | | CLAIM |
| DD-06 | does-and-doesnt.html:144-165 | "Where are the books?", "How does data move?", "How is stock kept?", "When is it the wrong choice?" | KEEP | Repeats product.html:339-362 | CLAIM |
| DD-07 | does-and-doesnt.html:174-180 | "A spreadsheet, a big business system, or this. This is how we see the three. It’s our own view, not research." | KEEP | Honest; "big business system" is vague but plain | CLAIM |
| DD-08 | does-and-doesnt.html:187-194 | "Words we use." glossary: Regulated items, Price level, Box and piece, Workspace ID | KEEP | The site's own term source | |
| DD-09 | does-and-doesnt.html:204 | "Try RouteFlow free. 14 days free. No card needed." | As PR-21 | "free" twice | NAME |

## GS. getting-started.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| GS-01 | getting-started.html:6-7,12-13 | "Getting started \| RouteFlow"; "How the free trial works: sign up, answer one question, add your products and customers, and take your first order. 14 days free, no card needed." | KEEP | | NAME |
| GS-02 | getting-started.html:83-90 | "Start in five steps." / "Sign up, answer one question…" / "See the five steps" | KEEP | | |
| GS-03 | getting-started.html:97 | Sign-up form mock: "Password 8+ characters, mixed case, a number or symbol" | "At least 8 characters" | A third wording of the rule; must match the real field (SU-13) | |
| GS-04 | getting-started.html:98 | Mock username "acme_distribution_admin" | KEEP | Real placeholder is "acme_admin"; minor | |
| GS-05 | getting-started.html:106-130 | The five steps | KEEP | | CLAIM |
| GS-06 | getting-started.html:116 | "We email you a link. It works for 24 hours." | KEEP | | CLAIM |
| GS-07 | getting-started.html:138-145 | "What you need." 4 items | KEEP | | |
| GS-08 | getting-started.html:152-159 | "Bring your data in… The first customers also get personal setup help by email from the founders." | KEEP | Preview text repeats data-in-and-out:109 | CLAIM |
| GS-09 | getting-started.html:166-175 | "Your 14 days." timeline; "The account can go read-only…" | KEEP | "can go" is a hedge; repeated at 207 | CLAIM |
| GS-10 | getting-started.html:182-190 | "Getting your people on." staff, drivers, stores | KEEP | | CLAIM |
| GS-11 | getting-started.html:196-219 | FAQ: trial length, no plan, change answer, who sets it up, help | KEEP | 203, 207 repeat 167-175 | CLAIM, EMAIL |
| GS-12 | getting-started.html:230 | "Try RouteFlow free. 14 days free. No card needed." | As PR-21 | "free" twice | NAME |
| GS-13 | getting-started.html:115 | "Click the link in your email" (step 2 heading) | "Open the link in your email" | R11 (no "click"), SA-1203 A3 1b; applied mechanically, no change of meaning or claim; cleared by the lead 2026-11-21 ~03:10Z | |
| GS-14 | getting-started.html:116 | "We email you a link. It works for 24 hours. Click it, and your account opens on your dashboard." | "We email you a link. It works for 24 hours. Open it to go to your dashboard." | R11 (no "click"), SA-1203 A3 1b; same claim (24 hours, dashboard); cleared by the lead 2026-11-21 ~03:10Z | CLAIM |

## SC. security.html

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| SC-01 | security.html:6-7,12-13 | "Security and your data \| RouteFlow"; "Who can see your data in RouteFlow, what we do to protect it, and what we don’t have yet. A short, plain page for people who have to ask." | KEEP | | NAME, CLAIM |
| SC-02 | security.html:82-96 | "Who can see your data. We’re a small, new service. This page says what we do, and what we don’t have." / diagram | KEEP | | |
| SC-03 | security.html:103-109 | "What we do. Three things, in plain words." | KEEP | | |
| SC-04 | security.html:107 | "Each business’s data is kept apart. Our app checks the business whenever it reads or writes your data. The check is in the app. It isn’t also enforced inside the database." | KEEP (owner check) | Security statement; may be out of date | CLAIM |
| SC-05 | security.html:108 | "Passwords are stored as hashes, not as plain text. Ten wrong tries lock a login for 15 minutes. You can see your sign-ins and end them." | KEEP (owner check) | Numbers must match the code | CLAIM |
| SC-06 | security.html:109 | "Photos and files open through private links that expire." | KEEP (owner check) | | CLAIM |
| SC-07 | security.html:116-124 | "Who can do what." four logins | KEEP | Same text as product.html:275-284 | CLAIM |
| SC-08 | security.html:131-138 | "Who at RouteFlow can see your data." support sign-in: 15 minutes; can change data; can’t change billing; recorded | KEEP (owner check) | | NAME, CLAIM |
| SC-09 | security.html:145-169 | "What you can check, and what we don’t have." | KEEP | | CLAIM |
| SC-10 | security.html:161-162 | "We record changes, with who made them and when. Only RouteFlow staff can read that record. You can’t read it yet." | KEEP | | NAME, CLAIM |
| SC-11 | security.html:173-178 | "Who helps you run RouteFlow? … in our Privacy Policy." / "Found a problem? Email hello@routeflow.info and say it’s about security." | KEEP | Privacy page lists security@routeflow.info instead (LG-07) | NAME, EMAIL, LEGAL |
| SC-12 | security.html:125 | "Access goes by role. You can’t set it for one person. The server checks the role too, as well as the screen." | "…The server checks the role as well as the screen." | "too, as well as" says it twice | CLAIM |
| SC-13 | security.html:189 | "Try RouteFlow free. 14 days free. No card needed." | As PR-21 | "free" twice | NAME |

## WH. graphics/rf-wheel-up.js (also mirrored in home.html:114,126,128)

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| WH-01 | rf-wheel-up.js:15 | "If you deliver" | KEEP | | |
| WH-02 | rf-wheel-up.js:21-30 | Ten outer pieces: Purchases, Supplier bills, Inventory, Orders, Routes, Delivery, Invoices, Payments, Customers, Reports, each with one sentence | KEEP | Plain, short | |
| WH-03 | rf-wheel-up.js:22 | "Supplier bills / See what you owe." | KEEP | "Bills" here means what you owe; elsewhere what you send (D2) | |
| WH-04 | rf-wheel-up.js:34 | "Each buyer’s price / Give one store its own price." | "Each store’s price" | Same as HM-06 | |
| WH-05 | rf-wheel-up.js:36 | "Counter sales / Select it when you set up your account. No fee. Scan, record the payment, print a receipt." | "Scan, record the payment, print a receipt. Select it when you set up your account. No fee." | Same as HM-07 | |
| WH-06 | rf-wheel-up.js:33,35,37 | Box or piece / Store ordering / Returns, with their lines | KEEP | | |
| WH-07 | rf-wheel-up.js:43 | "Your daily work" / "How you sell" | KEEP | | |
| WH-08 | rf-wheel-up.js:44 | "Scroll to look inside" | KEEP | | |
| WH-09 | rf-wheel-up.js:46 | "Look inside." / "Buy, sell, get paid. Then buy again." | KEEP | | |
| WH-10 | rf-wheel-up.js:47 | "One system." / "Every step is in RouteFlow." | KEEP | | NAME |
| WH-11 | rf-wheel-up.js:86 | aria "The RouteFlow wheel: purchases, supplier bills, … all one system." | KEEP | | NAME |
| WH-12 | rf-wheel-up.js:135 | aria "The RouteFlow wheel. Use the arrow keys to look at each piece. Press Enter to go to it." | KEEP | | NAME |
| WH-13 | rf-wheel-up.js:95 | "Stock Value (cost)" | "Stock value (cost)" | Title case then lowercase in one label; other card rows are sentence case; confirm the app label | |
| WH-14 | rf-wheel-up.js:94-96 | Card rows: "Confirmed", "2 boxes + 6 pcs", "In stock", "boxes", "Paid", "Payments received", "Balance due" | KEEP | Sample data; "pcs" vs "pieces" in text (D5) | |
| WH-15 | rf-wheel-up.js:133 | Stop heading and sub from the pieces above | KEEP | | |

## JS. Other scripts that reach the screen

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| JS-01 | js/prices.js:12-24 | Plan names Starter, Growth, Scale; add-ons "Regulated items", "Customer pack"; prices 99, 249, 499, 39, 50 | KEEP | The one price source; pages should read it | PRICE |
| JS-02 | js/auth-nav.js:33 | "Open dashboard" | KEEP | Same as SiteFrameHeader.tsx:48 | |
| JS-03 | js/site.js:38, js/home-up.js:51 | "Close menu" / "Open menu" | KEEP | | |
| JS-04 | js/product.js | No visible strings | KEEP | | |

## FR. Frame and metadata in React (apps/web/app/(marketing)/lib/site.ts, lib/metadata.ts)

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| FR-01 | lib/site.ts:13-16 | `site = { name: "RouteFlow", origin: "https://www.routeflow.info", email: "hello@routeflow.info" }` | KEEP | The one brand-source candidate; `site-frame-nav.ts:44` copies the email | NAME, HOST, EMAIL |
| FR-02 | lib/site.ts:20 | `DEMO_CTA = "Book a video call"` | Delete (no importer found) | The site has no video-call button | |
| FR-03 | lib/site.ts:34-72 | `routes` titles and descriptions (product, pricing with typed "$99", company, contact, privacy, terms) | KEEP | Copied by hand from the static pages; can drift | NAME, EMAIL, PRICE |
| FR-04 | lib/site.ts:96-129 | `PLANS`: "Get your workflow organized", "Connect your delivery operation", "Discuss a broader rollout", "Review multiple locations" | Delete (no importer found) | Contradicts the live plans | CLAIM |
| FR-05 | lib/site.ts:139-147 | `demoEmail`: "Hello RouteFlow, I’d like a demo for…"; subject "RouteFlow demo request" | Delete (no importer found) | Site says "trial", not "demo" | NAME, EMAIL |
| FR-06 | lib/metadata.ts:9-12 | Share image: "RouteFlow" / "Wholesale software for orders and delivery." | "Software for businesses that sell to stores." | Home meta says this (D8) | NAME |
| FR-07 | opengraph-image/route.tsx | Draws the two lines from metadata.ts | KEEP | | NAME |

## SU. Sign-up page (apps/web/app/(auth)/signup/page.tsx and layout.tsx)

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| SU-01 | signup/layout.tsx:7 | Tab title "Start your free trial" | "Start free trial" | Every link on the site says this | |
| SU-02 | signup/page.tsx:263-265 | Kicker "Distributor account"; title "Try it free for 14 days."; lead "No card needed." | KEEP | Clear; "distributor" vs "wholesaler" is D8 | |
| SU-03 | signup/page.tsx:268-278 | "Already have an account? Sign in" / "Buying from a distributor? Create a retailer account" | "Ordering from a wholesaler? Create a store account" | Site says store, not retailer | |
| SU-04 | signup/page.tsx:17 | "Business name must be at least 2 characters" | "Use at least 2 characters." | Other errors say "Use at least 3 characters." | |
| SU-05 | signup/page.tsx:20-25 | "Use at least 3 characters." / "Use 30 characters or fewer." / "Only lowercase letters, numbers, and hyphens — must start with a letter or number" | Last: "Use small letters, numbers, and dashes. Start with a letter or number." | Hint says "small letters" and "dashes"; error says "lowercase" and "hyphens" | |
| SU-06 | signup/page.tsx:29-31 | "Username must be at least 3 characters" / "…30 characters or less" / "Only letters, numbers, and underscores" | "Use at least 3 characters." / "Use 30 characters or fewer." / "Use letters, numbers, and underscores." | Same voice as the slug errors | |
| SU-07 | signup/page.tsx:26 | "Enter a valid email address" | KEEP | | |
| SU-08 | signup/page.tsx:299-325 | Label "Workspace ID"; hint "A short name for your business. You’ll type it every time you sign in. Use small letters, numbers, and dashes (-)."; "This workspace ID is already taken." / "…is available." | KEEP | The hint is the model wording | |
| SU-09 | signup/page.tsx:290-349 | Placeholders "Acme Distribution Co.", "acme-distribution", "you@acme.com", "acme_admin" | KEEP | Sample names | |
| SU-10 | signup/page.tsx:361-362 | "This username is reserved. Please choose a different one." | "This username is reserved. Choose a different one." | "Please" is filler | |
| SU-11 | signup/page.tsx:365-367 | "This username is available." / "Letters, numbers, and underscores only." | KEEP | | |
| SU-12 | signup/page.tsx:371-381 | "Username: …" "Change" | KEEP | | |
| SU-13 | signup/page.tsx:396 | Password placeholder "At least 8 characters" | Remove the placeholder | The rule is stated again 20 lines later (SU-14) | |
| SU-14 | signup/page.tsx:415-416 | "Use 8 or more characters, with a capital letter, a small letter, and a number or symbol." | "Use at least 8 characters, with a capital letter, a small letter, and a number or symbol." | One rule in one place, same words as the error at line 38 | |
| SU-15 | signup/page.tsx:36-41 | "Use at least 8 characters." / "Add a capital letter." / "Add a small letter." / "Add a number or symbol." | KEEP | | |
| SU-16 | signup/page.tsx:406 | aria "Hide password" / "Show password" | KEEP | | |
| SU-17 | signup/page.tsx:426 | Button "Create account" | KEEP | Names the outcome; site links say "Start free trial" (D10) | |
| SU-18 | signup/page.tsx:430-441 | "By signing up you agree to our Terms of Service and Privacy Policy." | KEEP | Consent wording | LEGAL |

## LG. Privacy and Terms (legal: flag only, no proposals)

| id | file:line | current | proposed | reason | flags |
|---|---|---|---|---|---|
| LG-01 | (marketing)/privacy/page.tsx:24-25,31-32 | Title and description from `routes`; kicker "RouteFlow"; h1 "Privacy Policy" | KEEP | Legal | LEGAL, NAME |
| LG-02 | (marketing)/privacy/page.tsx:47-62 | Definitions "RouteFlow (“RouteFlow,” “we,” “us,” or “our”)", scope with "(routeflow.info)" typed | KEEP | Legal | LEGAL, NAME, HOST |
| LG-03 | (marketing)/privacy/page.tsx:69 | Legal entity and street address | KEEP | Legal | LEGAL, NAME |
| LG-04 | (marketing)/privacy/page.tsx:71,76,137,229 | `site.email`, `site.origin` | KEEP | Already read from lib/site.ts | LEGAL, EMAIL, HOST |
| LG-05 | privacy/page.tsx:74,138,230; terms/page.tsx:89,389 | "security@routeflow.info" typed | KEEP | A second address typed in 5 places | LEGAL, EMAIL |
| LG-06 | (marketing)/privacy/page.tsx:143,158-290 | Body: 53 uses of the name; "routeflow.info" typed at 143 | KEEP | Legal | LEGAL, NAME, HOST |
| LG-07 | privacy/page.tsx:74 and security.html:178 | Privacy gives security@; the security page says write to hello@ | Flag for owner | Two addresses for one purpose | EMAIL, LEGAL |
| LG-08 | (marketing)/terms/page.tsx:33-34,54-56 | Kicker, h1 "Terms of Service", "Routeflow Solutions LLC, a Wyoming limited liability company (“RouteFlow,”…" | KEEP | Entity written "Routeflow"; service "RouteFlow" | LEGAL, NAME |
| LG-09 | (marketing)/terms/page.tsx:115 | `{site.origin without https}/pricing` | KEEP | Derived from lib/site.ts | LEGAL, HOST |
| LG-10 | (marketing)/terms/page.tsx:144 | Link to github.com/najathakram/routeflow SECURITY.md | Flag for owner | Repo is private outside CI windows; link may fail | LEGAL, HOST, CLAIM |
| LG-11 | (marketing)/terms/page.tsx:234-245 | Sub-processor sentence incl. a mail fallback and Google Calendar | KEEP | Verify it still matches what runs | LEGAL, CLAIM |
| LG-12 | (marketing)/terms/page.tsx:397 | "Return to RouteFlow" | KEEP | | LEGAL, NAME |

## Design rows (R17, copper)

Used here because the UX ledger (ux-ledger-p12-p16.md) holds P-rows for layout defects, not colour rulings. Each row turns a copper use ink, citing R17 (copper only in its listed jobs) and SA-1203 A3 and A4.

| ID | Where | Was | Now | Why |
|---|---|---|---|---|
| DS-01 | css/mobile.css:36 `.home .hx-up .hx-over` (decorative rings) | two copper strokes | ink strokes | R17 has no decorative job (SA-1203 A4 2) |
| DS-02 | css/home.css:252 `.st-note` (second note, stores section) | copper | ink (`--rf-text`) | R17 allows exactly one problem-section note (SA-1203 A4 2) |
| DS-03 | css/home.css `.c-chg b` (change amount; the stock marks were already ink) | copper | ink (`--rf-text`) | the change amount is plain text in the app, not a copper job (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-04 | css/home-color.css:52 `.uc-t h3::before` and :83 `.inc-ic` hover tile (use-case dot and tile) | copper | ink | not the eyebrow dot, no R17 job (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-05 | css/home-up.css `#founder .kick`, css/home.css `.st .kick`, css/site.css `.eyebrow,.kick` (label text) | copper | ink, or on-panel on dark bands; the dot stays copper | eyebrow label text is not the dot (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-06 | css/home.css `.inc-plus`, css/site.css `.faq summary .ico` and `.pcard.featured .checks .ico` | copper | ink, or on-panel on the featured card | icons and check marks have no R17 job (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-07 | graphics/rf-wheel-up.css:26 `.rfw-hint` | copper | `--rf-text-2` | hint text has no R17 job (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-08 | `--rf-focus` (rf-graphics.css contract block, landing.html token block, `.pb`, `.end`, `.price`) | copper | `--rf-text` at the root, `--rf-on-panel` on the dark panels | one token change for the focus ring; contrast is measured later in the slot (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-09 | `--rf-box-front`, `--rf-box-side` (box art), home.html truck inline fills, landing `.f-box` `.f-flap` | copper-tinted | kraft #9A8260 and #6E5A40; no box value equals a copper token value (pinned) | box and truck art have no R17 job (R17, SA-1203 A5; lead clearance, lead, 2026-11-21, after 03:31Z) |
| DS-10 | graphics/rf-graphics.css:42 `--rf-skin-b`, `--rf-skin-c` (unused skin tones) | typed tones with a copper hue, no reader | deleted with their allow-list rows (7c8634b3c9) | no reader anywhere; F39 (R17, SA-1203 A6 3; lead clearance, lead, 2026-11-21) |
| DS-11 | every rule that paints `var(--rf-panel)` (12 selectors, 13 rule bodies: .band-ink, .pcard.featured, .cta-band, .risk, .site-header.on-dark, .pd-deep in two files, #founder .fd-in, landing .carry, .co-mono, .pb-b--me, .jr-n, .fd-mono) | ink focus ring on an ink panel (1:1) | `--rf-focus:var(--rf-on-panel)` in the same rule body; pinned for any new panel | the ring must reach 3:1 on every dark band (R17, SA-1203 A5, A10; lead clearance, lead, 2026-11-21) |
| DS-12 | pictures of the app on the site (the 15 rows tagged SA-1203 A9 and A16 in site-repaint-1a.static.test.ts: 10 uses inside figures, 5 copper aliases) | internal only | Pictures of the app use the brand colours by owner ruling 2026-11-21 (SA-1203 A9, A15); the app's own colours differ until its rebrand | owner chose brand colours, copper too, knowing the gap; a colour is not a feature, so no notice on the site (R17, SA-1203 A9, A15, A16) |
| LATER-01 | App colour parity with the brand (Program B) | LATER | App colours follow the brand; DS-12 is removed when this ships | source: the owner's "and its branding" and the bridge ruling; copper text on white is about 4.2:1, so app buttons use copper-dark (about 6.3:1), measured in the slot; a business that set its own colour keeps it (SA-1203 A9) |
| LATER-02 | Move the three hand-written CSS rule readers onto the shared reader (SA-1203 A20 R9) | LATER | site-home-w3, site-landing-seam and site-w2-css read site-css-rules.ts; the inventory pin goes from 3 to 0 | they do not carry the copper guards, and moving them would grow the diff past one PR (SA-1203 A20 R9) |

## Counts

- Rows: 218 (GS-13, GS-14 added). Changes proposed: 55. KEEP: 160. Flag-only or pointer rows (no proposal): 3 (HM-04, LG-07, LG-10).
- Rows by flag (all rows / rows with a proposed change): NAME 62 / 15, EMAIL 21 / 6, PRICE 18 / 6, CLAIM 78 / 14, HOST 6 / 0, LEGAL 14 / 0.
- Name census (count of "RouteFlow" / "routeflow.info" / "hello@routeflow.info" per file): home.html 31/25/15; company 18/10/6; product 21/8/4; does-and-doesnt 24/6/2; data-in-and-out 17/7/3; pricing 16/12/8; security 16/8/4; contact 12/12/8; getting-started 10/10/6; landing 8/6/2; privacy page 56/13/0; terms page 26/4/0. The "routeflow.info" counts include canonical, og:url and sitemap links; the mailto links inside `lib/site.ts` and the `SITE_EMAIL` copy in `site-frame-nav.ts` are the only two code sources. Most address text on the static pages is typed, not read from a source.
- Typed prices (PRICE, typed instead of read from `js/prices.js`): `pricing.html:7,13,21` ("$99"); `landing.html:57-58` ("$99", "$249", "$499"); `lib/site.ts:44` (pricing meta "$99"). Everything else on pricing, home and product is read from `prices.js` through `data-plan` and `data-addon` spans. "14 days" is typed 44 times in the static pages while `prices.js` holds `trialDays: 14`.

## Decisions for the owner

- D1. "The plans differ by how many customers and logins they include" (`pricing.html:116,141`, `home.html:570,583`, `product.html:291`, `product.html:303`). The header comment in `js/prices.js` (SA-1080, 2026-11-01) says plans differ by price and customers only and that seats are "not enforced". The two disagree. Nothing proposed.
- D2. "Bill" vs "invoice" vs "recurring/repeat invoice". Hero, product, company and landing copy say "send the bill"; home use cases, FAQ and pricing say "invoice"; "bill" is also what you owe a supplier (Supplier bills, wheel and use cases). Proposal if approved: write "invoice" for what you send, keep "supplier bill" for what you owe, and use "repeat invoice" everywhere (PR-16, HM-31).
- D3. "after delivery" (home, wheel) vs "after delivery or shipment" (product 199, 203). Pick one; verify against the invoice-lock rule.
- D4. Footer link "About us" vs nav "Company". Pick one name for the page.
- D5. Units: "box" vs "case" (buyer portal mock `$18.00 per case (12/box)`), and "pc/pcs" in mocks vs "piece(s)" in text. The mock comes from the app; fixing it means changing the app.
- D6. Duplicated blocks: the founder letter on `home.html:528-536` and `company.html:98-106` (9 paragraphs, same words); the 8 "main things" on `product.html:110-117` and `does-and-doesnt.html:104-111`; four logins on `product.html:275-284` and `security.html:116-125`; the FAQ on `home.html` and `pricing.html`. Decide which page owns each.
- D7. "What every plan includes" differs between `pricing.html:134` and `home.html:556` (order, grouping, and "Your team" only on home).
- D8. The product is described three ways: "Software for businesses that sell to stores" (home, product, share text on home), "Software for wholesalers and distributors" (landing), and "Wholesale software for orders and delivery" (share image, `lib/metadata.ts:11`). Sign-up says "Distributor account". Pick one line (FR-06 proposes the first).
- D9. Customer words: store, buyer ("Each buyer’s price", "Buyer Portal"), retailer ("retailer account"), seller ("your seller"), customer ("How do orders reach your customers?"). Proposed: "store" for people who order, "wholesaler" for the seller; leave the app mock "Buyer Portal" until the app changes.
- D10. Call to action: "Start free trial" (site), "Start your free trial" (sign-up tab title), "Try it free for 14 days." (sign-up h1), "Create account" (sign-up button), "Try RouteFlow free" (closing bands). SU-01 and PR-21 align the first and last; the button can stay.
- D11. Dead copy in `lib/site.ts`: `DEMO_CTA`, `PLANS` and `demoEmail` have no importer in `apps/web` outside their own file (checked with a grep for the three names). `PLANS` names features that no plan has. Delete in WP1.3b, or confirm they are used.
- D12. "Every trial includes all of these" (`home.html:479`) while regulated items cost $39 and routes and counter sales need a selection. CLAIM; verify.
- D13. Security text (SC-04 to SC-10), "We reply within one business day" (5 places), "We’ll customize it for your business at no cost" and "our first customers get setup help from us by email" are promises. Someone must confirm each is true today.
- D14. Privacy and Terms (LG table) carry the name 82 times, a typed address, "security@routeflow.info" in 5 places, the entity "Routeflow Solutions LLC" and a GitHub link. Wording only, no change of meaning; any change goes to the attorney.

## Terms used inconsistently across pages

- bill / invoice / recurring invoice / repeat invoice (D2)
- store / buyer / retailer / seller / customer (D9)
- box / case; pc / pcs / piece / each (D5)
- "Each buyer’s price" / "Price levels" / "A store’s own price" / "Set each store’s price" (one feature, four names)
- "Counter sales" (wheel, home, pricing) / "Sell at the counter" (home, product): both headings are fine; keep one per page
- "Start free trial" / "Start your free trial" / "Try it free for 14 days" / "Create account" (D10)
- "Company" / "About us" (D4)
- "Sign in as a store" / "Store sign in" (CT-05)
- "Workspace ID" (site and sign-up) with "workspace ID" lowercase mid-sentence; "lowercase" / "small letters"; "hyphens" / "dashes" (SU-05)
- "after delivery" / "after delivery or shipment" (D3)
- "greyed out" (home, product) vs house style "dimmed"
- "Stock Value (cost)" (wheel) vs sentence case elsewhere (WH-13); app mocks mix Title Case (Create Order, Payment History) and sentence case
- "14 days free" / "First 14 days free" / "14 days from the day you sign up"
- Title separator "|" (static pages) vs "·" (React pages) (SH-12)
- "Email us" / "Contact us" / "Write to us" / "Send us" link and heading labels (CT-02)

## Strings that could not be classified

- `home.html:114,126` long concatenations of wheel text (truncated in my read); they come from the same source as `rf-wheel-up.js:21-37` and are covered by WH rows, not read line by line in the HTML.
- `home.html` app-mock text (HM-14, HM-18, WH-14): cannot tell from the repo whether each label equals the live app's label; needs a screenshot check.
- The sample business names in mocks and examples (Corner Market, Lake Mart, Bayside Deli, Hilltop Grocery, Pine Street Market, Acme Foods, Acme Supply, Acme Distribution Co.). They read as made-up and are labelled "sample", but I cannot prove none is a real business; a person should confirm. No real customer is named anywhere I read. The only real people named are the founder (signature, `home.html:539`, `company.html:107`) and, in the letter, an unnamed co-founder’s father (a CLAIM, HM-25).
- `app/layout.tsx` metadata beyond the title template (line 53) was not opened in full; the legal and auth pages other than sign-up (login, buyer login, 404) were not in this package's file list and were not read.
- CSS `content:` strings in `css/*.css` and `site-frame.css` were not searched.
