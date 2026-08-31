# F23 · Messaging and notification honesty

**Bug IDs (7):** B37, B145, B160, B180, B181, B182, B183

**Root cause:** An engine that records deliveries it never attempted. EMAIL/WHATSAPP/SMS dispatch to a stub that returns "queued" and PORTAL skips the provider entirely, yet all of them write a Message row and return sent (B145). Quiet hours are computed and discarded (B160); four rules ship ON for events nothing fires (B180); rules exist only after someone opens the settings tab (B182); consent has no writer (B183).

**Ships as:** One PR. Approach: make the untransported channels honest FIRST (record skipped, surface "channel not configured"), then wire what is real.

**Files:** notifications/messages engine (per the register's per-bug evidence)

**Together because:** One notification engine, one class of dishonest-status defect.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F23.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B37  | T1   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B145 | T1   | 0b2c3a0a       | FILE_NOT_FOUND      |
| B160 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B180 | T1   | 0b2c3a0a       | OUT_OF_BOUNDS       |
| B181 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B182 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B183 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B37 — Run chat is built server-side, absent client-side

**Area:** Messaging · all clients

**Meant to do:** Drivers and dispatch/operators should be able to send real-time run-scoped chat messages to coordinate during a delivery run.

**Actually does:** A working backend exists (apps/api/src/messages/{messages.service.ts,messages.controller.ts}: POST/GET /messages, INTERNAL channel, findByRun, with messages.service.spec.ts + messages.security.spec.ts) and even a mobile API client (apps/mobile/lib/api/messages.ts: useMessages/useSendMessage) — but both are wired to nothing.

**The gap:** Both apps/mobile/app/(operator)/messages.tsx and (driver)/driver-messages.tsx render the same components/MessagesScreen.tsx, whose comment claims "no /messages endpoint or websocket feed" and shows a hardcoded "Messaging is coming soon" empty state; useMessages/useSendMessage have zero callers anywhere.

**Evidence:** apps/mobile/components/MessagesScreen.tsx:8-24 (comment + hardcoded empty state); apps/api/src/messages/messages.controller.ts:25-34 (POST/GET /messages); apps/mobile/lib/api/messages.ts:27-45 (useMessages/useSendMessage); grep 'useMessages|useSendMessage' over apps/mobile -> only defined, never called.

**Suggested fix:** Replace the MessagesScreen placeholder with a real chat UI wired to useMessages/useSendMessage (poll or socket-driven), removing the stale "not wired yet" comment.

### B145 — The messaging engine records EMAIL and PORTAL notifications as "sent" with no transport behind them

**Area:** Customer notifications · API + web settings

**Meant to do:** Turning on a notification cell in Settings → Notifications makes the customer actually receive it, and a message recorded against a customer means it really went out.

**Actually does:** EMAIL, WHATSAPP and SMS dispatch to a stub provider that logs a line and returns status "queued", never "failed"; PORTAL skips the provider entirely. Both then write a Message row, bump the thread's unread count, and return outcome "sent".

**The gap:** A delivery that never happened is persisted as a delivered message plus an unread-count bump, with no failure signal anywhere.

**Evidence:** apps/api/src/messaging/messaging.service.ts:79-81, :139-151 (only status === "failed" aborts), :153-176 (Message.create + thread bump + outcome "sent"); apps/api/src/messaging/providers/stub.provider.ts:15-22; messaging.module.ts:22 (the only MESSAGE_PROVIDER binding in the repo outside specs); messaging-config.service.ts:78-86 (defaults include INVOICE_SENT:EMAIL, OUT_FOR_DELIVERY:PORTAL, DELIVERED:PORTAL); no EmailService import anywhere under apps/api/src/messaging; GET /messaging/threads (messaging.controller.ts:76-84) has zero client readers, and MessageThread is referenced nowhere outside apps/api.

**Suggested fix:** Make the un-transported channels honest: have the stub return a non-delivered status (or gate provider channels behind a configured-adapter check) so sendMessage records "skipped"/"failed" instead of writing a Message and bumping the thread, and surface "channel not configured" on the matrix cell.

### B160 — The Quiet hours card states messages are held; the engine computes the window and discards the result

**Area:** Quiet hours · web settings + API

**Meant to do:** "Customer-facing messages are held outside this window; internal alerts still send" — with quiet hours on (the default, 21:00–07:00), a customer is not messaged at 02:00.

**Actually does:** The quiet-hours result is assigned to a field that only decorates the returned outcome; dispatch and recording run unconditionally, every caller is fire-and-forget and discards that outcome, and no queue or drain exists.

**The gap:** Settings copy asserts a behaviour that does not exist, with the toggle defaulted ON and no "coming soon" qualifier — a dead control stating a false fact.

**Evidence:** apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx:517-520 (the card and its copy), :482-562 (toggle and Save); apps/api/src/messaging/messaging.service.ts:122-133 (computed), :148 and :175 (its only two uses, both decoration), :139-176 (dispatch and record regardless); grep for the field across apps/api/src, apps/web and apps/mobile returns only the type declaration and those two returns; messaging.helpers.ts:73-87 (uses server-local hours, with a doc comment stating it does not block or schedule, and no timezone parameter); messaging-config.service.ts:224-233 (with no settings row the UI shows enabled/21:00/07:00) vs messaging.service.ts:124-133 (with no row the engine computes false); apps/api/prisma/schema.prisma:2948-2961; callers discard the outcome at orders.service.ts:2401-2407 and routes.service.ts:1770-1777.

**Suggested fix:** Either implement the hold — defer the send and drain after the window closes, evaluated in the tenant's configured timezone rather than server-local time — or reword the card to say quiet hours are recorded but not yet enforced, and stop defaulting the toggle ON.

### B180 — Four notification rules seed ON for events that no code ever fires

**Area:** Notification rules matrix · web settings + API

**Meant to do:** An event row whose channel switch reads ON means that event fires on that channel — an urgent order, a low-stock condition, a failed delivery or a bounced cheque produces an alert.

**Actually does:** URGENT_ORDER_PLACED, LOW_STOCK, FAILED_DELIVERY and PAYMENT_FAILED_NSF are seeded enabled and render as ON, but no call site anywhere passes those keys to the notify helpers.

**The gap:** Four switches ship in the ON position, with editable templates, live preview and Save, for behaviour that has no trigger — toggling them changes nothing either way.

**Evidence:** apps/api/src/messaging/messaging-config.service.ts:12-24 (11 events), :78-86 (the defaults include all four internal alerts), :274-287 (the seed writes enabled from that set); apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx:143-146 ("Toggle which channels fire for each event", no disclaimer), :187-245 (every row gets live switches and a template pencil); the complete trigger inventory from grep covers only 6 of the 11 events — authorization-expiry.service.ts:126,167, invoices.service.ts:3434,3600, change-requests.service.ts:157, orders.service.ts:2366-2407, routes.service.ts:1770,1991 — and grep for the remaining five event keys outside the messaging module returns zero hits.

**Suggested fix:** Either wire the four alerts to their real triggers (urgent-order create, reorder-point cross, stop skip/fail, NSF payment) or seed them disabled and mark unwired events in the matrix, so an ON switch always means something fires.

### B181 — Push isConfigured() is hardcoded true, leaving the "not set up" branch permanently dead

**Area:** Notifications · web + API

**Meant to do:** The Push notifications card tells the operator truthfully whether push is set up, warns when it is not, and disables the test button in that case — all three states ship in the component.

**Actually does:** isConfigured() returns firebaseInitialized || true, so it is always true and the warning branch and disabled state can never render. Push itself IS genuinely available, because Expo is the only transport this app uses.

**The gap:** A constant dressed as a check makes two UI states unreachable.

**Evidence:** apps/api/src/notifications/notifications.service.ts:56-58 (the literal `return this.firebaseInitialized || true;` with an Expo comment), :79-95, :134-137; apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx:594-626 (the badge, the unreachable explainer and a disabled binding that is never true); git log -S shows the `|| true` was added deliberately alongside the Expo path, not left as a debug stub.

**Suggested fix:** Make isConfigured() honest — return firebaseInitialized or an explicit Expo-availability flag — or document push as always-on and delete the dead "Not set up" branch and the disabled binding.

### B182 — Notification rules exist only after someone opens Settings → Notifications

**Area:** Customer notifications · API provisioning

**Meant to do:** A new workspace ships with the documented defaults — invoice-sent by email, out-for-delivery and delivered on the portal — and notifies customers without anyone configuring anything.

**Actually does:** The seeding helper is private and reachable only from the matrix getter, i.e. only via GET /messaging/config, whose sole caller is the web settings tab. Before that visit a tenant has zero rules, so notify() matches nothing.

**The gap:** Identical builds behave in two different modes depending on whether a human once opened a settings page, and nothing tells the operator which mode they are in.

**Evidence:** apps/api/src/messaging/messaging-config.service.ts:132-144 (the only seed call, at :139), :255-294 (the private seeder); apps/api/src/messaging/messaging.controller.ts:88-94; repo grep over apps/api/src, apps/api/scripts, apps/api/prisma and scripts finds no other creator of notification rules or message templates; apps/api/src/messaging/messaging.service.ts:188-190 (notify returns empty on no rules) and :238-263 (the event wrapper logs nothing for an empty rule set); apps/web/lib/api/messaging.ts:59 is the only config caller.

**Suggested fix:** Seed the rule and template matrix at tenant provisioning, or have notify() lazily seed through the same shared helper, so defaults exist before anyone opens Settings.

### B183 — WhatsApp and SMS consent has no writer, so those cells can never fire

**Area:** Messaging consent · API + web settings

**Meant to do:** Consent is a working compliance control: consented customers receive WhatsApp and SMS, and a customer who replies STOP or is unticked stops receiving them.

**Actually does:** The two consent flags default false and no code path writes them, and the opt-out model has a reader and no writer. Enabling a WhatsApp or SMS cell therefore skips on "no consent" permanently.

**The gap:** Both the consent-capture and the opt-out halves of the channel were never built, so a persisted toggle can never produce a send in either direction.

**Evidence:** apps/api/src/messaging/messaging.service.ts:92-116 (the select, the consent gate and the opt-out lookup — the only readers); apps/api/prisma/schema.prisma:791-793 (both flags default false) and :2928-2942 (the opt-out model, with a source comment naming STOP); grep for the consent fields and the opt-out model across all of apps/ returns only the messaging service, its spec, the Prisma test mock and the schema — no endpoint, DTO, form field, import mapping or webhook; messaging-config.service.ts:186-199 (the rule setter accepts these channels); NotificationsSettingsTab.tsx:222-243 (rendered as ordinary switches).

**Suggested fix:** Add operator-editable consent (a customer form field plus a PATCH that stamps the consent timestamp) and a STOP/manual opt-out writer, or grey the WhatsApp and SMS cells with "consent capture not available yet" until the adapters land.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
