# Wholesaler onboarding playbook — from demo to live

This is the procedure the RouteFlow team follows from the end of a sales demo until the
wholesaler has been running on RouteFlow for 30 days. Every step has an owner, a target time and
a gate that needs evidence, so none of them get skipped. It is run by hand today. The in-app
version (onboarding cases, a secure intake link, applying answers without retyping) is designed
and **parked** in [`docs/superpowers/plans/2026-09-24-wholesaler-onboarding-build.md`](../superpowers/plans/2026-09-24-wholesaler-onboarding-build.md).

**Owner decisions behind it (2026-09-24):**

- **We load their data (white-glove).** They send files; we clean and import them; they check and
  sign off.
- **Paid from the start.** No free pilot for new wholesalers. They pay by **card** (Stripe
  checkout) or **bank transfer / Zelle / check** (recorded by us).
- **One-time setup fee** on top of the subscription, amount set per deal, paid with the first
  payment. It is never counted in MRR.
- **They accept the deal in writing:** the order summary plus the Terms of Service and Privacy
  Policy.
- **Billing starts the day they pay**, so we aim to go live about **10 business days** after
  payment.

Related: [demo booking setup](google-calendar-demo-booking-setup.md) (how prospects book the demo
this playbook starts from).

---

## How to use this playbook

1. After every demo, **copy [Appendix D](#appendix-d--per-client-checklist-copy-for-each-client)
   into a new file in that client's private folder.** Never put it in this repo, a GitHub issue or
   any tool that goes public: the repo and its issues are public during CI windows.
2. Work the stages **in order**. A stage is finished only when its gate is ticked with evidence.
   Steps marked ⏩ may start early.
3. **Waivers:** a required step can be skipped only with a written reason in the checklist's
   waiver log (who, when, why). The owner reads the waiver log at the 30-day review.
4. After each onboarding, add anything that slowed you down to this playbook, so the next one is
   faster.

## 1. At a glance

| #   | Stage             | Who             | Target                                     | Gate (evidence in the checklist)                                            |
| --- | ----------------- | --------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| 1   | Follow-up         | Us              | ≤ 1 business day after the demo            | Fit notes, package and recap sent. Decision: Go / Not now / Lost            |
| 2   | Agree             | Them (we nudge) | ≤ 7 days                                   | Written acceptance saved + section B of the questionnaire checked           |
| 3   | Activate          | Us, then them   | Same day as payment                        | Workspace **ACTIVE** + setup fee recorded                                   |
| 4   | Collect & review  | Them, then us   | ≤ 5 business days from sending             | Every required questionnaire section approved; required files received      |
| 5   | Configure & load  | Us              | ≤ 4 business days (size-dependent, see §5) | Data-quality checks pass, with the numbers recorded                         |
| 6   | Verify & train    | Them + us       | ≤ 4 business days                          | Email connected, all drivers signed in, training held, **written sign-off** |
| 7   | Go-live           | Both            | Cutover day                                | First real order → delivery → **invoice sent → payment recorded**           |
| 8   | Hypercare & close | Us              | 14 days + 30-day review                    | 10 business days live, no open blocker, review held → **LIVE**              |

**Timeline for a typical wholesaler:** demo (day 0) → recap (day 1) → acceptance (days 2–7) →
payment and workspace (same day) → data loaded (≈ 4 business days later) → review and training
(≈ 4 more) → go-live ≈ 10 business days after payment → 14 days of hypercare → review at day 30.

## 2. Ground rules

1. **Stages close in order.** Work may start early; a stage is only closed when its gate has
   evidence.
2. **No data work before payment.** Stage 5 starts only after the workspace is ACTIVE.
3. **Secrets never travel by email, chat or questionnaire:** passwords, bank account and routing
   numbers, card numbers, API keys, SMTP passwords. The client types them into their own
   workspace. If they email one anyway, delete it and ask them to enter it themselves.
4. **Client data stays out of the repo, GitHub issues and public tools.** In the bug registry,
   use `acme`-style placeholders, never the client's name, products or invoice numbers.
5. **We change their data only through RouteFlow's own screens** (importers and settings),
   while logged in as them at their written request. The accepted order covers the onboarding
   load. Never use ad-hoc scripts. After go-live, take a fresh backup before any bulk re-import
   (see `CLAUDE_SESSION_PREAMBLE.md`).
6. **All practice happens on `routeflow-demo`** (an approved test tenant), never in the client's
   workspace. Their workspace holds only real data.
7. **Money checks come first.** Pack sizes, prices and opening balances are checked with the
   client before go-live. A wrong pack size mis-prices every case line.
8. **Never press "Extend Trial" on a paid (ACTIVE) workspace.** It silently sets the workspace
   back to TRIAL, and the trial-expiry job later makes it read-only (B558/B560). Use it only on a
   workspace that is still in TRIAL.

## 3. Who does what

| Role                 | Who                                  | Responsible for                                                                   |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| Onboarding lead      | RouteFlow                            | Owns the client checklist, runs every stage, single point of contact              |
| Back-office operator | RouteFlow (often the same person)    | Creates the workspace, records payments, loads data while logged in as the client |
| Owner                | RouteFlow                            | Sets the price and setup fee per deal; reads waivers; handles escalations         |
| Client champion      | Wholesaler (owner or office manager) | Answers the questionnaire, sends files, signs off, decides go-live                |
| Client staff         | Wholesaler                           | Office users, drivers, warehouse: attend training, sign in before go-live         |

---

## 4. The stages

### Stage 1 — Follow-up (≤ 1 business day after the demo)

**Goal:** turn the demo into a clear yes, not now, or no.

- [ ] Record the **fit notes** in the client checklist: segment (snacks/candy, c-store,
      tobacco/vape, beverage, food service, beauty…), staff, vehicles, active retail customers,
      product count, current systems (invoicing / inventory / routes), regulated goods (which,
      which states), must-haves and gaps they raised, decision maker, target go-live date.
- [ ] Note the demo as done in the checklist. There's no back-office screen for demo bookings
      yet: bookings arrive by email (`DEMO_BOOKING_ADMIN_EMAIL`, default `admin@routeflow.info`)
      and in the shared Google Calendar.
- [ ] **Choose the package**: plan, add-ons, monthly or annual, setup fee.
  - Read plan prices from **Back office → Plans & Pricing** (`/admin/plans`), the only place
    with live numbers. The public `/pricing` page deliberately shows no prices.
  - Add-on names and prices aren't in the back office. Read them from **Settings → Plan &
    billing** inside `routeflow-demo`.
  - The owner sets the setup fee.
  - **If they deliver on routes, the package must include "Recurring routes" or "Ad hoc order
    delivery".** Route planning and driver runs are locked behind one of those two add-ons
    (enforced today).
- [ ] Send **template B1 (recap)**.

**Gate:** fit notes + package + recap sent, and a decision recorded:
**Go** → stage 2 · **Not now** → set a follow-up date · **Lost** → write down why.

**Watch out:** quote plan names exactly as the catalog shows them. The website, the back-office
badges and older docs use different names for some tiers.

### Stage 2 — Agree (they act; we nudge on days 3 and 7)

**Goal:** a written yes to a specific order, and the details needed to create their workspace.

- [ ] Send **template B2 (order summary)** with the questionnaire (Appendix A) attached. It lists
      the plan, add-ons, monthly price, setup fee, "billing starts the day you pay", what we'll
      load, and the target go-live.
- [ ] Save their **written acceptance** (the exact reply line in B2) as a PDF in their folder. It
      covers the order and the Terms of Service and Privacy Policy at `/terms` and `/privacy`.
      Record the terms version as the pages' "Last updated" date (September 17, 2026 at the time
      of writing).
- [ ] Receive **section B** (account & identity) and check it character by character:
  - **Business name:** it **can't be changed after the workspace is created** (B853). The
    tenant's edit is discarded, and the back office shows it read-only.
  - **Workspace short name (slug):** 3–30 characters, lowercase letters, digits and hyphens,
    starting with a letter or digit. Reserved words (`admin`, `api`, `app`, `www`, `platform`,
    `auth`, `health`, `static`) are refused.
  - **Admin email:** it receives the login.
- [ ] ⏩ They start the rest of the questionnaire and gather files.
- [ ] Send **template B4 (reminder)** on day 3 and day 7 if nothing has come back.

**Gate:** acceptance PDF saved + section B checked.

### Stage 3 — Activate (same day as payment)

**Goal:** an ACTIVE, paid workspace. Nothing else happens until this is true.

1. [ ] Send **template B3 (welcome-email heads-up)** first. The automatic welcome email
       contains a temporary password, talks about a "trial" and includes a card link. That's
       expected; the heads-up stops the client worrying.
2. [ ] **Back office → Tenants → New tenant** (`/admin/tenants/new`). Fill in:
   - **Slug**, **Business Name**, **Admin Email**, **Admin Username**: straight from section B.
   - **Admin Password: leave blank.** RouteFlow then generates one and forces a change at first
     sign-in. A typed password doesn't force a change.
   - **Plan:** the agreed plan.

   Click **Create Tenant**. The success panel shows the temporary password once. Don't copy it
   anywhere; the client gets it in their welcome email.

3. [ ] Payment, their choice:
   - **Card:** they use **"Complete your subscription"** in the welcome email. When the Stripe
     checkout completes, the workspace switches to **ACTIVE** automatically. Afterwards they
     land on the sign-in page with no confirmation message; that's normal. The link is missing
     if Stripe can't price the plan (e.g. Enterprise without a custom fee). In that case, set
     the fee under **Billing & Subscription → Custom fee override**, then use **Create checkout
     session** there and send them the link. Setting that fee on a trial workspace books it into
     the revenue ledger early, and the payment books it again (B864). MRR stays right, so tell
     finance.
   - **Bank transfer / Zelle / check:** when the money arrives, **Back office → tenant →
     Billing & Subscription → Manual Activation**. Enter the plan, payment method, billing
     period, the transaction reference and, in Notes, `incl. one-time setup fee $X`. Click
     **Activate Subscription**.

     ⚠️ This form can't select **Growth** (B857). For a Growth customer paying by bank, ask the
     owner before promising bank payment, or offer card. An **Annual (365 days)** period is
     stored as a monthly cycle (B863), so keep the §7 renewal reminder even for annual payers.
4. [ ] **Setup fee:**
   - Card payers: send a separate Stripe payment link or invoice for the fee (owner, in
     Stripe). Record the Stripe receipt number in the checklist.
   - Bank payers: include the fee in the same transfer, recorded in Manual Activation's notes.
   - RouteFlow has no setup-fee field, so the checklist is the record. The fee never enters MRR.
5. [ ] Check **Overview** shows status **ACTIVE**.

**Gate:** ACTIVE + setup fee recorded, **before the 14-day trial ends.** Otherwise the workspace
turns read-only. Sign-in, exports and paying still work, and recording the payment restores it.
Unpaid workspaces also email every admin "Your trial ends in 7 days" and "…ends tomorrow", which
is another reason to create the workspace only when they're ready to pay.

### Stage 4 — Collect & review (≤ 5 business days from sending the questionnaire)

**Goal:** everything we need to load, checked before we start.

- [ ] They complete sections C–H and send the files listed in Appendix A, section G.
- [ ] Review each section within 2 business days: approve it, or send **template B5** with
      specific questions.
- [ ] Open every file: check it reads, has the columns §5 needs, and the counts look right
      (e.g. "about 400 products" really is ~400 rows). Ask for anything missing **now**, not
      during the load.
- [ ] Decide what's required for this client. Regulated goods only if they sell them; buyer
      portal only if they bought it; open invoices only if they have unpaid invoices to carry
      over.
- [ ] Send **template B4 (reminder)** on day 2 and day 4 if sections are outstanding. Offer a
      20-minute call to finish them together.

**Gate:** every required section approved (or waived with a reason) + required files received.

### Stage 5 — Configure & load (us; ≤ 4 business days — size-dependent)

**Goal:** their workspace holds their real, correct data. The step-by-step detail is in
[§5](#5-loading-their-data). In order:

1. [ ] **Log in as them:** Back office → tenant → Overview → **Impersonate**.
   - Each session lasts **15 minutes** and is audited.
   - A red banner shows while you're impersonating; leave through the banner or the avatar
     menu's **Exit impersonation**.
   - Re-impersonate as needed, and re-check the result of any import that was running when a
     session expired.
2. [ ] **Settings** from sections B–D:
   - **Settings → Business profile** (`/settings?tab=profile`): Owner/Manager Name,
     Customer-Facing Email, street/city/state/ZIP, Phone, Default Tax Rate. Upload the logo with
     **Choose File** in the Logo card. The Business Name and Account Email boxes on this tab
     don't save (B853); the name comes from workspace creation. The business address is also the
     route **depot**, so fill it in.
   - **Settings → Invoicing** (`/settings?tab=invoicing`): **Payment Terms** (the workspace
     default), Customer Notes, Terms & Conditions, deposit defaults. **Leave "Invoice Number
     Prefix" and "Payment Due Days" alone**; they don't save (B852).
   - **Settings → Costing** (admin only): costing method, margin floor.
3. [ ] **Add-ons and features** match the accepted order: **Back office → tenant → Addons &
       Features**. That includes the routes add-on if they deliver on routes.
4. [ ] **Regulated goods** (if any):
   - **Settings → Regulated sections** (`/settings?tab=regulated`): tracked categories, tax type
     and rate, licence and age checks, reporting.
     - The **"Wholesaler license #"** field appears only for the Texas Comptroller report
       template, and has **no expiry field**. Record the expiry in the checklist.
   - **Settings → Selling restrictions** (`/settings/restrictions`): the state rules, "Which
     address decides the state", then **Check readiness** before switching on "Enforce selling
     restrictions".
5. [ ] **Import**, in this order: products → customers → stock → open invoices → payments
       (optional). Suppliers are added by hand. See [§5.2](#52-load-order-and-file-specs).
6. [ ] **Set by hand** what the importers can't carry
       ([§5.3](#53-what-you-set-by-hand-after-the-imports)): pack sizes, tier prices, barcodes,
       costs, tobacco flags; customer terms, tiers, credit limits, exemptions, licences.
7. [ ] **Routes** (**Routes → New Route**, `/routes/create`):
   - Enter the **Route Name**, then add stops by searching customers. Leave **Default Driver**
     empty (it's optional); drivers don't exist until stage 6.
   - Order the stops by dragging, or use **Optimize Stop Order**.
   - Under **Route options**, set **Start from: Tenant depot** (the business address) and **End
     at**.
   - Routes have no weekday field: make one route per delivery area and day (e.g. "Mon —
     North"). Each day's trip is a run scheduled for a date.
8. [ ] **Don't create user logins yet.** Staff invites go out in stage 6, and drivers are set up
       during their training.
9. [ ] Run the **data-quality gate** ([§5.4](#54-data-quality-gate)) and record the numbers.

**Gate:** every data-quality check passes (or is waived with a reason), numbers recorded.

**Before promising a date,** time yourself on the first 20 products and 20 customers of the
hand-set fields, multiply out, and tell the client the real date. Large catalogs take longer
until the importers carry more columns (B858/B859).

### Stage 6 — Verify & train (≤ 4 business days)

**Goal:** they've seen their own data, found anything wrong, and every user can work.

- [ ] Send **template B6 (workspace ready)**. The admin signs in with the welcome email's
      temporary password and sets their own.
- [ ] **Office logins:** Settings → User management → **Add User**. Each person gets an email
      with a link to set their own password (valid 72 hours).
  - ⚠️ This form always creates an **office (Operator)** login, whatever the Role box says
    (B862). **Never use it for drivers.**
  - To give someone admin rights, grant admin from their row in the users list afterwards.
- [ ] **They connect email sending** (**Settings → Email (SMTP)**, `/settings?tab=email`) and
      click **Send Test Email**. Invoices can't be emailed until this works.
  - Options: a provider preset or custom SMTP, or **Send from your own domain**.
  - **Connect Gmail / Connect Outlook** only appear if the connected-mailbox add-on is on.
- [ ] **They enter their "How to pay" details** themselves (**Settings → How to pay**,
      `/settings?tab=remittance`, admin only): pay-to name, bank, account and routing numbers,
      and ACH / wire / check instructions. These print on their invoices.
- [ ] **Office training (≈ 90 min, recorded)** on their own data. Walk 10 products (price, pack
      size, tier prices), 10 customers (address, terms, balance), the total unpaid versus their
      own aging report, and stock. Every error goes on the fix list, and we fix it.
- [ ] **Practice** (order → route → deliver → invoice → payment) on **`routeflow-demo`**, never
      in their workspace.
- [ ] **Driver session (≈ 45 min):**
  - Create each driver during the session: **Drivers → New Driver → Add Driver** (Full Name,
    Email, Phone, Username, vehicle).
  - The temporary password shows once on screen. Hand it to the driver in person. No email
    goes out (B854).
  - Each driver opens the driver app on their own phone at
    `https://routeflowmobile-production.up.railway.app`, or via **Open the driver app →** on
    the RouteFlow sign-in page. They enter the **Company Code** (the workspace short name), then
    their username and password.
  - Set each route's **Default Driver** now that the drivers exist.
  - Then they practise a route on `routeflow-demo`.
- [ ] Warehouse session if they receive and count stock in RouteFlow.
- [ ] **Invoice look:** open one of the imported open invoices and use **PDF** or **Print** to
      check the logo, address, terms and "How to pay" block. **Don't create a test invoice.**
      Every new invoice, even a deleted draft, uses up a number (`INV-<year>-0001`…).
- [ ] Agree the **cutover date** (≥ 3 business days' notice; start of a week, never month-end)
      and the **rollback rule** (Appendix C).
- [ ] If they bought the buyer portal: plan which retailers to invite, and when (week 2 after
      go-live).
- [ ] Get their **written sign-off** (reply line in B6), saved as a PDF.

**Gate:** email connected + every driver signed in + training held + sign-off saved.

### Stage 7 — Go-live (cutover day; we're on call)

**Goal:** they run a normal day on RouteFlow, and the first money cycle completes.

- [ ] ≥ 1 business day before the first invoice goes out, they send **template B7** to their
      retailers (new invoice sender, same terms).
- [ ] **Final stock count** as of cutover → re-run the stock import (it overwrites, it doesn't
      add).
- [ ] **Delta load:** invoices issued and payments received in the old system since the load →
      import them (invoices keep their numbers, and re-importing is safe).
- [ ] **Open orders, quotes and unused customer credits:** decide each one with them (finish it
      in the old system, or re-key it in RouteFlow) and record the decision.
- [ ] **Invoice numbering:** tell them new RouteFlow invoices are numbered `INV-<year>-0001`
      upward. Continuing the old system's sequence isn't possible yet: the Numbering card's
      "continue where your old system left off" doesn't reach live invoices (B861). Imported
      invoices keep their original numbers.
- [ ] Their **written confirmation** that the old system takes no new orders or invoices from
      today.
- [ ] Rollback rule on file (Appendix C).
- [ ] **First cycle:** first real order → route → delivery → invoice **sent** → payment
      **recorded**. Write the invoice number in the checklist.

**Gate:** first cycle complete, no open blocker.

### Stage 8 — Hypercare & close (14 days + the 30-day review)

- [ ] Check in daily on days 1–3 (15 minutes), then Tuesdays and Thursdays to day 14.
- [ ] One issue list in their folder. Real defects go to the bug registry with placeholders,
      never the client's name.
- [ ] Watch usage: orders per day, invoices sent, payments recorded, drivers completing stops.
- [ ] Week 2, buyer portal (if bought): they send the retailer invites they planned.
  - Open the customer page → **Buyer Portal** card → **Send Portal Invite**. It's email only,
    and the link lasts 7 days.
  - If the email fails, the card still says "Invite Sent", but the response warns you. Then use
    **Resend Invite** or share the link directly.
- [ ] **Renewals:**
  - Card payers renew automatically through Stripe.
  - **Manual payers need a routine** ([§7](#7-renewals-and-the-setup-fee)), because nothing in
    RouteFlow reminds anyone.
- [ ] Day 30: delete the raw files they sent us (email attachments, downloads). Keep only the
      acceptance, the sign-off and the checklist.
- [ ] **30-day review** (template B8): goals from stage 1 versus now, plan fit (upgrade or
      downgrade), open issues, a referral or testimonial ask, and a quarterly check-in in the
      calendar.
- [ ] Record **our hours per stage** in the checklist. This is how the setup fee gets priced on
      real numbers.

**Gate:** 10 business days live + no open blocker + review held → mark the client **LIVE**.

---

## 5. Loading their data

### 5.1 What the importers can and can't do

All importers live on **Settings → Import data** (`/settings/import`). They take **CSV only**
(UTF-8), up to **20,000 rows** per file and 10 MB (invoices: 50 MB).

| Import    | Card                     | Sets                                                                            | Can't set (do by hand)                                                                                                                         | Re-running the same file                                                              |
| --------- | ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Products  | "Products (Items)"       | name, price, description, unit, SKU                                             | pack size, tier prices 2–5, barcode, category, cost, tobacco flag, MSRP, reorder point (B858)                                                  | Safe: matches by **name** and skips existing products, so it can't update them either |
| Customers | "Customers (Contacts)"   | business and contact names, phones, email, billing/shipping addresses, currency | payment terms, price tier, credit limit, tax-exempt + certificate, tax ID, tobacco licence, delivery window, consent (B859). **No geocoding.** | Safe: matches by Customer ID, then business name; only fills blanks                   |
| Stock     | "Inventory Stock Levels" | on-hand quantity (overwrites)                                                   | cost                                                                                                                                           | Safe: same quantity writes nothing new                                                |
| Invoices  | "Invoices"               | invoice number (kept exactly), customer, dates, totals, balance due, lines      | tax (always 0)                                                                                                                                 | Safe: matches by invoice number                                                       |
| Payments  | "Customer Payments"      | payments against existing invoices                                              | —                                                                                                                                              | Safe: duplicates detected                                                             |
| Suppliers | none (B860)              | —                                                                               | everything: add suppliers by hand                                                                                                              | —                                                                                     |

Imports report "imported / skipped / errors" as counts only. **Skipped rows are not listed**, so
always compare row counts with the file.

### 5.2 Load order and file specs

Format rules for every file: first row = column names exactly as below. **Dates as
`YYYY-MM-DD`** (other formats may be silently dropped). Money may include `$` and commas. Put
quotes around any text that contains a comma.

**1 · Products** ("Products (Items)")

| Column        | Required | Notes                                                           |
| ------------- | -------- | --------------------------------------------------------------- |
| `Item Name`   | yes      | Must be unique; the importer matches existing products by name  |
| `Rate`        | no       | Selling price for the product's unit (default 0)                |
| `Unit`        | no       | e.g. `case`, `box`, `each` (default `unit`)                     |
| `SKU`         | no       | Must be unique in the workspace; a duplicate SKU fails that row |
| `Description` | no       |                                                                 |

Alternative: **Settings → Move to RouteFlow** (`/settings/migration`) stages products first and
gives a **24-hour undo**, and also takes `category`. Columns: `name`, `sku`, `price`, `unit`,
`category`. It splits on raw commas, so use it **only if no product name contains a comma**.

**2 · Customers** ("Customers (Contacts)"), after products

| Column                                                                                     | Required | Notes                                                        |
| ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------ |
| `Customer Name` (or `Display Name` / `Company Name`)                                       | yes      | Business name. **Invoices later match on this exact text**   |
| `Customer ID`                                                                              | no       | Their old system's ID. Best match key for re-imports         |
| `First Name`, `Last Name`, `Salutation`                                                    | no       | Main contact                                                 |
| `Phone`, `MobilePhone`, `EmailID`                                                          | no       |                                                              |
| `Billing Address`, `Billing Street2`, `Billing City`, `Billing State`, `Billing Code`      | no       | Code = ZIP                                                   |
| `Shipping Address`, `Shipping Street2`, `Shipping City`, `Shipping State`, `Shipping Code` | no       | Only if different from billing (the delivery address)        |
| `Billing Latitude` / `Billing Longitude` (and `Shipping …`)                                | no       | Include if you have them; nothing geocodes at import         |
| `Contact Type`                                                                             | no       | Leave blank or `customer`. **Any other value skips the row** |
| `Notes`, `Currency Code`                                                                   | no       | Currency defaults to USD                                     |

**3 · Suppliers:** add each by hand (Suppliers screen). There's no import screen (B860).

**4 · Stock** ("Inventory Stock Levels"), after products

| Column          | Required | Notes                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------- |
| `Item Name`     | yes      | Must match the product exactly                                            |
| `SKU`           | no       | Matched against SKU or barcode first                                      |
| `Closing Stock` | yes      | Quantity on hand **in the product's unit**; overwrites the current figure |

⚠️ A row that matches no product **creates a new product**. Fix names and SKUs so every row
matches before you import. A SKU containing a comma is skipped.

**5 · Open invoices** ("Invoices"), after customers. Carry over only **unpaid and part-paid**
invoices. One row per invoice is enough.

| Column                                              | Required | Notes                                                                                                                       |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Invoice Number`                                    | yes      | Kept exactly; never re-numbered                                                                                             |
| `Customer Name`                                     | yes      | **Must match an imported customer exactly.** A mismatch creates a duplicate customer                                        |
| `Invoice Date`, `Due Date`                          | no       | `YYYY-MM-DD`                                                                                                                |
| `Total`                                             | yes      | The invoice total **including tax**; tax isn't imported as a separate figure                                                |
| `Balance Due`                                       | yes      | What's still owed. It sets the status: equal to Total = unpaid, less = part-paid, 0 = paid                                  |
| `Item Name`, `Quantity`, `Item Price`, `Item Total` | no       | Use one line, e.g. `Balance from previous system` × 1 at the Total. Without them the importer adds a single "Services" line |

**6 · Payments** ("Customer Payments"): optional, only if they want payment history.
Columns: `Invoice Number` (must already exist), `Amount` (or `Amount Applied to Invoice`),
`Date`, `Mode` (cash / check / zelle / ach / other), `Reference Number`.

### 5.3 What you set by hand after the imports

**Every product**, on its page (Products → the product):

- **Units per box** (pack size) first.
- Tier prices, if they use price levels.
- **Case code (SKU / barcode)** and **Unit code**: barcodes are what scanning reads.
- Category and Regulated type.
- **Mark as tobacco** where it applies.
- Costing method / Standard Cost.
- MSRP, if the MSRP add-on is on; it has a bulk editor.
- Reorder point.

**Every customer**, on their page (Customers → the customer):

- **Edit:** Credit Limit, Tax ID, **Tax Exempt**.
- **Special Prices** tab: **Default Pricing Tier** (1–5), **Default Payment Terms**,
  **Deposit** %.
- **Licenses** tab ("Licenses & Authorizations"): category, licence number, **expiry date**.
- **Tax Exempt Documents → Add Photo**: images only, so photograph or convert PDF certificates.
- **Delivery Time Window** card, and **Addresses** tab: Billing / Shipping / Delivery.
- SMS/WhatsApp consent **can't be recorded in RouteFlow yet**. Text and WhatsApp messages to
  their customers won't send, so don't promise them (context: B183).

**Suppliers:** add each on the Suppliers screen (name, contact, terms, and licence number if
regulated).

**Map positions:** opening **Routes → New Route** looks up every customer address ("Geocoding N
addresses…"). A customer that won't place on the map has an address problem; fix the address.
There's no list of customers missing coordinates.

### 5.4 Data-quality gate

Record each number in the checklist. Anything that doesn't reconcile is fixed or waived with a
reason.

| Check                 | How                                                                                                                          | Pass when                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Row counts            | Each import's "imported / skipped" versus the file's row count                                                               | Every skip explained                                                                          |
| Pack sizes and prices | There's no filter for either, so tick each product off against your prepared spreadsheet as you enter it; then spot-check 20 | 0 gaps                                                                                        |
| Costs                 | `/inventory` → **Stock Value (cost)** card → the **"N missing cost"** chip                                                   | 0, or agreed                                                                                  |
| Duplicates            | Check your prepared files for repeated names and SKUs before importing, then scan the customer and product lists             | None, or merged                                                                               |
| Map positions         | Routes → New Route map (see §5.3)                                                                                            | Every customer places, or is on a fix list with an owner                                      |
| Tax-exempt            | Every exempt customer has a certificate photo                                                                                | 100%                                                                                          |
| Licences              | Retailer licences (Licenses tab) present and not expired                                                                     | Expired ones flagged to the client                                                            |
| Open balances         | **Finance → Reports** (`/finance/reports`) → **AR Aging Summary** / **AR Aging Details** versus their aging report           | Equal to the cent, per customer                                                               |
| Credit limits         | Customers whose opening balance exceeds their limit                                                                          | Listed and agreed. RouteFlow hard-blocks order changes over the limit and there's no override |
| Stock                 | RouteFlow on-hand versus their count, for 10 random products                                                                 | Equal                                                                                         |

## 6. Go-live: cutover and rollback

- **Pick the day:** the start of a week, a low-volume day, never month-end, with ≥ 3 business
  days' notice.
- **Freeze the old system** for new orders and invoices from cutover. Keep it available
  (read-only) for history.
- **Rollback rule** (agree it at stage 6; text in Appendix C): who decides (their champion + our
  lead), the trigger (orders, deliveries or invoicing blocked for more than 2 hours in go-live
  week), and how long the old system stays usable (10 business days). If they fall back,
  whatever they did in the old system during the fallback is re-entered in RouteFlow
  afterwards.
- **Before go-live, fix a bad import forward:** correct it on screen, or use the Move to RouteFlow
  undo within 24 hours. Never use destructive scripts, and never ask for a workspace to be wiped.

## 7. Renewals and the setup fee

|               | Card (Stripe)                                                            | Bank transfer / Zelle / check                    |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| First payment | Welcome-email link (or Billing & Subscription → Create checkout session) | Manual Activation with reference                 |
| Setup fee     | Separate Stripe payment link/invoice; receipt number in the checklist    | In the same transfer; noted in Manual Activation |
| Renewal       | Automatic; failed payments follow Stripe dunning                         | **Manual — see below**                           |

**Manual-payer renewal routine.** Nothing in RouteFlow reminds anyone, and the billing period
rolls forward on its own without a payment check.

1. Put a reminder in the calendar **7 days before each period ends**.
2. Email them the renewal amount and payment instructions.
3. When the money arrives, re-submit **Manual Activation** with the new reference. That rolls the
   period forward.
4. If a payment is more than 7 days late, tell the owner. There's no automatic suspension for
   manual payers.

---

## Appendix A — Setup questionnaire (send to the client)

> **RouteFlow setup questionnaire for {Business name}**
>
> Thanks for choosing RouteFlow. Your answers tell us how your business runs, so we can set up
> your workspace and load your data for you. Most sections take a few minutes; the file list in
> section G takes longest. If anything is easier to explain on a call, write "call" and we'll
> go through it together.
>
> Please **don't** send passwords, bank account numbers or card details. You'll enter those
> yourself inside RouteFlow.

**B. Your business and account** (we need this first, to create your workspace)

1. Legal business name, exactly as registered.
2. Name to show on invoices and to your customers, if different. Please double-check the
   spelling; it can't easily be changed later.
3. A short name for your workspace (lowercase letters, numbers and hyphens, e.g.
   `acme-wholesale`). It appears in your RouteFlow links.
4. Owner's name.
5. Main admin: name, email and preferred username.
6. Business address.
7. Main phone number.
8. Email address your customers should reply to (printed on invoices).
9. Website.
10. Time zone.
11. Your logo (PNG or JPG).

**C. Tax and compliance**

1. The sales tax rate you charge.
2. Federal EIN.
3. Do you sell regulated goods (tobacco, vape/e-cigarettes, nicotine, alcohol, other)? Which, and
   in which states?
4. Your wholesale licence or permit numbers for those, with expiry dates.
5. States you sell into.
6. Any excise or per-unit taxes you add to invoices.
7. Which customers are tax-exempt? Please send each one's resale or exemption certificate.
8. For regulated goods: which customers need a retail licence on file? (Numbers and expiry dates
   can go in the customer file.)

**D. Invoices and getting paid**

1. The last invoice number you issued, and its format. (RouteFlow starts its own series for new
   invoices, like `INV-2026-0001`; your existing invoices keep their numbers.)
2. Do you number quotes or credit notes? The last numbers, if so.
3. Your usual payment terms (COD, Net 7, Net 15, Net 30…). Note any customer on different terms
   in the customer file.
4. Anything printed on every invoice (notes, terms, return policy).
5. Do you take deposits? The usual percentage.
6. How customers pay you (cash, check, ACH, card, Zelle, other). Methods only; you'll add bank
   details yourself later.
7. Would you like customers to pay invoices online by card?

**E. Your team**

1. Office and admin staff who need a login: name, email, role (admin or office).
2. Drivers: name and mobile number (email optional).
3. How many vehicles, and their names or numbers if you use them.

**F. Deliveries**

1. Warehouse or depot address (where routes start and end).
2. Delivery days and areas (e.g. Monday: north side). Existing route sheets help; send them.
3. Order cutoff time.
4. Customers with delivery time windows.
5. Do customers ever pick up from you?

**G. Your data (files)**

First tell us what you use today for invoicing, inventory and routes (QuickBooks, Zoho,
spreadsheets, paper, another app). Then send what you have. Spreadsheets or exports are best,
and don't worry about the layout; we'll convert it.

1. **Products and prices:**
   - name, item code/SKU, barcode (UPC)
   - unit and case size (units per case)
   - your cost, and your selling price(s), including price levels if you use them
   - category, taxable (yes/no), regulated (yes/no), supplier
2. **Customers:**
   - business name, contact name, phone, email
   - delivery address, and billing address if different
   - payment terms, credit limit, price level
   - tax-exempt (yes/no), licence number and expiry (if regulated)
   - delivery day/route
3. **Suppliers:** name, contact, phone, email, address, terms.
4. **Stock on hand:** a count per product and the date you counted. We refresh it on go-live day.
5. **Unpaid invoices** (an aging report): per invoice, the number, customer, date, due date,
   total and balance.
6. **Open orders, quotes and customer credits** not yet used. We'll decide together how to carry
   each one over.
7. **Product photos** (optional).
8. **Tax-exempt certificates and customer licences**, if not already sent.

**H. Go-live and training**

1. The earliest go-live date you'd like (we suggest a Monday or Tuesday, not month-end).
2. Who should attend training (office, drivers, warehouse), and good days and times.
3. Anything else we should know: busy seasons, special customers, how you handle returns.

## Appendix B — Email templates

Fill in the `{…}` parts. Keep them short and personal.

**B1 · Recap** (≤ 1 business day after the demo)

> Subject: RouteFlow for {Company}: recap and next steps
>
> Hi {First name},
>
> Thanks for your time {today/yesterday}. Here's what we heard and what we'd suggest.
>
> What you told us:
>
> - {pain point 1}
> - {pain point 2}
> - {must-have}
>
> What we'd set you up on:
>
> - {Plan}: ${monthly}/month{ (or ${annual}/year)}
> - Add-ons: {add-on, $x/month}
> - One-time setup: ${fee}. This covers loading your products, customers, prices and unpaid
>   invoices, and training your office and drivers.
>
> From here, you confirm the order and we create your workspace. Your subscription starts the
> day you pay, and we load your data and train your team. We aim to have you live about two
> weeks after you pay.
>
> If that sounds right, reply and I'll send the order summary and a short setup questionnaire.
>
> {Name}

**B2 · Order summary** (attach the questionnaire)

> Subject: Your RouteFlow order and setup questionnaire
>
> Hi {First name},
>
> Here's your order. Please read it, then reply with the line at the bottom.
>
> - Business: {legal name}
> - Plan: {Plan}, ${monthly}/month ({monthly/annual})
> - Add-ons: {…}
> - One-time setup fee: ${fee}
> - Billing starts on the day you pay. You can pay by card (a secure link from our system) or by
>   bank transfer, Zelle or check.
> - We'll load: {products, customers, prices, suppliers, stock, unpaid invoices}. Training for
>   {office / drivers / warehouse}.
> - Target go-live: {date}
>
> Terms of Service: https://www.routeflow.info/terms · Privacy Policy:
> https://www.routeflow.info/privacy
>
> To accept, reply with:
> "I accept the order above and the RouteFlow Terms of Service and Privacy Policy on behalf of
> {legal name}. {full name}, {title}"
>
> Then please fill in section B of the attached questionnaire (your business and account
> details) and send it back; we need it to create your workspace. The rest can follow over the
> next few days with your files. Please don't email passwords or bank account numbers.
>
> {Name}

**B3 · Welcome-email heads-up** (just before creating the workspace)

> Subject: Your RouteFlow account email is on its way
>
> Hi {First name},
>
> We're creating your workspace now. In a few minutes you'll get an email titled "Welcome to
> RouteFlow — Your {Business} account is ready". It has your username, a temporary password and a
> link to pay by card. It also mentions a "trial". That's automatic wording and doesn't change
> what we agreed: your subscription starts when you pay.
>
> - Paying by card: use "Complete your subscription" in that email. You'll then see a sign-in
>   page; you can sign in or just close it. We'll send the one-time setup fee (${fee}) as a
>   separate card payment link.
> - Paying by bank transfer, Zelle or check: {instructions}. Please include the setup fee
>   (${fee}) and the reference "{legal name} RouteFlow".
>
> You don't need to do anything else yet. We'll tell you when your data is loaded and ready to
> review.
>
> {Name}

**B4 · Reminder**

> Subject: Quick reminder: RouteFlow setup details
>
> Hi {First name}, just checking in on the setup questionnaire. We still need {list}. If it's
> easier, we can go through it together on a 20-minute call: {two time options}. Once we have
> everything, loading takes us about {n} working days.

**B5 · Section sent back**

> Subject: A few questions about your {section} answers
>
> Hi {First name}, thanks for sending {section}. Before we load it, could you confirm:
>
> 1. {question}
> 2. {question}

**B6 · Workspace ready for review**

> Subject: Your RouteFlow workspace is ready to review
>
> Hi {First name},
>
> Your products, customers, prices and unpaid invoices are loaded. Before training, please:
>
> 1. Sign in at {link} with the username and temporary password from the welcome email. You'll
>    be asked to set your own password.
> 2. Connect your email under **Settings → Email (SMTP)**, so invoices go out from your
>    address, and click **Send Test Email**.
> 3. Add your bank or remittance details under **Settings → How to pay**. They print on your
>    invoices.
> 4. Look over the attached check sheet: 10 products with prices and case sizes, 10 customers
>    with terms and balances, and your total unpaid invoices against your own report.
>
> Tell us anything that looks wrong and we'll fix it. When everything is right, reply with:
> "Our data in RouteFlow is correct and we're ready to go live. {full name}, {title}"
>
> Training: {dates and times}.

**B7 · Retailer notice** (the client sends this to their customers)

> Subject: New invoices from {Business}
>
> Hi {Customer},
>
> From {date}, our invoices will come from {sender email} through our new ordering and delivery
> system. Please add that address to your contacts so our invoices don't land in spam. Your
> prices, terms and account stay the same.{ In a couple of weeks we'll also send you a link to
> order online.}
>
> Thanks,
> {Owner}

**B8 · 30-day review**

> Subject: A month on RouteFlow: quick review?
>
> Hi {First name}, you've been live for a month. Could we take 30 minutes on {date} to see how
> it's going? I'll bring your orders and invoices so far, anything still open from our issue
> list, and whether your plan still fits. It'd help to hear what's saved you time and what still
> feels slow.

## Appendix C — Rollback agreement (agree at stage 6)

> If RouteFlow stops us taking orders, delivering or invoicing for more than **2 hours** during
> go-live week, {client champion} and {our lead} decide together whether to go back to
> {old system} temporarily. {Old system} stays usable for **10 business days** after go-live.
> Anything done there during a fallback is re-entered in RouteFlow afterwards.

## Appendix D — Per-client checklist (copy for each client)

Keep this file in the client's private folder, never in this repo.

```markdown
# Onboarding — {Client}

Lead: {name} · Demo: {date} · Package: {plan + add-ons, cycle} · Setup fee: ${fee}
Payment: card / bank · Target go-live: {date}

## Fit notes

- Segment:
- Staff / vehicles / retail customers / products:
- Current systems:
- Regulated goods (which, which states):
- Must-haves / gaps raised:
- Decision maker:
- Target go-live:

## 1 Follow-up (≤ 1 business day)

- [ ] Fit notes recorded
- [ ] Package from Plans & Pricing + add-on prices; setup fee set by owner
- [ ] Routes add-on included (Recurring routes / Ad hoc order delivery) if they deliver on routes
- [ ] B1 recap sent — date:
- [ ] Decision: Go / Not now (follow up on: ) / Lost (why: )
- [ ] **GATE** — date: … by: …

## 2 Agree

- [ ] B2 order summary + questionnaire sent — date:
- [ ] Written acceptance saved (PDF) — date: · terms version (Last updated):
- [ ] Section B received and checked (business name spelling, slug rules, admin email)
- [ ] Reminders day 3 / day 7 (if needed)
- [ ] **GATE** — date: … by: …

## 3 Activate

- [ ] B3 heads-up sent
- [ ] Workspace created (password left blank) — slug:
- [ ] Paid: card (Stripe) / bank — reference:
- [ ] Setup fee recorded — receipt/reference:
- [ ] Overview shows ACTIVE — date (must be before trial end: …)
- [ ] **GATE** — date: … by: …

## 4 Collect & review

- [ ] Sections C, D, E, F, G, H received
- [ ] Files received: products / customers / suppliers / stock / AR aging / open docs /
      certificates / photos
- [ ] Each section approved (or B5 sent)
- [ ] Required-for-this-client list decided
- [ ] **GATE** — date: … by: …

## 5 Configure & load

- [ ] Settings (profile, tax, logo, invoice text, deposits, costing)
- [ ] Add-ons match the order
- [ ] Regulated + restrictions (if any)
- [ ] Products imported: file rows … / imported … / skipped … (explained: )
- [ ] Customers imported: file rows … / created … / skipped …
- [ ] Suppliers added by hand: …
- [ ] Stock imported: rows … / matched … (no new products created)
- [ ] Open invoices imported: … · RouteFlow unpaid total $… = their aging total $…
- [ ] Hand-set product fields done (pack sizes, tiers, barcodes, costs, tobacco)
- [ ] Hand-set customer fields done (terms, tiers, limits, exemptions, licences)
- [ ] Routes built (no default driver yet)
- [ ] Quality gate: duplicates 0 · map positions all placed · exempt without certificate 0 ·
      expired licences flagged · over-limit customers agreed · stock spot-check 10/10
- [ ] **GATE** — date: … by: …

## 6 Verify & train

- [ ] B6 sent · admin signed in
- [ ] Office logins created (Add User — never for drivers)
- [ ] Email connected + test sent
- [ ] "How to pay" entered by them
- [ ] Office training held (fix list closed)
- [ ] Practice on routeflow-demo
- [ ] Drivers created (Drivers → New Driver) and signed in: … / …
- [ ] Routes' default drivers set
- [ ] Imported invoice PDF checked (logo, terms, How to pay) — no test invoice created
- [ ] Cutover date agreed: … · rollback rule agreed
- [ ] Written sign-off saved (PDF) — date:
- [ ] **GATE** — date: … by: …

## 7 Go-live — cutover date: …

- [ ] B7 retailer notice sent
- [ ] Final stock count imported
- [ ] Delta invoices/payments imported
- [ ] Open orders/quotes/credits decided
- [ ] Told them: new invoices start at INV-<year>-0001
- [ ] Old system frozen (their confirmation)
- [ ] First cycle: order → delivery → invoice sent (# …) → payment recorded
- [ ] **GATE** — date: … by: …

## 8 Hypercare & close

- [ ] Check-ins days 1–3, then Tue/Thu to day 14
- [ ] Issue list clear of blockers
- [ ] Buyer-portal invites (if bought), week 2
- [ ] Renewal: card auto / manual — calendar reminder set for …
- [ ] Raw files deleted (day 30)
- [ ] B8 30-day review held — date:
- [ ] Hours per stage: 1 … 2 … 3 … 4 … 5 … 6 … 7 … 8 …
- [ ] **LIVE** — date: …

## Waiver log

| Step | Why it was waived | Who | Date |
| ---- | ----------------- | --- | ---- |
```

## Appendix E — Known gaps and workarounds

| Gap                                                                                                  | Do this instead                                                                         | Tracked           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------- |
| No onboarding tracker or intake link in RouteFlow                                                    | This playbook + the per-client checklist + the questionnaire by email                   | Parked build spec |
| Welcome email has a temp password and "trial" wording                                                | Send B3 first; leave the password blank so a change is forced                           | B855              |
| Business name can't be changed after creation                                                        | Check section B spelling before creating the workspace                                  | B853              |
| Manual Activation can't select Growth                                                                | Offer card, or ask the owner before promising bank payment                              | B857              |
| "Extend Trial" demotes a paid workspace to TRIAL                                                     | Never use it on an ACTIVE workspace                                                     | B558 / B560       |
| Trial length fixed at 14 days in the create form                                                     | Create the workspace only when they're ready to pay                                     | B856              |
| Product import drops pack size, tiers, barcode, category, cost, tobacco                              | Set by hand (§5.3); time it before promising a date                                     | B858              |
| Customer import drops terms, tier, limit, exemptions, licences; no geocoding                         | Set by hand (§5.3)                                                                      | B859              |
| No supplier import screen                                                                            | Add suppliers by hand                                                                   | B860              |
| Numbering card doesn't continue the old sequence for live invoices                                   | Tell them new invoices start at `INV-<year>-0001`; imported invoices keep their numbers | B861              |
| Invoice prefix / payment-due days in Settings → Invoicing don't save                                 | Don't use them; set terms per customer                                                  | B852              |
| Drivers get no invite email                                                                          | Create driver logins during the driver session                                          | B854              |
| A 365-day manual payment is stored as a monthly cycle                                                | Keep the §7 renewal reminder for annual bank payers                                     | B863              |
| A custom fee set on a trial workspace is booked into the ledger early, then again at payment         | Expect the Enterprise ledger to run ahead of MRR; tell finance                          | B864              |
| "Add User" ignores its Role box and always makes an office login                                     | Create drivers only from Drivers → New Driver                                           | B862              |
| SMS/WhatsApp consent can't be recorded, so those messages never send                                 | Don't promise text or WhatsApp messages; email works                                    | B183              |
| Tax-exempt certificates upload as photos only                                                        | Photograph or convert PDF certificates to images                                        | —                 |
| The regulated "Wholesaler license #" has no expiry field (Texas template only)                       | Keep the expiry in the checklist and the calendar                                       | —                 |
| No product filter for missing pack size or price                                                     | Tick off against the prepared spreadsheet (§5.4)                                        | B858              |
| No list of customers without map positions                                                           | Use the New Route map (§5.3)                                                            | —                 |
| Routes are locked without the Recurring routes / Ad hoc order delivery add-on                        | Include one in the package for delivering wholesalers                                   | —                 |
| No setup-fee field                                                                                   | Record it in the checklist (Stripe receipt or Manual Activation note)                   | Parked build S3b  |
| Manual payers: no reminder, no automatic suspension                                                  | The renewal routine in §7                                                               | By design (B327)  |
| No back-office list of demo bookings                                                                 | Booking emails + Google Calendar                                                        | Parked build S1   |
| Add-on prices aren't shown in the back office                                                        | Read them in `routeflow-demo` → Settings → Plan & billing                               | —                 |
| Open question for the owner: a Data Processing Agreement for retailers' data, beyond Terms + Privacy | Owner / legal decision                                                                  | —                 |

## Appendix F — Metrics (per client, rolled up monthly)

- Dates: demo, acceptance, payment, go-live, LIVE. Days per stage.
- **Payment → go-live in business days** (target ≈ 10).
- Our hours per stage (this prices the setup fee).
- Waivers used, and why.
- Issues raised in hypercare: count and severity.
- Conversion: demo → acceptance → payment → LIVE.
