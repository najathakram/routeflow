# F07 · UX spec — two copy surfaces, zero new components

**Status: IMPLEMENTED — proven, pending merge** · Design system: existing tokens only (no `design-system.md` needed —
both surfaces reuse in-file, already-shipped patterns; nothing new is invented).

## 1. B10 — "editing closed" banner, operator order detail

File: `apps/web/app/(dashboard)/orders/[id]/page.tsx` (~:2291-2296).

Reuse the EXACT existing pill (`inline-flex items-center gap-1 rounded-full bg-amber-50 px-2
py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200`) — only the render condition
and copy change:

- Condition: `!canEdit && order?.editWindow?.closedReason && !isEditing` (was `=== "DISPATCHED"`).
- Copy by reason:
  - `"DISPATCHED"` → `Out for delivery — editing closed` (unchanged string; buyer-semantics
    value kept for robustness).
  - anything else (today: `"STATUS"`, i.e. CANCELLED) → `Order cancelled — editing closed`.
- Comment fix: the stale `{/* P5-08: editing closed once the order is out for delivery
  (dispatched). */}` is replaced with one that matches the API's actual semantics (staff:
  editable unless CANCELLED → "STATUS"; buyer: closed once dispatched → "DISPATCHED"), aligned
  with the P5-08/R1 comment at ~:1759.
- States: banner appears only when the API says the window is closed; no loading/empty state
  (absence of `editWindow` renders nothing, as today). A11y: plain text in a span — no change.

## 2. B56 — cancel-blocked copy, web + mobile mirrors

Files: `apps/web/lib/cancel-impact.ts`, `apps/mobile/lib/cancel-impact.ts` (byte-mirrored per
the file's own header), `apps/web/lib/api/orders.ts` (type only).

`CancelImpactLike` gains `deliveredUnits: number` (additive). In `describeCancelImpact`, the
`!impact.canCancel` branch becomes reason-aware:

- `blockingPayments.length > 0` → existing paid-block copy, byte-identical.
- else if `deliveredUnits > 0` → title `Can't cancel`, blockedReason:
  `Some items on this order have already been delivered. Record a return for the delivered
  goods, or edit the order down to the undelivered items instead of cancelling.`
  `confirmLabel: null`.
- else (unknown reason, future-proof) → generic `This order can't be cancelled right now.`

Server error copy (`assertCancellableOrThrow`, delivered branch):
`This order has delivered items (<N> unit(s) already delivered). Cancelling would erase revenue
for goods the customer already has. Record a return for the delivered goods, or edit the order
down to the undelivered items instead.`

No layout, component, token or a11y changes anywhere. Playwright screenshot proof: covered by
the T2 spec-27 flow post-deploy (banner assert); the cancel dialog copy is pure-function-tested
(mobile jest mirror) per D1.
