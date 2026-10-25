# Handoff 2026-10-04 (STOP, account switch): WS9 / invoice-money + security lane (Sonnet)

Rules: no --no-verify, never bugs.mjs, no merge/flip, one heavy job per lane, security PRs generic on GitHub.
Chains: scratchpad chain-push.sh (existing branch, args wt branch localSha remoteSha masterSha) / chain-push-new.sh (new branch); run gates then push WITH verify; stop on one deterministic failure.

## Security (priority 1)
- S1 PR #3190 fix/customer-self-service-allowlist (worktree sec-s1). REMOTE @32133088 has: /buyer/me pick + parity spec (the lead's 2 folds). LOCAL ONLY @ca3c6ddb (verified 18/18 + buyer/customers 61 suites, chain NOT run, killed): SA-653 = PickType-derived UpdateBuyerProfileDto, ONE list (self-service-fields.ts) for DTO + pick, notes excluded, StripHtml on UpdateCustomerDto.displayName. NEXT: chain-push.sh ... d1c32a5c->ca3c6ddb, remote 32133088.
- S3 branch fix/template-input-validation (worktree sec-s3) LOCAL @2b4a5983, NOT pushed, base master ab3828fa: buyer PATCH template takes UpdateOrderTemplateDto; assertPositiveTemplateQty (template-qty.ts) in create/update/addItem/createOrderFromTemplate. 12/12 red-first, 3 mutations red. NEXT: chain-push-new.sh then generic draft PR "template input validation".

## Invoice-money
- #3135 B1030 fix/invoice-discount-exceeds-subtotal @1ad2d73b pushed. TODO (lead's 3 folds, release blocker): storedInvoiceTotals returns undefined unless subtotal/discount/total all finite (+spec); error message names the worsened axis; storedInvoiceTotals unit test (null, Decimal, missing).
- #3161 B1031 fix/price-adjustment-negative-line remote @d3ead947; LOCAL @21a60e2a (merge of #3135 1ad2d73b + NOT-WORSE re-price). TODO MED1: "Invoice X:" prefix on tx-side refusal + {applied, refused[]} result, race pin invoice 2 of 3.
- B1043 fix/recalc-category-tax-exempt (worktree inv-discount) @88c0c97f local; re-merge #3135.
- #3052 (b975-final) / #3031 (b985-final) local merges of #3017 @202fd7a6; re-merge after #3017 squash.
## Other
#3117 B1008 @da47e147 (folds moved to MacBook). B1014 worktree b1014 @61f1a1a0 parked. Business-profiles API + B1048 queued.
