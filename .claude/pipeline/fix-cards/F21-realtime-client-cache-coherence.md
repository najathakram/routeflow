# F21 · Realtime and client cache coherence

**Bug IDs (9):** B76, B77, B86, B93, B104, B113, B114, B115, B139

**Root cause:** Query keys that omit their tenant/seller identity, mutations that invalidate only their own domain, and a socket layer with no reconnect catch-up. Buyer sockets join NO ROOM AT ALL, so every buyer realtime listener on web and mobile is dead code (B104). Worse than the register states: web sets reconnectionAttempts:5 (lib/socket.ts:25) with no reconnect_failed listener, so ~5s of network trouble kills live updates PERMANENTLY for that session with no visible signal; mobile already has the correct config (Infinity + 30s backoff) — match mobile. On the buyer side: every ["buyer", ...] query key omits the seller while buyer-api-client.ts:24-31 reads the active seller from localStorage at request time — prefix the keys with the seller slug rather than only clearing on switch.

**Ships as:** One PR.

**Files:** gateways/routeflow.gateway.ts · web/lib/socket.ts · web/lib/api/{invoices,buyer,returns,orders}.ts · useRealtimeUpdates.ts · useSocket.ts · buyer-auth-context.tsx

**Together because:** One class of cache/socket coherence defect across many query keys and the socket layer.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F21.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B76  | T2   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B77  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B86  | T2   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B93  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B104 | T2   | 0cd59277       | TOKEN_NOT_FOUND     |
| B113 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B114 | T2   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B115 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED |
| B139 | T2   | 0b2c3a0a       | AMBIGUOUS_FILE      |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B76 — Recording a payment doesn't refresh the linked order's cached invoice status

**Area:** apps/web invoice mutations + realtime handler

**Meant to do:** Recording, updating or voiding a payment is reflected promptly wherever that invoice's status shows — including the linked order's Invoice card, for the acting operator and anyone watching live.

**Actually does:** The three payment mutations' onSuccess invalidate only ['invoices'] and ['invoices', id], and the invoice.updated socket handler does the same. The order detail page renders each invoice's status badge straight from order.invoices inside the ['orders', id] cache, which none of them invalidate; with refetchOnWindowFocus false and a 30s staleTime, nothing else refreshes it either.

**The gap:** The order page's invoice badge can show an unpaid status indefinitely while mounted, after the payment has already been recorded and the server has flipped the status and emitted the event.

**Evidence:** apps/web/lib/api/invoices.ts:554-564, :580-590, :592-602; apps/web/lib/hooks/useRealtimeUpdates.ts:92-98; apps/web/app/(dashboard)/orders/[id]/page.tsx:3249-3290 and apps/web/lib/api/orders.ts:192-198; apps/web/app/providers.tsx:48-49; apps/api/src/invoices/invoices.service.ts:4350-4371 (status flip + emit).

**Suggested fix:** Add `invalidateQueries({queryKey:['orders', invoice.orderId]})` (and the admin key) to the three payment mutations and to the invoice.updated handler — carrying orderId on the socket payload, or invalidating order queries by predicate.

### B77 — Buyer portal query cache isn't seller-scoped — another seller's data renders after switching

**Area:** apps/web/lib/api/buyer.ts + lib/buyer-auth-context.tsx

**Meant to do:** Switching the active seller in the buyer portal immediately reflects that seller's own data everywhere — dashboard, orders, promotions, catalog, active-order banner.

**Actually does:** setActiveSeller writes localStorage and local React state only (no invalidateQueries, no useQueryClient in the file), while every buyer query key omits the seller/tenant and the API client derives X-Tenant-Slug from localStorage at request time. The identical cache entry therefore serves whichever seller was fetched last for the whole staleTime window.

**The gap:** Cache identity is per-query-shape, not per-seller: within the stale window a switch renders the OLD seller's data under the NEW seller's branding with no network request at all (staleTime suppresses the refetch entirely, not just delays it).

**Evidence:** apps/web/lib/buyer-auth-context.tsx:113-116 (setActiveSeller, no invalidation); apps/web/app/buyer/portal/layout.tsx:234-237; apps/web/lib/api/buyer.ts:201, 208, 218, 228, 244, 270, 306, 376, 403, 420, 427, 578 (unscoped keys); apps/web/lib/buyer-api-client.ts:19-35; apps/web/app/providers.tsx:48 (staleTime 30s, some hooks 60s/5min).

**Suggested fix:** Prefix every buyer query key with the active seller's tenant slug, or call `queryClient.resetQueries({queryKey:['buyer']})` inside setActiveSeller.

### B86 — Stock-changing mutations skip product/inventory cache invalidation

**Area:** apps/web + apps/mobile returns and vendor-bills mutations

**Meant to do:** A mutation that changes stock invalidates the products/inventory query cache so those views reflect it.

**Actually does:** useMarkReturnReceived and useVoidVendorBill invalidate only their own domain's keys, never products or inventory, despite both writing currentStock server-side. useReceiveVendorBill in the same file does it correctly.

**The gap:** Products and Inventory views stay stale after a return receive or a vendor-bill void, on both surfaces.

**Evidence:** apps/web/lib/api/returns.ts:167-177 and apps/mobile/lib/api/returns.ts:149-164 (no products/inventory invalidation); apps/api/src/returns/returns.service.ts:258-284 (stock increment); apps/web/lib/api/vendor-bills.ts:322-332 (void) vs :289-309 (useReceiveVendorBill, the correct pattern); apps/api/src/vendor-bills/vendor-bills.service.ts:1049-1113 (void decrements stock).

**Suggested fix:** Add products and inventory invalidations to both mutations' onSuccess, matching useReceiveVendorBill.

### B93 — Saving order line-item edits writes an incomplete order into the cache

**Area:** apps/web/lib/api/orders.ts + orders/[id]/page.tsx

**Meant to do:** Saving a line-item edit keeps the order page's other cards (Invoice, credit notes, revisions, change requests) showing what they showed before, until fresh data arrives.

**Actually does:** useUpdateOrderItems' onSuccess does `setQueryData(['orders', id], data)` with the raw PATCH response, whose include covers only customer, lineItems+product and transaction — omitting invoices, orderCreditNotes, revisions, changeRequests and routeRun, which the page reads directly off `order`.

**The gap:** For one round trip after every items-save those fields are undefined, so the Invoice card renders "No invoice has been generated for this order." for an order that has one, and the credit-note/revision/change-request UI shows empty states. Mobile's equivalent hook invalidates instead and doesn't share the bug.

**Evidence:** apps/web/lib/api/orders.ts:431-445; apps/api/src/orders/orders.service.ts:3589-3600 (PATCH include) vs :331-410 (findOne's full include); apps/web/app/(dashboard)/orders/[id]/page.tsx:3250, :3316-3323; apps/mobile/lib/api/orders.ts:420-452 (invalidateOrderCaches, the correct pattern).

**Suggested fix:** Either broaden the PATCH response include to match findOne's, or switch onSuccess to invalidateQueries as mobile does, instead of seeding the cache with a partial order.

### B104 — Buyer-portal sockets join no room — buyer realtime never delivers

**Area:** Buyer portal · realtime (web + mobile)

**Meant to do:** A logged-in buyer should receive live order-status, invoice, credit-note, and delivery pushes; both web and mobile ship hooks (useBuyerNotifications, useBuyerSocket) written for exactly this.

**Actually does:** handleConnection branches only on payload.role; BuyerJwtPayload has no role (or tenantId), so buyer sockets authenticate (same jwtConfig.secret) but join zero rooms. All 17 gateway emits are room-scoped — nothing reaches them.

**The gap:** Every buyer realtime listener on web and mobile is dead code; buyers see changes only on reload or polling. Room model was never adapted for BuyerAccount/CustomerLink.

**Evidence:** apps/api/src/gateways/routeflow.gateway.ts:158-183 (role-only branches, buyer matches none), 200-275 (every emit is .to(room); grepped — no broadcast emit exists), 232/243/250 (customer room keyed by Customer.id, unmatchable by BuyerAccount.id sub); apps/api/src/buyer/interfaces/buyer-jwt-payload.interface.ts:1-10 (no role/tenantId); apps/api/src/buyer/buyer-auth.service.ts:655-668 (signed with jwtConfig.secret — verify succeeds); apps/web/lib/hooks/useBuyerNotifications.ts:72-135 and apps/mobile/hooks/useBuyerSocket.ts:60-138 (listeners registered, never fire); only one WebSocketGateway repo-wide.

**Suggested fix:** In handleConnection, detect type==="BUYER", resolve the buyer's active CustomerLinks, and join buyer:{buyerAccountId} plus tenant:{tenantId}:customer:{customerId} per link; or emit to a buyer room keyed by BuyerAccount.id from the customer-facing emitters.

### B113 — Sockets authenticated once at connect — never re-validated, revoked, or expired

**Area:** Realtime · API gateway + web client

**Meant to do:** Realtime access should be bounded like REST access (15-minute JWT): role change, tenant removal, deactivation, or session expiry should cut the live channel promptly.

**Actually does:** handleConnection verifies the JWT once and joins rooms; nothing anywhere ever disconnects an authenticated socket, so it keeps receiving tenant broadcasts for as long as the transport stays up.

**The gap:** No re-auth timer, no revocation hook, no forced disconnect on user changes — token exp is only enforced if the transport happens to drop.

**Evidence:** apps/api/src/gateways/routeflow.gateway.ts:158-183 (single jwtService.verify at :166; the only client.disconnect is the auth-failure catch at :181; grep confirms no other disconnect/setInterval/middleware in gateways/ and no fetchSockets/disconnectSockets anywhere in apps/api/src); apps/api/src/config/configuration.ts:112 (expiresIn default 15m) + apps/api/.env.example:32; apps/web/lib/api-client.ts:147-294 (refresh interceptor, zero socket references); apps/web/lib/socket.ts:20-26 (auth token captured once at connect).

**Suggested fix:** Add a server-side sweep (or per-socket timer) that disconnects sockets whose token exp has passed, and force-disconnect a user's sockets on role change/deactivation; have the web client reconnect the socket with the fresh token after api-client refresh.

### B114 — No catch-up refetch on socket reconnect — events during any disconnect window are lost

**Area:** Realtime · web + mobile clients

**Meant to do:** After a disconnect/reconnect cycle (API redeploy, network blip, sleep/wake) the client should refetch queries that could have changed, since the socket is its only live-update channel.

**Actually does:** Web registers no "connect" handler at all; mobile's is log-only. With refetchOnWindowFocus:false (web) and an unconfigured QueryClient with no NetInfo/AppState wiring (mobile), missed events never surface until manual navigation/reload.

**The gap:** Reconnect is treated as invisible; no invalidateQueries fires, so the dashboard silently shows pre-outage data while appearing live.

**Evidence:** apps/web/lib/hooks/useRealtimeUpdates.ts:13-133 (per-event handlers only, no on("connect")); apps/mobile/hooks/useSocket.ts:131-133 (connect handler = dbg log) and :55-197 (no reconnect invalidation); apps/web/app/providers.tsx:48-49 (staleTime 30s, refetchOnWindowFocus:false); apps/mobile/app/_layout.tsx:38 (new QueryClient() default config); grep of apps/mobile: zero onlineManager/focusManager wiring.

**Suggested fix:** Add socket.on("connect") handlers that skip the very first connect and otherwise invalidate the realtime-fed query key families; wire mobile's focusManager/onlineManager to AppState/NetInfo.

### B115 — Failed restock push still consumes the buyer's Notify-me alert

**Area:** Stock alerts · buyer portal + push

**Meant to do:** A buyer who taps Notify-me is told when the product restocks; if delivery fails, the standing request survives or is visibly marked failed.

**Actually does:** The alert is flipped PENDING→NOTIFIED before the push; a push throw is caught with a warn, notified still increments, the bell shows unsubscribed, the seller's waiting counter drops, and the buyer hears nothing.

**The gap:** Notification state is committed before delivery is attempted, with no failure record and no retry — worse, no-token buyers never even reach the catch.

**Evidence:** apps/api/src/stock-alerts/stock-alert.service.ts:105-128 (claim-then-push, swallow, unconditional notified+=1) and 82-87 (doc admits entry is cleared on failure); apps/api/src/inventory/inventory.service.ts:51-56 (fire-and-forget wrapper); apps/api/src/notifications/notifications.service.ts:146-151 and 80-85 (silent return on no linked user / zero device tokens); web subscribed-state from same rows: apps/web/lib/api/buyer.ts:666-668.

**Suggested fix:** Flip to NOTIFIED only after sendToCustomer reports at least one successful delivery (sendToUser already returns a success count); on zero successes revert or mark the alert FAILED so it can re-fire on the next restock.

### B139 — Buyer sign-out leaves the legacy Google token behind and bounces straight back into the portal

**Area:** Buyer portal · web

**Meant to do:** Clicking Sign out in the buyer portal ends the session: the browser holds no buyer identity and the login form is shown so the next person must authenticate.

**Actually does:** For Google-signed-in buyers, logout removes only the namespaced rf:buyer:* keys. The surviving legacy buyerAccessToken re-authenticates the provider on remount, and /buyer/login pushes straight back to /buyer/portal as the previous buyer.

**The gap:** Sign-out clears one of two token stores while the reader falls back to the other, so the session survives its own logout on a shared browser.

**Evidence:** apps/web/lib/buyer-auth.ts:35-37, :56-59 (getBuyerAccessToken falls back to the legacy key), :61-71, :118-143 (buyerLogout never removes the legacy keys); apps/web/app/(auth)/auth/google/callback/page.tsx:130-135 (writes namespaced AND legacy keys); apps/web/lib/buyer-auth-context.tsx:46-51, :102-107; apps/web/app/providers.tsx:57; apps/web/app/buyer/login/page.tsx:43-47; apps/web/app/buyer/portal/layout.tsx:154-159; apps/web/middleware.ts:89,135-139 (no cookie guard — the client context is the only gate); only e2e/helpers/auth.ts:103-104 ever removes the legacy keys. Commit 179dcb29 (#470) kept the legacy double-write and warned it "could resurrect logged-out OAuth sessions"; the logout side was never fixed.

**Suggested fix:** Remove buyerAccessToken / buyerRefreshToken / buyerActiveSeller inside buyerLogout() alongside the namespaced keys; better, drop the legacy fallback in getBuyerAccessToken() now that the migration window has closed and delete the callback's double-write.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
