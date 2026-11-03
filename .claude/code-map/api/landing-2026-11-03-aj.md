# Api landing 2026-11-03, train aj (merge commit `9dfd480c30`, range `d6d5c56cb1..9dfd480c30`; train PR #4156, train head `4dfc961d20`)

Paths under `apps/api/` unless they start with `apps/web/` or `apps/mobile/`. Five members: #4148 `1bc04b9457` (web only), #4147 `7c4d435832` (docs only), #4150 `2596cae347` (api), #4151 `929d80453a` (web only), #4152 `8a5019a3a0` (web + one mobile manifest row). **No migration** (no `apps/api/prisma/` path), no cron, no plan flag or addon gate, no new env var, no route. Web side: `web/landing-2026-11-03-aj.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4150 `2596cae347` Stripe payment-state read within Stripe's expand depth (B1270, SA-1095)

Rule: a Stripe `expand` list never goes deeper than four levels. `StripeService.getSubscriptionPaymentState` asked for five (`latest_invoice.payments.data.payment.payment_intent`), Stripe refused it, and the reader rethrows every error except a missing subscription, so its one caller `cancelSupersededUnlessProcessing` (B1158, the park-or-cancel step for a second paid checkout over a live subscription) threw every time against real Stripe.

- `billing/stripe.service.ts`: the read expands `latest_invoice.payments` and fetches each PaymentIntent by id; a failed read still throws, so it never reads as "not processing".
- `testing/stripe-expand-rule.ts` (new): `STRIPE_MAX_EXPAND_LEVELS = 4`, `stripeExpandLevels`, `assertStripeExpandable`. The fakes in `stripe.service.payment-state.spec.ts` and `stripe.service.invoice-facts.spec.ts` now refuse what Stripe refuses.
- `billing/stripe-expand-depth.pin.spec.ts` (new, class pin): reads every `expand: [...]` list and `*_EXPAND` constant in `src` and `scripts` and fails on a path deeper than four levels; has a detector self-test and a not-vacuous check.
- Open after merge: the card half of the real Stripe proof and the owner's two-tab run (row 456) are by hand; the park path runs for the first time against real Stripe once this ships.

## #4148, #4147, #4151, #4152

- #4148, #4151: no api source; see `web/landing-2026-11-03-aj.md`. #4152: web plus `apps/mobile/lib/route-parity-manifest.ts`. #4147 `7c4d435832`: docs only (landing notes for train af).
