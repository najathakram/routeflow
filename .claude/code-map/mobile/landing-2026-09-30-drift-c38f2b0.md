# Landing batch 2026-09-30 — drift c38f2b0 (mobile side)

Docs-only bookkeeping (Option B), mobile side of the earlier-landings batch; API/web/tooling are in
[../api/landing-2026-09-30-drift-c38f2b0.md](../api/landing-2026-09-30-drift-c38f2b0.md). #2741, #2782, #2776, #2769 and #2771 did not change mobile runtime code.

- **#2778 (#2600):** `apps/mobile/components/OrderAppliedCredits.tsx` replaces its inline `Requested ${money(row.requested)}` / "Up to remaining" ternary with `requestedLabel(row, money)` from `@routeflow/types` (same wording as web). No new mobile spec (pure-logic coverage lives in the api-side `order-applied-credits.spec.ts`).
- **#2774 (SA-551a):** `apps/mobile/lib/api/admin.ts` `AdminOrder` credit-payment type gains `createdAt?: string | null` so the dated fallback in `orderAppliedCredits` sees it. Type-only.
- **#2664 (#2495):** `apps/mobile/app/(auth)/login.tsx` Google error branch: new `code === "google_account_mismatch"` -> `setApiError("This Google account doesn't match the one already linked to this email. Sign in with your linked Google account or your password.")`. No mobile spec.
- #2782, #2776, #2769, #2771: none (no `apps/mobile` files; #2769's mobile `short-pick.ts` / `returns-logic.ts` callers of `prorateLineSubtotal` were NOT changed, see B894 bug file location list; worth a follow-up check).
