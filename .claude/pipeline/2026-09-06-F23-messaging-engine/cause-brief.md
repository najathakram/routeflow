# Cause brief — F23 (B37, B145, B160, B180, B181, B182, B183)

Batch: messaging/notification engine (`apps/api/src/messaging`, `apps/api/src/notifications`,
`apps/api/src/messages` — three distinct modules). Tree read at master (HEAD at time of writing;
`git log -1 --format=%H` = the checkout's current commit; all file:line citations below are against
that tree, not the registry records' original round SHAs). No committed plan exists for F23 — root
cause derived here from the record's claim plus direct code reading.

**One shared seam, six distinct rows.** B145/B160/B180/B182/B183 all root in the same engine
(`messaging.service.ts` / `messaging-config.service.ts`) but are five independent defects at five
different lines — not the same bug filed five times: B145 = the stub provider's fabricated success
status, B160 = the discarded quiet-hours result, B180 = four dead-triggered event keys seeded ON,
B182 = lazy-seed-on-first-GET provisioning gap, B183 = unbuilt consent/opt-out writers. B181 is a
sibling defect in the separate `notifications.service.ts` (push, not messaging). B37 is a wholly
separate module (`apps/api/src/messages` — run-scoped chat) that only shares the word "messaging"
with the others; it is not part of the engine-is-a-stub epic at all.

---

## B37 — Run chat is built server-side, absent client-side

### The bug as stated

**Source (verbatim from the record):** "A working backend exists
(apps/api/src/messages/{messages.service.ts,messages.controller.ts}: POST/GET /messages, INTERNAL
channel, findByRun, with messages.service.spec.ts + messages.security.spec.ts) and even a mobile
API client (apps/mobile/lib/api/messages.ts: useMessages/useSendMessage) — but both are wired to
nothing." … "Both apps/mobile/app/(operator)/messages.tsx and (driver)/driver-messages.tsx render
the same components/MessagesScreen.tsx, whose comment claims 'no /messages endpoint or websocket
feed' and shows a hardcoded 'Messaging is coming soon' empty state; useMessages/useSendMessage have
zero callers anywhere."

**Repro:** input — a driver or operator opens the Messages tab in the mobile app → observed: a
static "Messaging is coming soon" empty state, no compose box, no thread list, regardless of
whether `apps/api/src/messages` has any rows → expected: a chat UI backed by the working
POST/GET `/messages` endpoints.

**Suspected cause (record's claim):** "Replace the MessagesScreen placeholder with a real chat UI
wired to useMessages/useSendMessage (poll or socket-driven), removing the stale 'not wired yet'
comment."

### Code path

Entry point: `apps/mobile/app/(operator)/messages.tsx` and the driver equivalent both render
`MessagesScreen` from `apps/mobile/components/MessagesScreen.tsx:8-24`:

```
// Dispatcher ↔ driver messaging isn't wired yet — no /messages endpoint or
// websocket feed. Show an honest empty state instead of the hi-fi mockup's
// demo threads from "Jamie" and "Luna Roastery".
export function MessagesScreen() {
  ...
  <IosEmptyState ... title="Messaging is coming soon" .../>
```

The comment is stale: a real `/messages` endpoint does exist —
`apps/api/src/messages/messages.controller.ts:21-35` (`POST /messages` → `create`,
`GET /messages` → `findByRun`, both behind `JwtAuthGuard`) — and a mobile client already calls it
via `apps/mobile/lib/api/messages.ts` (`useMessages`/`useSendMessage`, confirmed present by
`grep -rn useMessages|useSendMessage apps/mobile` → only `apps/mobile/lib/api/messages.ts` itself
matches; no screen imports either hook). The divergence is: backend + typed client both exist and
are exercised by their own specs, but the screen component never imports them — it renders a
hardcoded placeholder instead. No file citation is stale here; all lines quoted above match the
current tree exactly.

### History

```
git log --oneline -5 -- apps/api/src/messages/ apps/mobile/lib/api/messages.ts "apps/mobile/app/(operator)/messages.tsx"
ea8a7479 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
ef21ef04 fix(api): authz + input-validation hardening batch (SEC-1) (#285)
f03a59a8 feat(messaging): send engine + StubProvider (P6-2) (#167)
66d550d3 feat(messaging): additive messaging-thread schema (P6-1/F0) (#163)
a9671398 fix(web): UX/UI audit fixes + lockfile resync + LF normalization (#93)
```

The `apps/api/src/messages` module predates the `messaging` engine (P6-1/P6-2) by several commits
— it is an older, independent build, not a byproduct of the P6 messaging work. `MessagesScreen.tsx`
itself has no independent history beyond the mobile re-skin commits; its "isn't wired yet" comment
was authored deliberately at re-skin time (`028f86b0`/`32df1336` mobile re-skin/rescope commits),
not left over from a partial migration.

### Existing tests around this behavior

`apps/api/src/messages/messages.service.spec.ts` and `messages.security.spec.ts` cover the backend
in isolation (server-side only — no mobile-side test exercises `useMessages`/`useSendMessage`, and
no test asserts `MessagesScreen` renders anything beyond the empty state). No test pins the wrong
behavior; the gap is simply untested on the client side because there is no client-side behavior
to test yet.

### Production evidence

None cited in the record; unverified whether any tenant has ever created a `Message` row through
this endpoint (would need a prod query — out of scope for this read-only pass).

### Open unknowns

- **Feature-shaped flag: YES.** This is not a regression — nothing ever "worked and broke." It is
  an unfinished feature: a backend was built, a typed client was built, and the UI was never
  connected. Per D5 this reads as new-feature completion work (wire an existing screen to an
  existing, tested API) rather than a defect with an observable wrong VALUE. S2 should weigh
  whether F23's "AGENT-SAFE, no money/tenancy" framing still fits a change that ships a net-new
  user-facing chat surface (poll vs. socket choice, unread/badge semantics, run-scoping UX) rather
  than a narrow fix.
- Whether `driver-messages.tsx` (record cites it; not independently re-verified above — same
  component import, same comment) has any divergent behavior from `(operator)/messages.tsx`.
- Whether wiring should reuse `INTERNAL` channel semantics from the separate `messaging` engine or
  stay fully independent — the two modules currently share no code.

---

## B145 — The messaging engine records EMAIL and PORTAL notifications as "sent" with no transport behind them

### The bug as stated

**Source (verbatim):** "EMAIL, WHATSAPP and SMS dispatch to a stub provider that logs a line and
returns status 'queued', never 'failed'; PORTAL skips the provider entirely. Both then write a
Message row, bump the thread's unread count, and return outcome 'sent'." … "A delivery that never
happened is persisted as a delivered message plus an unread-count bump, with no failure signal
anywhere."

**Repro:** input — `sendMessage({channel: EMAIL, ...})` (or WHATSAPP/SMS/PORTAL) on a fully
consented, reachable customer → observed: `SendOutcome.outcome === "sent"` and a `Message` row +
thread unread-count bump are persisted, even though no email/SMS/WhatsApp/portal transport exists
→ expected: an outcome that is only "sent" once bytes actually left the system (or an explicit
"no transport configured" signal).

**Suspected cause (record's claim):** "Make the un-transported channels honest: have the stub
return a non-delivered status (or gate provider channels behind a configured-adapter check) so
sendMessage records 'skipped'/'failed' instead of writing a Message and bumping the thread."

### Code path

Entry point: `MessagingService.sendMessage()`, `apps/api/src/messaging/messaging.service.ts:83-176`.

1. For a provider channel (`usesProvider()`, line 79-81: true for everything except
   `INTERNAL`/`PORTAL`), dispatch goes to the injected `MESSAGE_PROVIDER`:
   ```
   139:    if (this.usesProvider(channel)) {
   140:      const res = await this.provider.send({ tenantId, channel, to, body, templateName: input.templateName });
   147:      if (res.status === "failed") {
   148:        return { channel, outcome: "failed", reason: "SEND_FAILED", wouldBeQuiet };
   149:      }
   150:      providerMsgId = res.providerMsgId;
   151:    }
   ```
   The only binding of `MESSAGE_PROVIDER` in the running app is `StubProvider`
   (`apps/api/src/messaging/messaging.module.ts:22`: `{ provide: MESSAGE_PROVIDER, useClass: StubProvider }`)
   — the module's own doc comment (lines 9-15) says real adapters are a later increment, but no
   feature flag or config gate currently prevents this binding from being the one live in
   production. `StubProvider.send()` (`apps/api/src/messaging/providers/stub.provider.ts:15-22`)
   always returns `{ providerMsgId, status: "queued" }` — it has no code path that can ever
   produce `"failed"`.
2. For `PORTAL` (and `INTERNAL`), `usesProvider()` is false, so the provider call is skipped
   entirely (line 139 condition false) — dispatch is a no-op.
3. Both paths fall through unconditionally to record+bump:
   ```
   153:    const thread = await this.upsertThread(customerId);
   154:    await db.message.create({ data: { threadId: thread.id, channel, text: body, senderId, senderRole, runId: null } });
   159:    await db.messageThread.update({ where: { id: thread.id }, data: { ..., unreadCount: { increment: 1 } } });
   ...
   175:    return { channel, outcome: "sent", providerMsgId, wouldBeQuiet };
   ```
   `outcome: "sent"` is returned regardless of whether real transport occurred.

**Citation-audit note (worstStatus: FILE_NOT_FOUND):** the record's cited line ranges
`messaging.service.ts:79-81` (paired with "only status === 'failed' aborts") and `:139-151` do not
line up 1:1 with current content — `:79-81` is actually the `usesProvider()` helper, not the
status check (which is at `:147-149` on the current tree). `stub.provider.ts`, `messaging.module.ts:22`,
and the `:153-176` record+return citation all match the current tree exactly (verified above), so
the underlying claim is not stale — only that one narrow line pointer inside `messaging.service.ts`
drifted from whatever line count the record was authored against (the file has had no commits
since the record's `roundSha` 0b2c3a0a per `git log 0b2c3a0a..HEAD -- messaging.service.ts`
returning nothing, so the drift predates that round rather than happening after it). The real site
for "only status === 'failed' aborts" is `messaging.service.ts:147-149`, confirmed above.

### History

```
git log --oneline -5 -- apps/api/src/messaging/messaging.service.ts apps/api/src/messaging/providers/stub.provider.ts
ea8a7479 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
7e13fbf3 fix(invoices): honour sale terms and due date; stop calendar date day-shift (#416)
12a0786e Transactional notification triggers (P6-5) (#263)
5133e237 Settings notifications matrix + templates (P6-6) (#262)
f03a59a8 feat(messaging): send engine + StubProvider (P6-2) (#167)
```

`git blame` on `stub.provider.ts:21` (`return { providerMsgId, status: "queued" };`) attributes it
to `f03a59a8` (P6-2, the original engine PR) — the stub has never been touched since. `ea8a7479`
only changed 4 lines elsewhere in the file (a `findUnique`→`findFirst` tenant-scope conversion,
unrelated to dispatch/record logic) — confirmed via `git show ea8a7479 -- messaging.service.ts`.

### Existing tests around this behavior

`apps/api/src/messaging/messaging.service.spec.ts` mocks the provider as
`{ send: jest.fn().mockResolvedValue({ providerMsgId: "stub-1", status: "queued" }) }` (line 18)
and then **asserts the current behavior as correct**:

- line 57-71: "sends WhatsApp: dispatches, records a Message on the thread, bumps it, meters MSGS"
  — asserts `res.outcome === "sent"`.
- line 78-84: "INTERNAL: records but does NOT use the provider and does NOT meter" — asserts
  `res.outcome === "sent"` with `provider.send` never called.
- line 86-90: "EMAIL: dispatches via provider but is NOT metered" — asserts `provider.send` was
  called once, with no assertion that dispatch actually succeeded end-to-end.

These are tests that **pin the wrong behavior**: they encode "stub returns queued → outcome is
sent" as the expected contract, so any fix that makes un-transported channels return
`"skipped"`/`"failed"` will need these three assertions rewritten, not merely extended.

### Production evidence

None available from this read-only pass (would require a prod DB query of `Message`/`MessageThread`
row counts by channel — out of scope here). The record's Verifier's note narrows blast radius:
the default-ON `INVOICE_SENT:EMAIL` cell's customer-visible email is actually sent by a separate,
real path (the invoice-email action's own `EmailService` call, independent of this engine), and
order-status pushes go through the separate, real `notifications.service.ts` push path — so this
engine's false "sent" record is currently silent (no customer-visible harm observed today), but the
record itself is false in every case, high severity because any future caller trusting `outcome`
would be misled.

### Open unknowns

- Whether any other code reads `SendOutcome.outcome` today expecting it to mean "actually
  delivered" (grep shows `orders.service.ts`/`routes.service.ts` discard it entirely — see B160
  below — so no live consumer is misled yet, but S2 should confirm no other caller exists).
- Not feature-shaped: this is a straightforward correctness defect (a stub masquerading as a
  working transport, returning a status it can never fail) with a clear right/wrong value —
  `outcome` should not read `"sent"` when no bytes left the system.

---

## B160 — The Quiet hours card states messages are held; the engine computes the window and discards the result

### The bug as stated

**Source (verbatim):** "'Customer-facing messages are held outside this window; internal alerts
still send' — with quiet hours on (the default, 21:00–07:00), a customer is not messaged at
02:00." … "The quiet-hours result is assigned to a field that only decorates the returned outcome;
dispatch and recording run unconditionally, every caller is fire-and-forget and discards that
outcome, and no queue or drain exists."

**Repro:** input — quiet hours enabled, current server time 02:00, `sendMessage` called for a
customer-facing channel → observed: the message is dispatched and recorded exactly as it would be
at any other hour (`wouldBeQuiet: true` is computed but only attached to the returned object, which
every real caller discards) → expected (per the settings-page copy): the send is held until the
window closes.

**Suspected cause (record's claim):** "Either implement the hold ... or reword the card to say
quiet hours are recorded but not yet enforced, and stop defaulting the toggle ON."

### Code path

Entry point: `MessagingService.sendMessage()`, `apps/api/src/messaging/messaging.service.ts:122-133`:

```
122:    const tenantId = this.prisma.getTenantId();
123:    const settings = tenantId ? await db.messagingSettings.findUnique({ where: { tenantId } }) : null;
127:    const wouldBeQuiet = settings ? isQuietHours(new Date(), { ... }) : false;
```

`wouldBeQuiet` is used in exactly two places, both decorative returns — line 148 (the early
`"failed"` return) and line 175 (the final `"sent"` return) — never as a branch condition; dispatch
at line 139-151 and record+bump at 153-168 run unconditionally regardless of its value.

`isQuietHours()` itself (`apps/api/src/messaging/messaging.helpers.ts:80-87`) computes against
`now.getHours()`/`now.getMinutes()` — the server process's own local clock, not any per-tenant
timezone — and its doc comment (lines 73-78) states outright: "P6-2 computes in the `now` Date's
own clock (server-local); true per-tenant timezone handling + the actual defer/release queue is
P6-10 — the engine only _computes_ the window here, it does not block or schedule." `MessagingSettingsView.timezone`
is written and returned (`messaging-config.service.ts:224-233`, the `getSettings()` method) but
never read by `isQuietHours` or passed to it anywhere — confirmed by `isQuietHours`'s signature
taking only `now: Date` and a settings object with no timezone field.

The web card states the false positive plainly:
`apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx:519`:

```
519:        Customer-facing messages are held outside this window; internal alerts still send.
```

inside the `<Card title="Quiet hours">` block at line 517, with the toggle+Save UI at 480-562 and
the toggle defaulting to whatever `messaging-config.service.ts`'s `getSettings()` returns —
`quietHoursEnabled: row?.quietHoursEnabled ?? true` (line 228) — true when no settings row exists,
which is the case for every tenant that has never visited this tab (see B182 below).

The two discard sites: `orders.service.ts:2840-2846` and `routes.service.ts:2377-2382` (current
line numbers; record cited `:2401-2407`/`:1770-1777`, stale — see History), both shaped as:

```
      this.messaging
        .notifyEvent(messagingEvent, { customerId: ..., senderId: ..., vars })
        .catch(() => {});
```

`.catch(() => {})` with no `.then()` — the resolved `SendOutcome[]` (which would carry
`wouldBeQuiet` per channel) is never read.

### History

```
git log --oneline 0b2c3a0a..HEAD -- apps/api/src/orders/orders.service.ts | wc -l
11
```

Eleven commits have touched `orders.service.ts` since the record's verification round (0b2c3a0a),
which is why the record's `:2401-2407` citation for the discard site no longer resolves — the file
has grown substantially (fix batches F02b through 2b/#623) and the `notifyEvent(...).catch(() => {})`
block has shifted down to line 2840-2846 without changing shape. Same story for
`routes.service.ts:1770-1777` → now `2377-2382`. `messaging.service.ts` and `messaging.helpers.ts`
themselves are unchanged since 0b2c3a0a (no commits in range), so the quiet-hours computation
citations (`:122-133`, `:148`/`:175`, helpers `:73-87`) match the current tree exactly. The Prisma
schema citation (`schema.prisma:2948-2961`) is now unresolvable for a structural reason, not drift:
`apps/api/prisma/schema.prisma` was retired by `60d10e66` ("wave E — shared enums/DTOs (10b) +
schema folder split (10a)", #621) and split into `apps/api/prisma/schema/{_base,tenancy,catalog,
sales,finance,platform,compliance}.prisma`. `MessagingSettings` now lives at
`apps/api/prisma/schema/platform.prisma:383-396`.

### Existing tests around this behavior

`apps/api/src/messaging/messaging.service.spec.ts:195-210` (`describe("isQuietHours
(wrap-around 21:00→07:00)")`) tests the pure helper function directly and correctly documents its
wrap-around math — it does not test `sendMessage()`'s use (or non-use) of the computed value, so no
test asserts that a quiet-hours send is (or is not) blocked. No test pins wrong behavior here
because no test exercises the integration point at all — the gap is a coverage hole, not a
false-green assertion.

### Production evidence

None cited; the record's Verifier's note is the closest thing to production framing: "with every
customer channel currently inert [B145], no real message is being sent at 02:00 — the live harm is
the false statement and the dead toggle," which is why B160 is rated Medium rather than High.

### Open unknowns

- Whether S2 should treat this as one fix alongside B145 (both live in `sendMessage()`'s
  dispatch/record block) or as an independent fix — the record explicitly separates them by
  severity and by distinct evidence, and the Verifier's note treats them as compounding rather
  than identical.
- Not feature-shaped: the settings copy already asserts a specific behavioral contract
  ("messages are held outside this window") that the code demonstrably does not implement — this
  is a defect (false UI claim + dead computed value), not a request for new capability, though the
  record's own suggested fix acknowledges a "reword the copy instead" option exists as an
  alternative resolution to "build the hold."
- Whether `orders.service.ts`/`routes.service.ts` are the only two discard sites, or whether other
  `notifyEvent` callers exist elsewhere that also discard — worth a fresh grep at fix time given
  how much both files have shifted since the record's round.

---

## B180 — Four notification rules seed ON for events that no code ever fires

### The bug as stated

**Source (verbatim):** "URGENT_ORDER_PLACED, LOW_STOCK, FAILED_DELIVERY and PAYMENT_FAILED_NSF are
seeded enabled and render as ON, but no call site anywhere passes those keys to the notify
helpers." … "Four switches ship in the ON position, with editable templates, live preview and
Save, for behaviour that has no trigger — toggling them changes nothing either way."

**Repro:** input — a brand-new tenant opens Settings → Notifications → observed: the matrix shows
`URGENT_ORDER_PLACED`, `LOW_STOCK`, `FAILED_DELIVERY`, `PAYMENT_FAILED_NSF` as ON (toggled,
editable, with live template preview) → expected: an ON switch implies some code path calls
`notify(eventKey, ...)` for that key; none does.

**Suspected cause (record's claim):** "Either wire the four alerts to their real triggers ... or
seed them disabled and mark unwired events in the matrix, so an ON switch always means something
fires."

### Code path

Entry point: `MessagingConfigService`'s static config,
`apps/api/src/messaging/messaging-config.service.ts:12-24` (`EVENT_CHANNELS`, all 11
`NotificationEvent` keys) and `:78-86` (`DEFAULT_ON`):

```
78:  export const DEFAULT_ON = new Set<string>([
79:    `${NotificationEvent.OUT_FOR_DELIVERY}:${PORTAL}`,
80:    `${NotificationEvent.DELIVERED}:${PORTAL}`,
81:    `${NotificationEvent.INVOICE_SENT}:${EMAIL}`,
82:    `${NotificationEvent.URGENT_ORDER_PLACED}:${INTERNAL}`,
83:    `${NotificationEvent.LOW_STOCK}:${INTERNAL}`,
84:    `${NotificationEvent.FAILED_DELIVERY}:${INTERNAL}`,
85:    `${NotificationEvent.PAYMENT_FAILED_NSF}:${INTERNAL}`,
86:  ]);
```

`seedMissing()` (`:255-294`, the `createMany` calls at `:290`/`:292`) writes `enabled:
DEFAULT_ON.has(key)` for every event×channel pair a tenant doesn't already have — so these four
keys are written `enabled: true` for every tenant the first time the matrix is read.

`grep -rn "URGENT_ORDER_PLACED|LOW_STOCK|FAILED_DELIVERY|PAYMENT_FAILED_NSF" apps/` (this pass,
current tree) returns matches only in `apps/api/prisma/schema/platform.prisma` (the enum
declaration), `messaging-config.service.ts` (the config above), and
`messaging-config.service.spec.ts` — zero hits in any trigger call site
(`orders.service.ts`, `routes.service.ts`, `invoices.service.ts`, `authorization-expiry.service.ts`,
`change-requests.service.ts`, or anywhere else). This directly confirms the record's claim: no code
anywhere calls `notify()`/`notifyEvent()` with any of these four event keys.

The web matrix renders every event row identically regardless of whether it is wired — the "Toggle
which channels fire for each event" copy (currently `NotificationsSettingsTab.tsx:157`, record cited
`:143-146` — see below) carries no per-row disclaimer, and every cell gets a live `MiniSwitch` plus
template-edit pencil (`:172-247`, record cited `:187-245`).

**Citation-audit note (worstStatus: OUT_OF_BOUNDS):** the web-file line citations (`:143-146`,
`:187-245`) are off by roughly 14 lines from the current tree (`:157`, `:175-247`). This file has
had exactly one commit ever (`5133e237`, its original P6-6 authoring commit — confirmed via
`git log --oneline -- NotificationsSettingsTab.tsx`), so this is not post-record drift; the
record's own line pointers were off by ~14 lines from the start. The quoted copy and structural
claim are otherwise accurate — verified directly above.

### History

```
git log --oneline -3 -- apps/api/src/messaging/messaging-config.service.ts
5133e237 Settings notifications matrix + templates (P6-6) (#262)
```

(only one commit touches this file's relevant DEFAULT_ON/EVENT_CHANNELS section since original
authoring — `git log 0b2c3a0a..HEAD` for this file also returns nothing, so no drift since the
verification round either). `git blame` on `messaging-config.service.ts:78-86` attributes the
entire `DEFAULT_ON` set to `5133e237`, the original P6-6 PR — these four keys were seeded ON from
day one, not a later regression.

### Existing tests around this behavior

`apps/api/src/messaging/messaging-config.service.spec.ts:67` ("seeds every missing rule/template
pair on first read (createMany skipDuplicates, DEFAULT_ON count enabled)") asserts the seed
produces the current DEFAULT_ON set, including these four — i.e. it pins the ON-by-default seed as
correct behavior, but says nothing about whether those events are ever fired; no test anywhere
asserts a call site invokes `notify()` for these four keys (because none does), so there is no test
covering the "no trigger exists" half of the claim — that half was established purely by
exhaustive grep, both by the original record and independently in this pass.

### Production evidence

None cited; the Verifier's note observes "even if wired, these four internal alerts would land as
Message rows on a customer thread that no client reads, and low-stock has no customer to key a
thread on at all, so real impact today is nil" — severity is Low because the defect is the
default-ON _state_ itself (a promise a switch makes that the code cannot keep), not any observed
harm.

### Open unknowns

- Whether S2 should fix by seeding these four OFF (matches the "an OFF switch promises nothing"
  logic the Verifier's note already applied to the refuted payment-reminder half of the original
  claim) versus actually wiring triggers — wiring is a materially larger change (new call sites in
  4+ services) than reseeding a default.
- LOW_STOCK in particular has no customer to notify (per the Verifier's note) — even a "wire it up"
  fix would need a different recipient model (internal ops user, not `Customer`/`MessageThread`),
  which is arguably feature work, not a bug fix. **Partial feature-shaped flag**: fixing the
  seed-default is a bug fix; building real triggers for these four events is new capability that
  the record itself frames as the non-default option.

---

## B181 — Push isConfigured() is hardcoded true, leaving the "not set up" branch permanently dead

### The bug as stated

**Source (verbatim):** "isConfigured() returns firebaseInitialized || true, so it is always true
and the warning branch and disabled state can never render. Push itself IS genuinely available,
because Expo is the only transport this app uses." … "A constant dressed as a check makes two UI
states unreachable."

**Repro:** input — Firebase never initializes (`firebaseInitialized` stays `false`) → observed:
`isConfigured()` still returns `true` (the exact wrong value: `false || true` evaluates to `true`
unconditionally) → expected: `isConfigured()` reflects the real Expo-availability state (which, per
the Verifier's note, is in practice always true anyway, since Expo needs no Firebase credentials —
so the "wrong value" is the _reasoning_, a literal always-true dressed as a live check, not
necessarily the _output_ in today's Expo-only deployment).

**Suspected cause (record's claim):** "Make isConfigured() honest — return firebaseInitialized or
an explicit Expo-availability flag — or document push as always-on and delete the dead 'Not set
up' branch and the disabled binding."

### Code path

Entry point: `NotificationsService.isConfigured()`,
`apps/api/src/notifications/notifications.service.ts:56-58`:

```
56:  isConfigured(): boolean {
57:    return this.firebaseInitialized || true; // Expo push always available
58:  }
```

Called at `:136`: `return { configured: this.isConfigured(), deviceCount };` — this is the sole
producer of the `configured` flag returned to clients.

Web consumer: `apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx` — the
"Push notifications" card (`title="Push notifications"` at `:585`) reads `notificationsStatus?.configured`
in at least two places: the "not configured" text branch (`:597`: `: "Push notifications are not
configured"`), the `Badge variant="warning" label="Not set up"` (`:604`), and the test-button
disabled binding (`:622`: `disabled={!notificationsStatus?.configured}`). Since `configured` is
always `true`, none of these three renders/behaves as anything but "configured."

### History

```
git blame -L 55,58 apps/api/src/notifications/notifications.service.ts
a03dcaead (2026-03-10) 55:
a03dcaead (2026-03-10) 56:  isConfigured(): boolean {
b8446f039 (2026-04-30) 57:    return this.firebaseInitialized || true; // Expo push always available
a03dcaead (2026-03-10) 58:  }
```

The `isConfigured` method itself predates the `|| true` — `a03dcaead` originally wrote a real
check; `b8446f039` ("fix: P0/P1 security and correctness fixes
(RF-001/003/009/014/017/026/080/097/110/147/157/176/197)") is the commit that appended
`|| true` with the "Expo push always available" comment. `git log --oneline -3 -- ...
notifications.service.ts` confirms no commit has touched this line since (`ea8a7479` and
`32923c41` in between touched other lines in the same file). This matches the record's own
`git log -S` claim — the change was deliberate, made alongside documenting the Expo-only
rationale, not a leftover debug stub.

### Existing tests around this behavior

`ls apps/api/src/notifications/*.spec.ts` → **no spec file exists for this module at all.** There
is zero test coverage of `isConfigured()`, `getStatus()`, or any push-registration path in the API.
No test pins the wrong behavior because no test touches this file; the gap is total absence of
coverage, not a false-green assertion.

### Production evidence

None cited; not applicable (this is dead-branch/unreachable-code, not a data-integrity issue).

### Open unknowns

- **Largely feature-shaped / dead-code-shaped rather than a live-harm bug.** The Verifier's note
  already downgraded two of the three original harms as refuted: the badge is behaviorally
  correct for an Expo-only deployment, and the "silently discarded native tokens" path is
  unreachable because the mobile client only ever mints Expo tokens (confirmed pattern: no
  `getDevicePushTokenAsync` call anywhere in `apps/mobile`, per the record — not independently
  re-verified in this pass but consistent with the Expo-only architecture visible in
  `notifications.service.ts`). What remains is genuine dead code (`|| true` making an `if` branch
  unreachable) with no test to catch a future regression. S2 should weigh whether this is worth a
  standalone low-severity fix (make `isConfigured()` return `firebaseInitialized` honestly, or
  delete the dead UI branch) versus folding into a larger notifications cleanup — no functional
  behavior change is observable to a real user in the current Expo-only deployment either way.

---

## B182 — Notification rules exist only after someone opens Settings → Notifications

### The bug as stated

**Source (verbatim):** "The seeding helper is private and reachable only from the matrix getter,
i.e. only via GET /messaging/config, whose sole caller is the web settings tab. Before that visit a
tenant has zero rules, so notify() matches nothing." … "Identical builds behave in two different
modes depending on whether a human once opened a settings page, and nothing tells the operator
which mode they are in."

**Repro:** input — a brand-new tenant, before any human has ever opened Settings → Notifications,
triggers an event that should notify a customer (e.g. `ORDER_CONFIRMED`) → observed:
`notify(eventKey, ...)` queries `db.notificationRule.findMany({ where: { eventKey, enabled: true
} })` against a table with zero rows for this tenant, so the loop body never executes and
`outcomes` returns `[]` → expected (per the documented defaults): invoice-sent-by-email,
out-for-delivery/delivered-by-portal should notify without any prior configuration step.

**Suspected cause (record's claim):** "Seed the rule and template matrix at tenant provisioning,
or have notify() lazily seed through the same shared helper, so defaults exist before anyone opens
Settings."

### Code path

Entry point: `MessagingConfigService.getMatrix()`,
`apps/api/src/messaging/messaging-config.service.ts:132-144`:

```
132:  async getMatrix(): Promise<MessagingConfigView> {
...
139:    const seeded = await this.seedMissing(db, rules, templates);
```

`seedMissing` is `private` (`:255`: `private async seedMissing(...)`) — its only caller in the
entire codebase is `getMatrix()` at line 139. `getMatrix()` itself is called from exactly one
controller route: `apps/api/src/messaging/messaging.controller.ts:88-94`
(`@Get("config") getConfig() { return this.config.getMatrix(); }`), and that route's only client
caller is `apps/web/lib/api/messaging.ts` (confirmed: this is the web settings-tab's config query
source). `MessagingService.notify()` (`messaging.service.ts:184-210`) reads
`db.notificationRule.findMany({ where: { eventKey, enabled: true } })` directly — it never calls
`seedMissing` or `getMatrix()` — so for a tenant that has never hit `GET /messaging/config`, this
query returns `[]` and the `for (const rule of rules)` loop (line 191) never executes, silently
returning `[]` from `notify()` with no log line (confirmed: no `logger` call exists anywhere in
`notify()`'s body).

### History

```
git log --oneline -3 -- apps/api/src/messaging/messaging-config.service.ts apps/api/src/messaging/messaging.controller.ts
ea8a7479 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
5133e237 Settings notifications matrix + templates (P6-6) (#262)
```

`seedMissing`'s `private` modifier and its single call site from `getMatrix()` both trace to the
original `5133e237` P6-6 authoring commit — this was the intended design from day one (lazy-seed
on first settings-page visit), not a regression; the record's framing ("two different modes
depending on whether a human once opened a settings page") is a design gap present since the
feature's original PR.

### Existing tests around this behavior

`messaging-config.service.spec.ts:67` and `:120` test the seeding path itself (seeds on first
read, idempotent thereafter) but always drive it through `getMatrix()` — no test exercises
`notify()` against a tenant with zero pre-seeded rules, so no test currently pins or catches the
"notify() matches nothing before Settings is opened" gap.

### Production evidence

None cited; the record's own Verifier's note states the effect is "unobservable because every
channel these rules would fire is inert anyway" (i.e., contingent on B145 being fixed first) "and
the state self-heals the first time the tab is opened" — hence Low rather than Medium severity.

### Open unknowns

- Ordering dependency: this bug's real-world impact is gated behind B145 (a working transport) —
  today it changes nothing observable. S2 should confirm whether the fix ordering in this batch
  should land B182 before or independent of B145, since testing B182's fix meaningfully may require
  a working (or test-double) transport to observe the "customer should have been notified but
  wasn't" symptom.
- Not feature-shaped: this is a genuine defect in an existing, already-shipped feature (the
  documented default-notifications promise), not a request for new capability — the fix is
  provisioning-time seeding, which is a small, bounded change (call `seedMissing`-equivalent logic
  from wherever tenant provisioning happens, or lazily from `notify()` itself).

---

## B183 — WhatsApp and SMS consent has no writer, so those cells can never fire

### The bug as stated

**Source (verbatim):** "The two consent flags default false and no code path writes them, and the
opt-out model has a reader and no writer. Enabling a WhatsApp or SMS cell therefore skips on 'no
consent' permanently." … "Both the consent-capture and the opt-out halves of the channel were
never built, so a persisted toggle can never produce a send in either direction."

**Repro:** input — a `TENANT_ADMIN` enables the WHATSAPP (or SMS) cell for some event in Settings →
Notifications, then that event fires for a customer → observed: `sendMessage()`'s consent gate
(`requiresConsent(channel)` true for WHATSAPP/SMS) reads `customer.waConsent`/`customer.smsConsent`,
both of which default `false` in the schema and are never written by any mutation anywhere in the
codebase, so the send always returns `skip("NO_CONSENT")` → expected: a customer who has genuinely
consented receives the message; today no customer can ever reach the consented state, so the
enabled cell is permanently inert regardless of intent.

**Suspected cause (record's claim):** "Add operator-editable consent (a customer form field plus a
PATCH that stamps the consent timestamp) and a STOP/manual opt-out writer, or grey the WhatsApp and
SMS cells with 'consent capture not available yet' until the adapters land."

### Code path

Entry point: `MessagingService.sendMessage()`, `apps/api/src/messaging/messaging.service.ts:92-116`:

```
 92:    const customer = await db.customer.findFirst({
 93:      where: { id: customerId },
 94:      select: { id: true, phone: true, mobile: true, email: true, smsConsent: true, waConsent: true },
102:    });
...
106:    if (requiresConsent(channel)) {
107:      const consented = channel === MessageChannel.WHATSAPP ? customer.waConsent : customer.smsConsent;
109:      if (!consented) return skip("NO_CONSENT");
110:    }
112:    // 3. Opt-out (WhatsApp/SMS only — @@unique([tenantId, customerId, channel])).
113:    if (requiresConsent(channel)) {
114:      const optOut = await db.messageOptOut.findFirst({ where: { customerId, channel } });
115:      if (optOut) return skip("OPTED_OUT");
116:    }
```

Schema: `Customer.smsConsent`/`Customer.waConsent`, currently at
`apps/api/prisma/schema/sales.prisma:164-165`, both `Boolean @default(false)`. `MessageOptOut`
model, currently at `apps/api/prisma/schema/platform.prisma:363-378` (source comment at `:371`:
`source String? // e.g. "STOP"`, confirming an intended-but-unbuilt STOP-webhook writer).

`grep -rn "smsConsent|waConsent"` and a search for `MessageOptOut` across `apps/api/src` returns
only: the `messaging.service.ts` reader above, `messaging.service.spec.ts` (its mock), and the
schema files — no DTO field, no controller endpoint, no form binding anywhere writes either
consent flag or creates a `MessageOptOut` row. This confirms the record's claim exactly: readers
exist, writers do not, on both halves (consent-in, opt-out-out).

**Citation-audit note:** `schema.prisma:791-793` and `:2928-2942` (the record's original citations)
are unresolvable for the same structural reason as B160 — the single-file `schema.prisma` was
retired by `60d10e66` (#621) and split into per-domain files. Current locations:
`Customer.smsConsent`/`waConsent` → `apps/api/prisma/schema/sales.prisma:164-165`;
`MessageOptOut` → `apps/api/prisma/schema/platform.prisma:363-378`.

### History

```
git log --oneline -3 -- apps/api/src/messaging/messaging.service.ts
ea8a7479 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
7e13fbf3 fix(invoices): honour sale terms and due date; stop calendar date day-shift (#416)
12a0786e Transactional notification triggers (P6-5) (#263)
```

The consent-gate logic (lines 92-116) traces back to the original `f03a59a8` P6-2 engine PR (same
file, same era as B145's stub binding) — this has been the design since the engine's first
version; consent capture and opt-out writers were simply never built in a later increment, matching
the module's own doc comment about "later P6 increments" (`messaging.service.ts:47-48`).

### Existing tests around this behavior

`messaging.service.spec.ts`'s `beforeEach` (line 32-39) mocks the happy-path customer with
`smsConsent: true, waConsent: true` — i.e. tests assume consent already exists and never exercise
the "no writer exists" gap; there is no test anywhere for a consent-capture endpoint or opt-out
writer, because none exists to test. Per the record's Verifier's note, the WhatsApp cells do render
a `waApprovalStatus` badge ("No WA template") — confirmed present in this pass via
`MatrixCell.template.waApprovalStatus` (`messaging-config.service.ts:93`, `WA_STATUS_BADGE` render
in `NotificationsSettingsTab.tsx`) — but SMS carries no equivalent decoration, matching the
Verifier's correction to the original claim.

### Production evidence

None cited; not applicable — no send can currently succeed for either channel via this gate, so
there is no prod row to point to.

### Open unknowns

- **Feature-shaped: largely YES for the fix, but the underlying claim is a genuine defect.** The
  record's own suggested fix is "add operator-editable consent ... and a STOP/manual opt-out
  writer" — that is net-new capability (a form field, a PATCH endpoint, a webhook handler), not a
  one-line correction. The narrower, bug-fix-shaped alternative the record also offers — grey out
  the WhatsApp/SMS cells until the writers exist — is the smaller, defect-shaped fix (stop letting
  an operator toggle ON a control that can never fire). S2 should decide which framing this batch
  takes; the two are very different scopes.
- Whether this should be sequenced with B145/B183 together (both concern WhatsApp/SMS being
  unreachable, for different reasons: B145 = the stub transport, B183 = the consent gate that
  blocks reaching the stub in the first place) or fixed independently, since even a fixed consent
  writer would still hit B145's fake-success problem underneath.
