# PR-6 — list state, product↔movements, WhatsApp PDF, SMTP diagnostics

**Status:** IMPLEMENTED — shipped 2026-08-18/19; see the PR for the verified final shape
**Scale:** major (mobile + api; the SMTP part changes how mail is sent for every tenant)
**Sources of truth:** `.claude/pipeline/decisions/2026-08-18-batch-architecture.md` **§PR-6** (binding) and `docs/plans/mobile-ux-batch-2026-08-17.md` §PR-6. Decisions doc wins on conflict.

This is the last PR of the batch. **The SMTP work is deliberately the final commit** (owner instruction) — it is the one change that alters mail delivery behaviour for every tenant, so it lands after everything else is proven.

## Context

Four owner-reported items, grouped because they are the remainder.

1. **The products list forgets everything.** Search, filters and scroll position die on every remount, so drilling into a product and coming back means finding your place again. (Web's half of this shipped in #351.)
2. **Products and stock movements don't link.** There is no way from a product to its movements or back, and the Warehouse quick-action labelled "Movements" **navigates to the products list** — that mislink is why `app/(operator)/movements.tsx` looks orphaned.
3. **WhatsApp sends a text link, not the invoice.** The PDF exists; the share path just never attaches it. Worse, the existing `window.open` fallback fails **silently**.
4. **SMTP failures are unreadable.** `/settings/email/test` throws away the mapped diagnostic that `/settings/email/verify` already produces, and when Resend rescues a failed tenant SMTP send nobody is told the tenant's own mail is broken — or that the From address silently changed.

## Non-goals / do not touch

- **No Prisma migration.** No schema change.
- Do NOT touch `pricing.ts`, drafts (PR-3), van sale (PR-4), the scan ladder, or the scanner memory (PR-5).
- Do NOT implement SMTP OAuth2/Graph — deferred; it needs the owner's Azure app registration.
- Cold reload restoring nothing is **by design** — the snapshot is in-memory only.

## Work packages

### WP1 — products list state restore (`apps/mobile`)

**Files owned:** `apps/mobile/lib/list-ui-snapshot.ts` (new), `apps/mobile/store/listUiStore.ts` (new), `apps/mobile/app/(operator)/products/index.tsx`, `apps/mobile/__tests__/list-ui-snapshot.test.ts` (new)

1. `lib/list-ui-snapshot.ts` — PURE. `ListUiSnapshot { search, filters, scrollOffset, pageCount, savedAt }`, TTL **15 minutes** (a stale snapshot is discarded), `MAX_RESTORE_PAGES = 10`, and a one-shot `stepScrollRestore` helper that yields the next restore step and refuses to fire twice.
2. `store/listUiStore.ts` — in-memory Zustand store keyed by list id (`"operator-products"`), following the conventions of the existing stores in that folder. In-memory only; nothing persists across a cold start.
3. Wire into `products/index.tsx`: lazy-init search/filters from the snapshot, write-through on change, bounded page-chase (stop at `MAX_RESTORE_PAGES` **or ~150 rows, whichever comes first** — and **skip the chase entirely when the snapshot carries a search term or filter**, since those result sets are short), restore offset on `onContentSizeChange` and re-apply on `useFocusEffect` (covers the `display:none` tab case). Abandon the chase on the first user scroll.
4. Also in this file (the plan's commit 1): adopt a **250ms search debounce**, use `flattenPages` from `lib/paged-rows.ts`, add `placeholderData: keepPreviousData` to `useAdminProductsInfinite`, and gate `onEndReached` on `!isPlaceholderData`.
5. Spec the pure module: TTL expiry, the row cap, search-present skip, and that `stepScrollRestore` is one-shot.

### WP2 — product ↔ movements navigation (`apps/mobile`)

**Files owned:** `apps/mobile/app/(operator)/movements.tsx`, `apps/mobile/app/(operator)/products/[id].tsx`, `apps/mobile/app/(operator)/(tabs)/warehouse.tsx`

- `movements.tsx` accepts `{ productId?, productName? }` params and seeds a filter, showing a dismissible banner naming the product.
- Movement rows become tappable → the product detail screen.
- The product detail's movements card gains a "See all" that routes to `movements.tsx` with that product seeded.
- **Fix the Warehouse quick-action** labelled "Movements" that currently routes to the products list — it must go to `movements.tsx`. Verify by reading the handler, not by assuming which one it is.

### WP3 — WhatsApp shares the actual PDF (`apps/mobile`)

**Files owned:** `apps/mobile/lib/share-pdf.ts`, `apps/mobile/lib/invoice-send-logic.ts`, `apps/mobile/components/SendInvoiceSheet.tsx`, `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`, `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`, `apps/mobile/__tests__/invoice-send-helpers.test.ts`

**The trap (binding):** `navigator.share` requires **transient user activation**. Awaiting a PDF fetch between the tap and the call burns that window, so on a slow link _both_ the share sheet and the `window.open` fallback fail — the operator taps and nothing happens at all.

So: **never `await` a fetch between the tap and `share()`.**

- On tap, start the fetch with a busy state ("Preparing PDF…"). If the blob resolves within `ACTIVATION_BUDGET_MS = 3000`, call `share()` immediately.
- Otherwise flip the control to **"PDF ready — tap to share"**; the **second** tap calls `share()` synchronously with the cached `File`.
- The `window.open` fallback obeys the same budget; once expired it toasts with an explicit "Open PDF" action (a fresh gesture).
- `sharePdf` gains `text?` and returns `ShareOutcome = "shared" | "opened-tab" | "ready-await-tap" | "failed"`. **Every failure path toasts** — the current silent `return` is the bug.
- Pure `planWhatsAppSend({ phone, message, canShareFiles })` in `invoice-send-logic.ts`, spec'd for "file ready", "file not ready", and "share rejected".
- Native `expo-sharing` is file-only (text is ignored) — document that; desktop keeps the wa.me text link plus a toast.

### WP4 — SMTP: fail securely, and say what went wrong (`apps/api`) — **LAST COMMIT**

**Files owned:** `apps/api/src/email/email.service.ts`, `apps/api/src/email/email.service.spec.ts`, `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/system-config/settings.controller.ts`

1. **`requireTLS: port === 587 && !secure` on BOTH transports** (send and verify). A 587 server that doesn't offer STARTTLS is accepting the tenant's password in cleartext — failing is correct, and every mainstream host (Gmail, M365) offers STARTTLS. Add a `mapSmtpError` branch for the nodemailer STARTTLS-unavailable failure: _"The mail server didn't offer a secure connection on port 587 — check the host, or use port 465 with the secure toggle ON."_
2. **`smtpFallbackReason`:** `send()`'s return gains `smtpFallbackReason?: string` = `mapSmtpError(...)` captured at the SMTP catch, logging `err.code`/`responseCode` and a **redacted** response. It must be populated in **every** branch — including when Resend rescues the send, which is exactly when today nobody learns the tenant's own mail is broken.
3. Invoice-send responses embed it as a **non-blocking `warning`** (the send still succeeded).
4. **`sendTestEmail`** returns the mapped reason instead of the generic string: SMTP failed + no Resend ⇒ `success: false` with the mapped message; SMTP failed + Resend delivered ⇒ `success: true` **and** the mapped SMTP reason appended — the mail did deliver, say so honestly, then explain the tenant-SMTP problem (for M365 that is the admin-centre Authenticated-SMTP guidance the verify endpoint already produces).
5. Specs: `requireTLS` present on 587 / absent on 465; a mapped 5.7.139 fixture; and the three send shapes (SMTP fails + Resend rescues ⇒ delivered true **with** `smtpFallbackReason`; both fail; SMTP fails with no Resend).

### WP5 — surface the SMTP warning to the operator (`apps/web`)

**Files owned:** `apps/web/lib/api/invoices.ts`, `apps/web/app/(dashboard)/invoices/[id]/page.tsx`, `apps/web/app/(dashboard)/settings/page.tsx`

Render the `warning` from a successful send as a distinct non-error toast/banner: _"Sent via RouteFlow's mail service (from <platform address>) — your own email couldn't send: <reason>."_ The changed From address is part of the disclosure, not a footnote. Settings → Email test-send shows the mapped reason verbatim.

## Acceptance criteria

- [ ] Products list restores search, filters and scroll after a drill-in and after a tab switch; a cold reload restores nothing; the page-chase is bounded by rows AND pages and is skipped when a search/filter is present.
- [ ] The Warehouse "Movements" quick-action reaches the movements screen; product↔movements navigates both ways with the product seeded.
- [ ] No code path `await`s a fetch between the tap and `navigator.share`; a slow link degrades to an explicit second tap, never silence.
- [ ] Every share failure path produces a toast.
- [ ] `requireTLS` is set on both transports for 587-non-secure, with a mapped STARTTLS-unavailable message.
- [ ] `smtpFallbackReason` is populated even when Resend rescues the send, and reaches the operator-facing toast along with the From-address change.
- [ ] `sendTestEmail` never returns the generic string when a mapped reason exists.
- [ ] No Prisma migration; no `pricing.ts` change.

## Verification

```
npx turbo run check-types lint test --filter=@routeflow/api --force
npx turbo run check-types lint test --filter=@routeflow/mobile --force
npx turbo run check-types lint --filter=@routeflow/web --force
npm run verify
```
