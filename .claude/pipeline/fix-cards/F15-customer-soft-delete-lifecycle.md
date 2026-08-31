# F15 · Customer soft-delete lifecycle

**Bug IDs (7):** B131, B141, B156, B157, B158, B159, B170

**Root cause:** deletedAt is written by one branch and read by nothing else in the API. A removed customer keeps full buyer-portal ordering access (B141), keeps getting a generated order and an emailed invoice every morning (B131), stays on scheduled routes (B157), appears in the CSV export (B158), and blocks their own re-add forever (B159).

**Ships as:** One PR.

**Files:** customers.service.ts soft branch · buyer-seller-context.guard.ts · both cron selectors · web customers list

**Together because:** One soft-delete flag, read by nothing — every consumer needs the same deletedAt filter added.

**Guardrails / shared infra:** None new.

**Dependencies / lane notes:** Positional after F02 (same customers.service.ts delete paths).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F15.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B131 | T1   | 0b2c3a0a       | MOVED (disambiguate in-file) |
| B141 | T1   | 0b2c3a0a       | MOVED (disambiguate in-file) |
| B156 | T2   | 0b2c3a0a       | AMBIGUOUS_FILE               |
| B157 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B158 | T1   | 0b2c3a0a       | MOVED (corrected)            |
| B159 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B170 | T1   | 0b2c3a0a       | TOKEN_NOT_FOUND              |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B131 — Removing a customer doesn't stop their standing orders or recurring invoices

**Area:** Customers · remove customer + order-template / recurring-invoice crons

**Meant to do:** Remove customer ends the relationship: past orders and invoices are kept, but no new order and no new bill is minted for a customer who has vanished from the Customers list.

**Actually does:** Both daily crons select on isActive alone. A removed customer keeps getting a generated order every scheduled weekday and a freshly created invoice — emailed to them when autoSend is on.

**The gap:** The soft delete writes two rows and stops there; nothing in the crons, the invoice create path, or anywhere else in the API reads deletedAt.

**Evidence:** apps/api/src/customers/customers.service.ts:1761-1792 (soft branch updates only Customer.deletedAt and User.status) vs :1867-1882 (the hard branch does tear down recurringInvoice, orderTemplate and the route rows); apps/api/src/order-templates/order-templates.service.ts:252 (@Cron 0 6 * * *), :271-274 (where { isActive: true, daysOfWeek: { has } }); apps/api/src/recurring-invoices/recurring-invoices.service.ts:228, :242, :184, :205-213 (autoSend → sendEmail); apps/api/src/invoices/invoices.service.ts:312-316 (create() looks the customer up with no deletedAt filter); grep deletedAt across apps/api/src/{invoices,orders,routes,order-templates,recurring-invoices} → zero hits, and there is no global soft-delete filter in prisma.service.ts.

**Suggested fix:** In deleteCustomer's soft branch, set the customer's OrderTemplate and RecurringInvoice rows isActive=false inside the same transaction and restore them on restoreCustomer; belt-and-braces, add customer: { deletedAt: null } to both cron selection queries.

### B141 — A removed customer keeps full buyer-portal access and can still place orders

**Area:** Buyer portal · seller-context guard

**Meant to do:** The Remove dialog states in its own body that "their portal access is paused", so the operator expects the portal login tied to that customer to stop being able to order.

**Actually does:** The soft delete never touches CustomerLink, and the seller-context guard authorises on an ACTIVE link without reading customer.deletedAt. Every buyer endpoint, including POST /buyer/orders, keeps working.

**The gap:** The guard checks tenant status but not customer deletion, so the sentence in the dialog has no code behind it on the seller side.

**Evidence:** apps/api/src/buyer/guards/buyer-seller-context.guard.ts:31-35 (tenant status checked), :37-49 (customerLink.findFirst on status ACTIVE only; the customer select does not include or filter deletedAt); apps/api/src/buyer/buyer.controller.ts:81-82, :457-462 (@Post("orders") guarded only by BuyerSellerContextGuard); apps/api/src/customers/customers.service.ts:1786-1792 (soft branch leaves CustomerLink untouched); apps/web/app/(dashboard)/customers/[id]/page.tsx:4252 and 4269-4271 (the dialog copy, verified verbatim); contrast apps/api/src/buyer/buyer-auth.service.ts:168,202,278,418,475 where BuyerAccount.deletedAt is guarded everywhere.

**Suggested fix:** Set the customer's CustomerLink rows to a non-ACTIVE status on soft delete (restoring them on restoreCustomer), and add customer: { deletedAt: null } to BuyerSellerContextGuard's link lookup so the omission is closed at the choke point.

### B156 — Customers "Unassigned only" filters one page while the count and pager still describe the full list

**Area:** Customers list · web

**Meant to do:** Toggling "Unassigned only" shows the customers with no route assignment, with the row count and pager describing that filtered set — as the server-side status, tag and regulated chips do.

**Actually does:** The visible rows are filtered client-side from the current server page, while the footer count and every page button are computed from the server's unfiltered totals.

**The gap:** The table shows a handful of rows, or none, under a footer claiming "Showing 1–20 of N customers", with no way to jump to pages that hold unassigned customers.

**Evidence:** apps/web/app/(dashboard)/customers/page.tsx:256, :319-322 (client filter over one page), :859-877 (the chip), :905, :967-969 (count from meta.total/limit/page), :988-1030 (page buttons from meta.totalPages); the assignment map itself is tenant-wide (apps/web/lib/api/routes.ts:280-281), so only the customer rows are page-limited.

**Suggested fix:** Add an unassigned filter to the customers list DTO and service (a routeAssignments-is-none equivalent) and drive the chip from it, so rows, count and totalPages all describe the same set.

### B157 — A removed customer stays on scheduled routes and is still dispatched to a driver

**Area:** Routes · route stops + dispatch run

**Meant to do:** After Remove customer, the customer stops appearing on route planning screens and is not handed to a driver as a stop.

**Actually does:** RouteStop and RouteCustomer rows survive the soft delete, the route detail renders the stop with no deletion signal, and createRun copies every route stop onto the new run and sweeps the customer's open orders onto it.

**The gap:** The hard-delete branch clears the three route tables; the soft-delete branch clears none, and nothing in the routes module reads deletedAt.

**Evidence:** apps/api/src/routes/routes.service.ts:167-179 (the stop include selects only id and businessName), :787-791, :896-905 (every route stop mapped 1:1 onto the run), :922-953 (the order sweep filters on customerId, status and fulfilPath only); apps/api/src/customers/customers.service.ts:1880-1882 (the hard branch deletes routeRunStop/routeCustomer/routeStop) vs :1786-1792 (the soft branch does not); grep deletedAt across apps/api/src/routes/*.ts returns no matches.

**Suggested fix:** Delete or flag the customer's RouteStop and RouteCustomer rows in the soft-delete transaction, and have the route read select customer.deletedAt so the route builder can badge a stop whose customer was removed.

### B158 — The customers CSV export ignores the soft-delete and supplier-only filters the list applies

**Area:** Customers · CSV export

**Meant to do:** Export downloads the customer list the operator is looking at.

**Actually does:** findAll seeds its where clause with supplierOnly:false and deletedAt:null; exportCustomers seeds an empty object and layers only the identical search/status/type/tag clauses, so removed customers and vendor-only contacts appear in customers.csv with their receivables.

**The gap:** Two seed keys are simply absent from the export's where clause, and the web button also passes no filters at all.

**Evidence:** apps/api/src/customers/customers.service.ts:~103 [re-anchored master@6c8f1401; was :108-113 at hunt round master@0b2c3a0a] (findAll seed) vs :1463-1464 (exportCustomers seeds {}), :1465-1485 (the identical downstream clauses), :1486-1501 (unpaginated findMany), :1511-1537 (rows include Receivables and Credits); apps/web/app/(dashboard)/customers/page.tsx:306 and :657 (the Export button mutates with an empty param object).

**Suggested fix:** Extract the findAll where-builder and reuse it in exportCustomers so both start from supplierOnly:false and deletedAt:null, and have the Export button pass the screen's current search/status/type/tag params.

### B159 — A removed customer's User row keeps its email and username, blocking any re-add

**Area:** Customers · API create/delete

**Meant to do:** After removing a customer the operator can add that business back — or add a different customer at the same shop email or username — like any new customer.

**Actually does:** Soft delete sets customer.deletedAt but only marks the User INACTIVE; the row keeps its email and username, and create()'s uniqueness probe filters neither, so re-adding fails with "Email or username already taken".

**The gap:** The blocking row is excluded from every list by the deletedAt filter, so the error names a conflict no filter or search can surface.

**Evidence:** apps/api/src/customers/customers.service.ts:1789-1790 (soft branch), :392-395 (the unfiltered probe and its BadRequestException), :112 (findAll hard-codes deletedAt: null), :1723-1741 (restoreCustomer); apps/api/prisma/schema.prisma:690-731 (User.deletedAt at :706 and the two @@unique constraints at :723-724); apps/api/src/customers/dto/create-customer.dto.ts:35 (username required); apps/web/app/(dashboard)/customers/[id]/page.tsx:1978,1993 (restore wired only to the 8-second Undo toast).

**Suggested fix:** Free the identity on soft delete — rename the User's email and username to a namespaced tombstone inside the same transaction — or add a persistent restore path plus a probe filtered on deletedAt:null that offers "restore instead?" when the collision is a removed customer.

### B170 — "Restore any time" has no surface after the 8-second undo, and a removed customer's page still looks live

**Area:** Customers · remove/restore lifecycle

**Meant to do:** Per the confirmation copy: "You'll have a few seconds to undo, and you can restore the customer any time."

**Actually does:** restoreCustomer works, but its only caller is the undo toast. No list, filter or search can reach a removed customer, and their detail page still renders fully editable, with a Delete button and no Removed badge.

**The gap:** findAll hard-codes deletedAt:null with no includeDeleted flag, and no client reads the deletedAt the detail response already carries.

**Evidence:** apps/web/app/(dashboard)/customers/[id]/page.tsx:4252 (the copy), :1978 and :1993 (the sole use of the restore hook, inside the undo handler); repo-wide grep for the restore hook returns its definition at apps/web/lib/api/customers.ts:411 plus that one caller, and zero mobile callers; apps/api/src/customers/customers.service.ts:108-113, :363-382, :1723-1742; apps/api/src/customers/dto/list-customers.dto.ts:6-16 (no includeDeleted) — contrast apps/api/src/sales-agents/sales-agents.service.ts:57 and platform-admin.service.ts:109, both of which offer one.

**Suggested fix:** Add includeDeleted to the customers list DTO and service with a "Show removed" filter on the list, and have the detail page read the deletedAt the API already returns to swap Delete for Restore behind a Removed banner.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
