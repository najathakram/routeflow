# payment-due-banner (branch fix/payment-due-banner, worktree C:/ClaudeCode/rf-paydue)
## Done
- Labels: describeStub/describeStubPeriod in catchup-plan.ts -> "October 2026 subscription"; specs updated.
- Plan names: platform-pricing.service.ts, scheduled-price-change.ts, plan-change-stripe.ts -> "RouteFlow {plan}" (no dash). Add-on names left alone.
- API: payment-due.service.ts/.controller.ts (GET /billing/payment-due, POST /billing/payment-due/pay), PAYMENT_NOT_DUE code (api + packages/types), read-only registry allow-list + pin, module wiring, CatchupCheckoutService.open successUrl/cancelUrl opts.
## Next
- Web: lib/payment-due.ts (copy model), lib/api/payment-due.ts hooks, PaymentDueBanner, subscription-banner-state slot fn, BillingShellBanner + layout wiring, billing page ?paid=1 notice; RTL tests.
- check-types + lint both workspaces; final report.
## Decisions / open questions
- 2b (billing_cycle_anchor instead of trial_end) NOT done: Stripe Checkout rejects a one-time line with proration_behavior none (pinned by assertCheckoutAcceptable, R5-4); without it the anchor prorates and double charges. Keep trial_one_time.
- Banner shows for EVERY eligible manual-invoicing PRODUCTION tenant once deployed (no per-tenant opt-in). Owner to confirm.
- Failed-renewal variant replaces SubscriptionStrip kinds grace/overdue only; final-day and read-only keep the strip.
