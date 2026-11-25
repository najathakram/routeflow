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
- OPEN (owner decision pending): who may refund a yearly payment, and does a second person approve
  each refund first? Recommended: only a platform super admin, no second approver, every refund
  recorded (R-2). The alternative adds a delay inside the 14-day window.

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

- Eligible if the request arrives no more than 14 x 24 hours after the yearly payment's paid time
  shown in the provider dashboard (UTC). Day 14 counts up to that same clock time.
- OPEN (owner decision pending): if the customer also paid for an add-on or an upgrade during
  those same 14 days, is that refunded too? Recommended: yes, every charge on that yearly plan paid
  within the 14 days, because the plan ends that day. The alternative refunds only the yearly
  payment.
- A year sold by RouteFlow invoice is refunded in full by the original method (bank transfer or
  check), outside the app. Staff then end the manual activation in the admin console and record
  it as in step 4.

## 2. Refund the whole payment

1. In the provider dashboard, open the yearly payment and choose **Refund**.
2. Choose the **full amount** shown. Do not type a different amount.
3. Pick the reason "requested by customer". Add a short note with the tenant slug and today's
   date. Do not put the customer's name or card details in the note.
4. Confirm. The refund goes back to the original payment method.
5. Wait until the provider shows the refund as succeeded. If it shows failed or pending
   for more than a few minutes, stop and tell the lead.

- OPEN (owner decision pending): what happens when the refund fails (card closed)? Recommended:
  tell the owner, then pay it back by bank transfer once the owner approves. Never retry on a
  different card. The alternative is that the owner handles every failed refund personally.

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
- After cancel the tenant follows the standard cancelled-tenant access and retention rules.
  Nothing is special for yearly.

## 4. Record it

The code has no refund event: the refund itself is not seen by RouteFlow, only the cancellation.

1. Write the record. It must hold: tenant slug (or
   `acme` in examples), the date, "yearly 14-day refund, full amount, subscription cancelled
   immediately", and the staff member who did it.
2. Do not put the refund amount from a live customer, or any real invoice or order number,
   into the repo.

- Build gap, taken by PR R-2 (before yearly is turned on): an admin "Record staff refund" action
  writes one `refund.staff` billing event (provider refund id, amount shown by the provider, reason,
  eligibility time) and one audit-log row. It moves no money. Until R-2 is merged, do not sell
  yearly: there is no place to record a refund.

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

- Build gap, taken by PR R-2: the admin tenant billing page will list that tenant's billing events,
  newest first.

- The run-rate drop equals the yearly price divided by 12, as shown on the plan. Before the yearly
  checkout ships (design PR-4) there are no yearly checkouts, only RouteFlow-invoice or manual rows.

## 6. Tell the customer

Neutral wording only. This text is co-signed by SA-C (the design's copy owner) and must stay
word for word with the in-app messages: full refund within 14 days, the subscription ends that
day, the refund goes to the original payment method.

**Message 1, refund done:**

> We have refunded your yearly payment in full. Your subscription ended today, so you won't be charged
> again. The refund goes back to the payment method you used, and your bank decides how long it takes
> to show.

**Message 2, request after day 14 (no refund):**

> Your yearly payment was made more than 14 days ago, so it can't be refunded. Your plan stays active
> until {renewalDate}, and you can cancel any time so it doesn't renew.

- Staff read {renewalDate} from the tenant's billing page. Never work it out.
- Do not promise a number of days for the refund to appear. Do not mention other customers.
- A platform super admin sends it by email from the support address the app uses for billing mail.
- The wording is final with these two messages (SA-C co-sign, comment 7173251037).
- If owner box B is answered "refunded too", message 1 and the in-app S7 text change together
  (SA-C's wording is in that comment).

## If something is wrong

- Refunded but not cancelled: cancel at once (step 3), then do the checks in step 5.
- Cancelled but not refunded: refund the payment at once (step 2) if still eligible. If it is
  now more than 14 days, stop and tell the lead.
- Never refund a yearly payment twice. Check the payment's refunded amount before step 2.
