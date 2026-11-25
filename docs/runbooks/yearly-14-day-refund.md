# Yearly plan: 14-day full refund (staff runbook)

When a customer who bought a **yearly** plan asks for their money back within 14 days, staff
refund the whole payment by hand in the payment provider's dashboard and end the subscription
that day. This is the staff refund runbook (deliverable R-1) of the yearly billing design (SA-1304).

- Nothing is refunded automatically. There is no refunds API and the code computes no refund
  figure. A refund is always the **whole** yearly payment, never a part and never a number you
  work out by hand.
- Cancelling a yearly plan from the app does **not** refund anything. The customer keeps access
  to the end of the paid year. This runbook is the only refund path.
- This runbook must be merged before the yearly offer is switched on (design PR-7).
- Examples use `acme` and made-up ids. Never write a real customer, invoice or order number into
  this file, a PR, a ticket comment in the repo, or a test.
- Do it first in the provider's **test mode** on a test tenant (`test`, `e2e-*`, `qa-*`) before
  you ever do it on a live customer.

## Who and what you need

- A staff member with access to the provider dashboard for the live account, and a platform
  super admin login for the admin console.
- OPEN: which staff role may issue the refund, and does a second person approve it before the
  money moves?

## 1. Check the customer is eligible

1. In the admin console, open the tenant and read its billing page. Confirm it shows a yearly
   plan with a provider subscription (not a manual / bank / Zelle / check row).
2. In the provider dashboard, open that customer's subscription and find the yearly payment
   (the invoice for the full year).
3. Read the date the payment succeeded. It is eligible only if it was paid **no more than 14
   days ago**. Count from the payment date, not from the date the customer asked.
4. Check this is the **first** yearly payment of this subscription. A renewal payment is not
   covered by this runbook.
5. If any check fails, stop. Do not refund. Tell the lead.

- OPEN: does day 14 itself still count (paid exactly 14 days ago)? State the cut-off time.
- OPEN: if the customer also paid a mid-year add-on or upgrade charge, is that refunded together
  with the yearly payment ("the whole yearly payment" reads as the year only)?
- OPEN: what to do for a yearly plan sold by RouteFlow invoice (design step O1, interim sale
  outside the provider)? This runbook covers provider-billed rows only.

## 2. Refund the whole payment

1. In the provider dashboard, open the yearly payment and choose **Refund**.
2. Choose the **full amount** shown. Do not type a different amount.
3. Pick the reason "requested by customer". Add a short note with the tenant slug and today's
   date. Do not put the customer's name or card details in the note.
4. Confirm. The refund goes back to the original payment method.
5. Wait until the provider shows the refund as succeeded. If it shows failed or pending
   for more than a few minutes, stop and tell the lead.

- OPEN: what to do if the refund fails (card closed or expired): another method, or escalate?

## 3. Cancel the subscription immediately

Do this **after** the refund, in the same sitting.

1. In the provider dashboard, open the same subscription and choose **Cancel subscription**,
   with **cancel immediately** (not "at period end").
2. Confirm. The provider sends a `customer.subscription.deleted` event to RouteFlow.
3. RouteFlow handles that event by moving the tenant from `ACTIVE` to `CANCELLED`, removing its
   run-rate once, and writing one `subscription.canceled` billing event
   (`BillingService.cancelFromStripe`). A repeat delivery writes nothing more.

- Cancelling "at period end" is wrong here: the customer would keep service for the paid year
  they were refunded for.
- OPEN: what the customer can still do after the tenant is `CANCELLED` (read their data, export
  it), and for how long. State it so staff can tell the customer.

## 4. Record it

The code has no refund event: the refund itself is not seen by RouteFlow, only the cancellation.

1. Write the record in the place the lead names (see OPEN). It must hold: tenant slug (or
   `acme` in examples), the date, "yearly 14-day refund, full amount, subscription cancelled
   immediately", and the staff member who did it.
2. Do not put the refund amount from a live customer, or any real invoice or order number,
   into the repo.

- OPEN: where staff record a refund. There is no admin endpoint that writes a free-form billing
  event or note (the only writers are fixed billing events emitted by the billing code), and the
  tenant has no internal-notes field. Options: a new admin note, a new billing event type, or
  the provider note plus a ticket. Which one, and who builds it, if it is not the provider note?

## 5. Ledger check

1. Wait for the cancellation event (a few minutes). In the admin console open the tenant's
   billing page and confirm the status reads cancelled.
2. Open the platform MRR overview (the admin billing / dashboard page, backed by
   `GET /billing/admin/mrr`). Confirm the total fell by this tenant's run-rate once and that its
   reconciliation line (sum of billing events against the rollup) did not diverge.
3. Confirm the tenant has exactly **one** `subscription.canceled` billing event.
4. If the tenant is still `ACTIVE` after 15 minutes, or the reconcile flag
   (`needsReconcile`) is raised, or you see two cancel events, stop and tell the lead. Do
   not edit rows by hand and do not run any script against production.

- OPEN: where staff read a tenant's billing events. The platform audit-log page and the billing
  page were not confirmed to list `BillingEvent` rows. Which screen shows them, or does the lead
  read them for staff?

- OPEN: the expected size of the run-rate drop for a yearly row. Today the figure for a yearly
  plan is not final (design bug B869, annual divided by 12, ships with the yearly checkout).
  What number should staff expect, and what difference is acceptable?

## 6. Tell the customer

Neutral wording only. This text is co-signed by SA-C (the design's copy owner) and must stay
word for word with the in-app messages: full refund within 14 days, the subscription ends that
day, the refund goes to the original payment method.

> We have refunded your yearly payment in full. Your subscription ended today, and the refund
> goes back to the payment method you used. Your bank decides how long it takes to show.

- Do not promise a number of days for the refund to appear. Do not mention other customers.
- OPEN: who sends it (staff by email or support chat), from which address, and whether the
  wording is final once SA-C signs.

## If something is wrong

- Refunded but not cancelled: cancel at once (step 3), then do the checks in step 5.
- Cancelled but not refunded: refund the payment at once (step 2) if still eligible. If it is
  now more than 14 days, stop and tell the lead.
- Never refund a yearly payment twice. Check the payment's refunded amount before step 2.
