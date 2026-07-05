# Messaging — Implementation Spec

> Where messaging lives, how it's wired, and how it's metered. Designs: `unified/messages.html`
> (operator inbox), `unified/buyer-messages.html` (buyer thread), `unified/settings-notifications.html`
> (event × channel matrix + templates), multi-channel order-send modal (`action-modals.html`),
> meters in `settings-billing.html` / bills hub.

## 1. Where messaging applies

1. **Outbound transactional** (automatic): order confirmed · out-for-delivery + ETA + track link ·
   delivered + POD · order changed at door · invoice sent (email only) · payment reminders
   (3d before / due / 7d overdue) · license expiry (30/7/1d) · failed delivery reason + new ETA ·
   standing-order skips/price-review pauses. Configured per event × channel in Settings →
   Notifications; rendered from templates with variables.
2. **Outbound manual**: multi-channel order send (WhatsApp/SMS/Email per available contact info;
   invoices are email + mark-as-sent only), payment reminder button, quick replies from a thread.
3. **Two-way conversations**: any customer reply (WA/SMS/portal) opens/continues a **thread** —
   one per customer per tenant. Operator inbox = Messages nav item; buyer side = Messages in the
   portal. Threads can carry structured context chips (order updated, credit note issued, issue
   report) and support acting from chat ("Add to order…").

## 2. Data model

- `threads` (tenant, customer, last_msg_at, unread_by_operator/by_buyer)
- `messages` (thread, direction, channel `WA|SMS|EMAIL|PORTAL`, body, template_id?, attachments,
  context_ref {order|invoice|credit_note|issue}, provider_msg_id, status
  `QUEUED|SENT|DELIVERED|READ|FAILED`, error, sent_by, created_at)
- `notification_rules` (tenant, event, channel, enabled) — the settings matrix
- `templates` (tenant, event, channel, body w/ `{{vars}}`, wa_template_ref, version)
- `optouts` (customer, channel, at) — STOP handling; surfaced on the customer record
- `message_usage` (tenant, cycle, sends_count) — WA+SMS only; email/portal free

## 3. Provider wiring

- WhatsApp Business API + SMS via provider adapters; per-tenant sender identity; webhooks update
  message `status` (delivered/read/failed) → realtime tick marks in threads.
- Inbound webhooks map sender → customer (phone match) → thread; unknown numbers create a
  triage row with "link to customer / create customer" (dupe check applies).
- WA template messages used outside the 24h session window; free-form inside it; SMS fallback
  when WA unavailable (rule: channel priority per event, first available contact wins).
- Portal messages are plain socket-fed rows in the same thread (also push notification).

## 4. Metering & billing

- WA + SMS sends decrement the included **200/mo**; `MSG_BUNDLE_500` packs (+$10/mo) stack.
- Meter shown in Settings → Plan & Billing and in the Messages header. Cap behavior mirrors AI
  scans: the in-flight send completes, then an inline pack prompt; email/portal never metered.
- Delivery notifications triggered by drivers (out-for-delivery etc.) count to the tenant meter.

## 5. Rules & edge cases

- **Opt-out**: STOP disables that channel for that customer (auto-reply confirmation); rules
  matrix falls through to the next enabled channel; opt-in state shown in thread header.
- **Quiet hours**: per-tenant window (default 9 PM–7 AM) — automatic sends queue until morning;
  manual sends warn.
- **Acting from chat** writes real records (order lines, credit notes) with context chips in the
  thread and entries on the order/invoice timeline — chat is a surface, never a side channel.
- Offline queue applies (driver-triggered sends queue with the run's other actions).
- Retention: threads kept forever, exportable; provider IDs stored for dispute/audit.

## Acceptance
- [ ] Matrix toggles drive real sends; templates render variables; WA/SMS/email/portal all land.
- [ ] Replies (any channel) open one thread per customer; unknown numbers triaged; STOP honored.
- [ ] Meter counts WA+SMS only; cap completes in-flight send then prompts a pack inline.
- [ ] "Add to order…" from chat updates the draft/order and stamps both timelines.
- [ ] Invoice channel policy enforced: email + mark-as-sent only (no WA/SMS invoices).
