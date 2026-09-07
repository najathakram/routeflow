# S2 · Cause refutation — F23 (B37, B145, B160, B180, B181, B182, B183)

Read-only pass over the MAIN checkout at `git log -1 --format=%H` = **12cdc26a39784ff0a885209f0fe9a1ef4e363468**
(worktrees under `.claude/worktrees/*` untouched). Every line citation below is against that tree.
Method: assume S1's cause is WRONG for each row, enumerate the alternative explanations that would
make the repro produce the observed output for a different reason, and kill each one with a command
output or a quoted line. Anything I could not kill is marked _undetermined_, not confirmed.

Inputs read: `cause-brief.md` (S1), the seven records under `.claude/campaign/bugs/`,
`.claude/campaign/status/F23.jsonl`, `.claude/campaign/citation-audit.json`,
`.claude/lessons/LESSONS.md` (testing + domain), the code map INDEX/area files.

**One input the batch brief said did not exist, and does:** `.claude/pipeline/fix-cards/F23-messaging-notification-honesty.md`
— not a plan (no discovery/spec/build), but a committed batch card that already fixes the tier table
(all seven **T1**, matching `F23.jsonl`) and states an ordering constraint: _"One PR. Approach: make
the untransported channels honest FIRST (record skipped, surface 'channel not configured'), then wire
what is real."_ That card is consistent with my findings; the lead should treat its "one PR" line as a
claim to rule on, not a settled decision (see §Overall).

---

## Cross-cutting finding — three of these rows are ONE defect class

B145, B180 and B183 are not three unrelated bugs. They are three instances of a single invariant
being violated in three places:

> **The notification config surface advertises capabilities the engine cannot perform.**
> B145 = a _channel_ with no transport still reports `sent`. B180 = an _event_ with no trigger ships
> its switch ON. B183 = a _channel_ whose consent precondition has no writer still renders an
> ordinary, enableable switch.

There is exactly one seam where that invariant can be enforced coherently: a capability declaration
consulted by BOTH `MessagingConfigService` (to seed / decorate / refuse the cell) and
`MessagingService.sendMessage()` (to refuse the send). Lesson **L-081** applies directly and is why
the record's B145 fix is refutable: _gate the write inside the primitive that performs it_.
`sendMessage()` is the primitive that writes the `Message` row and bumps the thread
(`messaging.service.ts:154-168`); a fix placed in `StubProvider` is a fix at an injectable
collaborator that a mock, a future adapter, and the whole PORTAL path all bypass.

---

## B37 — Run chat is built server-side, absent client-side

### Refutation attempts

| Alternative that would make S1 wrong                                      | Killed by                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The screen _is_ wired and "coming soon" is a fallback for an empty thread | `apps/mobile/components/MessagesScreen.tsx:1-28` — the whole component is 28 lines, no `useMessages` import, no query, no state; `IosEmptyState` at `:20-24` is unconditional.                                                                                                                                                                                     |
| Some other screen is the real chat and this one is a stub route           | `apps/mobile/app/(operator)/messages.tsx:1-3` and `apps/mobile/app/(driver)/driver-messages.tsx:1-3` are each a 3-line re-export of the same `MessagesScreen`; entry points are `(operator)/(tabs)/more.tsx:256`, `(tenant)/more.tsx:165`, `(driver)/driver-menu.tsx:44`, and `(driver)/_layout.tsx:73` registers `driver-messages` with `href: null` (menu-only). |
| The hooks are called somewhere the record's grep missed                   | fresh repo grep for `useMessages\|useSendMessage` (dist excluded) returns only their definitions at `apps/mobile/lib/api/messages.ts:27,39`.                                                                                                                                                                                                                       |
| The backend is itself a stub                                              | `apps/api/src/messages/messages.service.ts:39-79` writes a real `Message` row and reads it back behind a participant gate (`assertRunChatParticipant`, `:23-37`); `messages.service.spec.ts` + `messages.security.spec.ts` exist.                                                                                                                                  |

### Verdict — **confirmed** (diagnosis), **refuted** (the record's suggested fix, as written)

The diagnosis holds exactly. The record's fix — _"replace the placeholder with a real chat UI wired to
useMessages/useSendMessage"_ — **cannot work as stated on the driver route**, which S1 did not surface:

- `useMessages(runId)` is `enabled: !!runId` (`apps/mobile/lib/api/messages.ts:31`) — with no run in
  scope the query never fires and the screen renders an empty list forever.
- The API _forbids_ a driver the no-runId read: `messages.service.ts:29` —
  `if (role !== "DRIVER" || !runId) throw new ForbiddenException();`. An OPERATOR/TENANT_ADMIN returns
  early at `:28` and may read the firehose; a DRIVER may not.
- `useSendMessage`'s POST hits the same gate on the write side (`messages.service.ts:42`).
- Neither screen receives a `runId` — both are bare default re-exports reached from a "More"/menu tab,
  not from a run context.

So the fix necessarily includes **run resolution** (which run is this driver on right now?) plus a
thread/compose UI plus a polling cadence — net-new product surface, not a wiring change.

- **Feature-shaped (D5): YES — recommend DEFER out of F23.** Nothing regressed; a backend and a typed
  client were built and a screen was never written. It is also a different module from every other row
  (`apps/api/src/messages`, run-chat, INTERNAL-only) — it shares only the word "messaging".
- **Minimal fix shape (claim for the lead):** _if the lead rules it stays_ — files
  `apps/mobile/components/MessagesScreen.tsx` (+ a new run-resolution hook in `apps/mobile/lib/api/`).
  Edit shape: resolve the caller's active run first (driver: their assigned `RouteRun`; operator: a run
  picker or the firehose), then render list + composer off `useMessages`/`useSendMessage`. Invariant:
  _a screen renders a placeholder only when the API is unreachable — never as a substitute for a built
  endpoint_. **No code; this is a claim.**
- **REG test (tier-frozen T1):** the mobile jest lane is pure-logic only (`__tests__/*.test.ts`), so an
  RN render assertion has no home; the API side is already covered by `messages.service.spec.ts`.
  **There is no T1 test that fails today on B37's wrong value** — the wrong value is a rendered
  placeholder. That is itself an argument for deferring.
- **Tests pinning the wrong behavior:** none.
- **Siblings (same class — a "coming soon" placeholder in front of possibly-built capability):**
  `apps/mobile/app/(driver)/cash.tsx:17`, `apps/mobile/app/(operator)/(tabs)/more.tsx:209`,
  `apps/mobile/app/(operator)/settings/index.tsx:248,303`,
  `apps/mobile/app/(customer)/orders/[id].tsx:270`. Whether each has a built backend behind it is
  **unverified** — worth a sweep only if the lead keeps B37.
- **Tier:** frozen **T1** in `F23.jsonl`; unprovable at T1 as written — re-tier or defer.

---

## B145 — The engine records EMAIL and PORTAL as "sent" with no transport

### Refutation attempts

| Alternative that would make S1 wrong                                              | Killed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A real adapter is bound in production via env/factory; `StubProvider` is dev-only | repo grep for `MESSAGE_PROVIDER` (dist excluded) returns 13 hits; the only non-spec binding is `messaging.module.ts:22` `{ provide: MESSAGE_PROVIDER, useClass: StubProvider }` — `useClass`, no factory, no `ConfigService`, no env branch in the module.                                                                                                                                                                                                                                                                                                                                                              |
| EMAIL really transports because the engine calls `EmailService`                   | `grep -rn "EmailService" apps/api/src/messaging` → **no matches**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PORTAL is genuinely "delivered" because the `Message` row IS the portal surface   | No customer-facing reader exists. `GET /messaging/threads` and `/threads/:id` sit on a controller class annotated `@Roles(UserRole.OPERATOR)` (`messaging.controller.ts:42,76-84`) — a CUSTOMER cannot read them. The buyer portal has no messages route (`apps/web/app/buyer/portal/` = `page.tsx`, `settings`, `[seller]`, `layout.tsx`, `error-boundary.tsx`). The one other `Message` reader, `messages.service.ts:67-71`, filters `channel: MessageChannel.INTERNAL`, so PORTAL rows are excluded by construction.                                                                                                 |
| The stub can fail, so `outcome` is sometimes honest                               | `stub.provider.ts:15-22` has a single `return { providerMsgId, status: "queued" }`, no throw path, no branch. The engine's abort is `messaging.service.ts:147-149` `if (res.status === "failed")` — unreachable with this binding.                                                                                                                                                                                                                                                                                                                                                                                      |
| Nobody consumes `outcome`, so nothing is misled                                   | Structurally true today and _sharper_ than the record says: the trigger wrapper discards it — `notifyEvent(...): Promise<void>` (`messaging.service.ts:238-241`) awaits `notify()` at `:257` and returns nothing, so even the awaiting caller (`authorization-expiry.service.ts:126`) cannot read it. But `POST /messaging/threads/:customerId/messages` (`messaging.controller.ts:49-64`) and `POST /messaging/notify` (`:66-74`) return `SendOutcome` straight to any API client. **Not a refutation**: the durable wrong artifact is the persisted `Message` row + `unreadCount` bump, not only the returned string. |

### Verdict — **confirmed** (cause); the record's suggested fix is **refuted**

Exact diverging line: **`apps/api/src/messaging/messaging.service.ts:175`** —
`return { channel, outcome: "sent", providerMsgId, wouldBeQuiet };` — reached unconditionally for
EMAIL/WHATSAPP/SMS (stub returns `"queued"`, never `"failed"`) and for PORTAL, which never enters the
`if (this.usesProvider(channel))` block at `:139` at all (`usesProvider`, `:79-81`). The persisted half
diverges earlier at `:155-157` (`db.message.create`) and `:160-168` (`unreadCount: { increment: 1 }`).

**Why "have the stub return a non-delivered status" is wrong:**

1. It does nothing for **PORTAL** — the provider is never consulted there, and PORTAL is 2 of the 3
   customer-facing default-ON cells (`messaging-config.service.ts:79-80`). A stub-only fix leaves the
   majority of the default matrix still recording fake deliveries.
2. `"failed"` is the wrong signal: `:148` maps it to `reason: "SEND_FAILED"` — _we tried and it broke_
   — when the truth is _no transport is configured_. `messaging.service.spec.ts:92-98` already pins
   genuine-failure semantics; overloading it destroys a distinction a real adapter will need.
3. Per **L-081**, a fix at an injected collaborator is bypassed by every result-injecting mock and by
   the next binding swapped in at that token.

**Minimal fix shape (claim — no code):**

- Files: `apps/api/src/messaging/providers/message-provider.interface.ts` (add a capability
  declaration, e.g. `transports(channel): boolean` or a readonly `configuredChannels`),
  `providers/stub.provider.ts` (declares none), `messaging.service.ts` (consult it _before_ the
  record+bump block; add `"NO_TRANSPORT"` to `SkipReason` at `:14-20`), `messaging-config.service.ts`
  (surface the same capability on `MatrixCell` so the UI can say "channel not configured").
- Edit shape: an early `return skip("NO_TRANSPORT")` between the quiet-hours computation (`:133`) and
  the dispatch block (`:139`), for any channel with no configured transport.
- **Invariant: `outcome === "sent"` ⟺ a `Message` row was written ⟺ a configured transport accepted
  the payload.** INTERNAL must stay `"sent"` (genuinely in-app: `messages.service.ts:67-71` reads
  INTERNAL rows). PORTAL's classification is a **ruling for the lead**: today it has no reader, so
  honest = skipped; building a portal inbox is feature work.
- **REG test (T1):** new `apps/api/src/messaging/messaging.transport-honesty.spec.ts`, built with the
  **real `StubProvider`** bound at `MESSAGE_PROVIDER` (that is the production binding — the point is
  to test what ships), `createMockPrisma()`, consented customer.
  - `sendMessage({channel: EMAIL})` → **received today** `{ outcome: "sent", providerMsgId: "stub-EMAIL-1" }`
    with `prisma.message.create` called once and `messageThread.update` called with
    `unreadCount: { increment: 1 }`. **Expected** `{ outcome: "skipped", reason: "NO_TRANSPORT" }`,
    `message.create` NOT called, no bump.
  - `sendMessage({channel: PORTAL})` → same wrong value today, same expectation.
  - Pin that must stay green: `sendMessage({channel: INTERNAL})` still `"sent"` and recorded.
- **Tests that currently pin the wrong behavior (rewrite, not extend):**
  `messaging.service.spec.ts:57-71` (`expect(res.outcome).toBe("sent")`, WHATSAPP), `:86-90` (EMAIL
  dispatches), `:111-118` (`INVOICE_SENT` over EMAIL → `"sent"`), `:155-171` (`notify()` → `"sent"`).
  All four use a mock provider returning `status: "queued"` (`:18`), encoding "queued ⇒ sent" as the
  contract. `:78-84` (INTERNAL) and `:92-98` (real failure) stay green under the proposed invariant.
- **Siblings:** no other service fabricates a delivery status. The contrast is instructive — every
  other `isConfigured` in the repo is an honest env check (`billing/stripe.service.ts:36-38`
  `return this.stripe !== null;`, `auth/google-oauth.service.ts:129-132`), which is exactly the house
  pattern the messaging provider lacks.
- **Feature-shaped: NO.** A correctness defect with a clear right/wrong value.
- **Tier:** T1, appropriate — the wrong value is an API return + a DB write, both jest-observable.

---

## B160 — Quiet-hours copy claims a hold the engine does not perform

### Refutation attempts

| Alternative that would make S1 wrong                         | Killed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A queue/scheduler enforces the hold elsewhere                | repo grep for `isQuietHours` across `apps/api/src` returns only the definition (`messaging.helpers.ts:80`), one call (`messaging.service.ts:128`) and the helper's own spec. No cron, no drain, no deferred table.                                                                                                                                                                                                                                                                                                                                                    |
| `wouldBeQuiet` is read by a caller that suppresses the send  | grep for `wouldBeQuiet` across apps (dist excluded) returns exactly 4 hits, all inside `messaging.service.ts`: the type `:27`, the assignment `:127`, and the two decorative returns `:148`, `:175`.                                                                                                                                                                                                                                                                                                                                                                  |
| The caller citations are stale, so maybe callers now read it | Line numbers drifted (record: `orders.service.ts:2401-2407`, `routes.service.ts:1770-1777`; current: `orders.service.ts:2841-2847`, `routes.service.ts:2377-2383` **plus a third the record missed, `routes.service.ts:2651-2657`**), but the shape is identical `.notifyEvent(...).catch(() => {})`. Stronger: `notifyEvent` is declared `Promise<void>` (`messaging.service.ts:241`), so **no** caller can read the outcome — including the awaiting `authorization-expiry.service.ts:126` and `invoices.service.ts:3439`/`3646`, `change-requests.service.ts:157`. |
| The card's copy is true for some tenant configuration        | `NotificationsSettingsTab.tsx:518-520` renders the claim unconditionally inside `<Card title="Quiet hours">` (`:517`); the default is ON for every tenant with no settings row (`messaging-config.service.ts:228` `row?.quietHoursEnabled ?? true`) while the engine computes `false` in that same state (`messaging.service.ts:127` — `settings` is `null`, so the ternary yields `false`). The UI and the engine disagree about the default.                                                                                                                        |

### Verdict — **confirmed**

Exact diverging line: **`apps/api/src/messaging/messaging.service.ts:139`** — dispatch begins with no
reference to `wouldBeQuiet`, computed 6 lines earlier at `:127-133`. The false statement is
**`apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx:519`**.

Two confirmations S1 flagged but did not close: the helper's own doc comment says it outright —
`messaging.helpers.ts:76-78`, _"the engine only \*computes\* the window here, it does not block or
schedule"_ — and `MessagingSettingsView.timezone` is written/returned (`messaging-config.service.ts:231,246`)
while `isQuietHours(now, settings)` (`:80-87`) takes no timezone and uses `now.getHours()`, i.e.
server-local (an **L-047** violation waiting for whoever builds the hold).

- **Minimal fix shape — TWO candidates; the lead rules, and they carry different tiers:**
  - **(a) Honest copy (smallest, defect-shaped):** files `NotificationsSettingsTab.tsx` (`:519` copy +
    a "recorded, not yet enforced" qualifier) and `messaging-config.service.ts:228` (stop defaulting
    `quietHoursEnabled` to `true` when no row exists, so UI and engine agree). Invariant: _no settings
    card asserts behavior the engine does not implement, and the UI default equals the engine default._
  - **(b) Build the hold (feature-shaped):** a defer/release queue + per-tenant timezone (`P6-10` per
    the helper's comment). A new subsystem — **recommend NOT in F23**.
  - Recommend **(a)**; it composes with B145 — once untransported channels return `NO_TRANSPORT`, a
    quiet-hours hold has nothing to hold.
- **REG test:**
  - For **(a)**: T1 jest — `messaging-config.service.spec.ts`: `getSettings()` with
    `messagingSettings.findUnique → null` **received today** `quietHoursEnabled: true`; **expected**
    `false` (matching the engine's `:127` computation). Plus an RTL jest test on the tab (precedent:
    `apps/web/app/(dashboard)/settings/settings-users.test.tsx`) asserting the card copy no longer
    claims messages are held. That keeps the row at its frozen **T1** without Playwright.
  - For **(b)**: T1 — `sendMessage` with `messagingSettings.findUnique` mocked to
    `{quietHoursEnabled: true, quietHoursStart: "21:00", quietHoursEnd: "07:00"}` and
    `jest.setSystemTime(new Date(2026, 0, 1, 2, 0))` → **received today** `{outcome: "sent"}` with
    `provider.send` and `message.create` both called; **expected** `{outcome: "skipped", reason:
"QUIET_HOURS"}` and neither called. Per **L-047**: construct the instant with the local
    `Date(y,m,d,h,m)` constructor so host TZ and `getHours()` agree — a UTC-ISO fixture is green on the
    buggy body under `TZ=UTC`.
- **Tests that pin the wrong behavior:** none pin it directly. `messaging.service.spec.ts:195-210`
  tests the pure helper only; `:45` mocks `messagingSettings.findUnique → null`, so every send test
  runs with quiet hours OFF and would stay green under fix (b). A **coverage hole**, not a false-green
  — no assertion has to be deleted.
- **Siblings:** the "computed then discarded" shape does not recur — `wouldBeQuiet` is the only such
  field in the engine (grep above). The _copy-asserts-unbuilt-behavior_ class does recur; it is the
  whole subject of batch **F29 (`dead-controls-copy-housekeeping`)**.
- **Feature-shaped:** **(a) NO** (a false statement in shipped UI is a defect); **(b) YES**.
- **Tier:** T1 with an RTL web test for the copy half. Preferring Playwright is a tier change from the
  frozen table and needs an explicit ruling.

---

## B180 — Four rules seed ON for events nothing fires

### Refutation attempts

| Alternative that would make S1 wrong                                       | Killed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One of the four is fired dynamically through a variable event key          | The only dynamic `notifyEvent` call is `orders.service.ts:2842` with `messagingEvent` from `messagingEventMap` (`:2806-2810`), whose entire value set is `ORDER_CONFIRMED`, `OUT_FOR_DELIVERY`, `DELIVERED`. None of the four.                                                                                                                                                                                                                                                                                                         |
| A trigger exists outside `apps/api/src` (script, cron, seed)               | repo-wide grep for the four keys returns only: the enum (`apps/api/prisma/schema/platform.prisma:296-299`, `0_init/migration.sql:143`), the config (`messaging-config.service.ts:20-23,58-73,82-85`), its spec, and non-code notes — `docs/product/inventory.md:387` independently records _"has no emitter anywhere"_ for LOW_STOCK. Zero call sites.                                                                                                                                                                                 |
| The record's web-file pointers are wrong, so the UI claim may be wrong too | The pointers **are** wrong (record `:143-146` / `:187-245`; actual copy at `:156-159`, matrix rows `:187-245` with the switch at `:227-232`) — but the substance holds: `NotificationsSettingsTab.tsx:157` reads _"Toggle which channels fire for each event"_ with no per-row qualifier, and every non-locked cell gets a live `MiniSwitch` + template pencil (`:192-199`, `:224-242`). This matches the audit's `OUT_OF_BOUNDS` flag: the record's own pointers were off from day one (the file has exactly one commit, `5133e237`). |

### Verdict — **confirmed**

Exact diverging site: **`messaging-config.service.ts:82-85`** (the four keys inside `DEFAULT_ON`)
consumed at **`:277`** — `if (!haveRule.has(key)) ruleData.push({ eventKey, channel, enabled: DEFAULT_ON.has(key) })`
— writing `enabled: true` for four event keys no caller ever passes to `notify()`/`notifyEvent()`.

**A live cross-batch conflict the lead must rule on:** `B146` (batch **F11**, run-cancel/skip) has a
fix plan that _fires_ `NotificationEvent.FAILED_DELIVERY` on stop skip
(`.claude/campaign/bugs/B146.md:73,97` — "It is fully configured … with zero automatic firers"). If
F11 lands that, seeding `FAILED_DELIVERY:INTERNAL` OFF here would silently disable the alert F11 just
built. **Recommend: leave `FAILED_DELIVERY` alone in F23** (or coordinate with F11) and treat only
`URGENT_ORDER_PLACED`, `LOW_STOCK`, `PAYMENT_FAILED_NSF` as unwired here.

- **Minimal fix shape (claim):** files `apps/api/src/messaging/messaging-config.service.ts` (drop the
  unwired keys from `DEFAULT_ON` and/or expose an `unavailable`/`unwired` flag on `MatrixCell`),
  `NotificationsSettingsTab.tsx` (render that flag as a per-row qualifier instead of a live switch).
  **Invariant: a rule cell may seed ON only if some code path passes its event key to
  `notify()`/`notifyEvent()`.** Wiring real triggers is the other branch and is feature work —
  LOW_STOCK in particular has no `Customer` to key a `MessageThread` on (`sendMessage` requires a
  `customerId`, `messaging.service.ts:84,92-103`), so "wire it up" means a different recipient model.
- **REG test (T1):** modelled on this repo's own static-source-scan precedent
  `apps/api/src/common/no-bare-cron.spec.ts` (it walks `apps/api/src` and fails on a new bare
  `@Cron(`). New `apps/api/src/messaging/default-on-is-wired.spec.ts`: for every key in `DEFAULT_ON`,
  scan `apps/api/src/**` (excluding `messaging/` and `*.spec.ts`) for `NotificationEvent.<KEY>` and
  assert ≥1 firing site. **Received today:** fails listing `URGENT_ORDER_PLACED`, `LOW_STOCK`,
  `FAILED_DELIVERY`, `PAYMENT_FAILED_NSF`. **Expected:** empty list. This form also catches the _next_
  unwired key, which `expect(DEFAULT_ON).not.toContain(...)` would not.
- **Test that currently pins the wrong behavior:** `messaging-config.service.spec.ts:135-150` —
  _"LOW_STOCK exposes a single enabled INTERNAL cell …"_ with `expect(cell.enabled).toBe(true)`
  (`:147`). Its fixture derives `enabled` from `DEFAULT_ON` (`buildFullSeed`, `:20-26`), so removing
  the key flips it red. `:67-77` (seed count) also reads `DEFAULT_ON` indirectly.
- **Siblings:** same class as **B183** (a switch the engine cannot honour) and **B145** (a channel the
  engine cannot transport) — one capability flag serves all three.
- **Feature-shaped:** the **seed-default fix is NOT**; the **"wire the four triggers" alternative IS**
  (new call sites in 4+ services, plus a recipient model for LOW_STOCK). Recommend the seed/flag half.
- **Tier:** T1 (both the seed spec and the static scan are jest); the per-row UI qualifier needs an RTL
  assertion to be proven — same caveat as B160.

---

## B181 — `isConfigured()` returns `firebaseInitialized || true`

### Refutation attempts

| Alternative                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The literal is not there / has been fixed                                        | Present verbatim: `apps/api/src/notifications/notifications.service.ts:57` — `return this.firebaseInitialized \|\| true; // Expo push always available`. Sole consumer `:136` `return { configured: this.isConfigured(), deviceCount };` via `GET /notifications/status` (`notifications.controller.ts:33-38`), consumed by the web card at `NotificationsSettingsTab.tsx:595,601-605,608,622`.        |
| The refuted third harm ("native FCM tokens silently discarded") is actually live | **Refutation upheld.** `sendViaFirebase` is gated on `firebaseInitialized` (`:93`, `:114`), but the mobile client mints only Expo tokens — `apps/mobile/lib/auth.ts:132` `await Notifications.getExpoPushTokenAsync()` is the _only_ token source, posted to `/notifications/register-token` at `:136`; there is no `getDevicePushTokenAsync` anywhere in `apps/mobile`. The FCM branch has no inputs. |
| There is a deployment state in which `true` is the WRONG answer                  | **I could not construct one.** Expo push needs no credentials (`new Expo()` at `:21`, unconditional), it is the only transport with a live token source, and no flag can disable it. With zero devices the card reads "0 device(s) registered / Active" and the test send returns `sent: 0 of 0` — awkward, not wrong.                                                                                 |

### Verdict — **refuted as a bug** (the cause line is confirmed; there is no observable wrong value)

The cause S1 named is real and blamed correctly (`b8446f039` appended `|| true` deliberately). But F23
is a _bug_ batch, and this row has **no input that produces a wrong output** on any reachable
configuration: `configured: true` is the correct answer in an Expo-only deployment, the only deployment
that exists. What survives is dead code (`|| true` makes `NotificationsSettingsTab.tsx:604` "Not set
up", `:608-615` the explainer, and `:622` the disabled binding unreachable) — housekeeping.

- **Recommendation: defer to F29 (`dead-controls-copy-housekeeping`)**, or keep it in F23 explicitly as
  a no-proof cleanup with the lead's acknowledgement that it ships without a REG test.
- **Minimal fix shape (claim):** files `apps/api/src/notifications/notifications.service.ts` and
  `NotificationsSettingsTab.tsx`. Either (i) delete the tautology and the three dead UI states,
  documenting push as always-on; or (ii) make it a real check of _usable transports_ with the branch
  kept. Invariant: _no method returns a constant dressed as a check_ — the house pattern is
  `stripe.service.ts:36-38` / `google-oauth.service.ts:129-132`.
- **REG test:** **none can fail today on a wrong value.** The best available is a characterization test
  (`getStatus()` with `FCM_SERVICE_ACCOUNT_JSON` unset → `configured: true`) which passes before and
  after — a pin, not a proof, and **L-060** requires a pin brief to state its expected colour. State
  plainly that B181's proof is "the dead branch no longer exists" (an RTL assertion that the tab
  renders no "Not set up" path), not a wrong-value repro.
- **Tests that pin the wrong behavior:** none — `apps/api/src/notifications/` contains only
  `notifications.controller.ts`, `notifications.module.ts`, `notifications.service.ts`. **Zero test
  coverage of this module.**
- **Siblings:** the `|| true` shape occurs **once** in the whole repo (the other `|| true` hits are
  shell scripts: `apps/db-backup/backup.sh`, `apps/api/docker-entrypoint.sh`). Every other
  `isConfigured` is honest (cited above).
- **Feature-shaped:** N/A — dead-code-shaped.
- **Tier:** T1 nominally; unprovable at T1 in practice. Flag to the lead.

---

## B182 — Rules exist only after someone opens Settings → Notifications

### Refutation attempts

| Alternative                                              | Killed by                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant provisioning seeds the matrix                     | repo-wide grep for `notificationRule`/`messageTemplate` (dist excluded) finds writers only in `messaging-config.service.ts` (`:290`, `:292`, inside `seedMissing`) plus test mocks and old plan docs. No seed script, no provisioning hook, no migration data.                                 |
| `seedMissing` is reachable from another path             | It is `private` (`messaging-config.service.ts:255`) and called exactly once, `getMatrix():139`. `getMatrix()` is exposed only by `messaging.controller.ts:88-94` (`GET /messaging/config`), whose only client is `apps/web/lib/api/messaging.ts:59` (`useMessagingConfig`) — the settings tab. |
| `notify()` falls back to defaults when it finds no rules | `messaging.service.ts:189` `findMany({ where: { eventKey, enabled: true } })` → the `for` loop at `:191` never runs → `return outcomes` (`:209`) returns `[]`. No fallback, no log line anywhere in `notify()`'s body.                                                                         |
| The gap self-heals so it is not real                     | It self-heals _per tenant, on first tab visit_ — until then the documented defaults do not exist. Confirmed by the repo's own docs: `docs/product/data-comms.md:437` — _"lazily seeded on the first `GET /messaging/config` visit — a tenant nobody has opened Settings for has zero rules."_  |

### Verdict — **confirmed**

Exact diverging line: **`messaging.service.ts:189`** returns `[]` for a tenant with no rules, because
the only writer of those rows is behind **`messaging-config.service.ts:139`**, reachable only from a
web settings page visit.

**One refutation that survives against the record's own fix:** _"Seed the rule and template matrix at
tenant provisioning"_ **fixes new tenants only**. Every existing tenant that has never opened the tab
still has zero rows after such a change — there is no backfill. So the minimal fix is either lazy
seeding inside `notify()` (idempotent: `createMany … skipDuplicates`, already the shape at `:290-292`)
or provisioning-seed **plus** a one-time backfill script. Counter-consideration for the lead:
`notify()` is a hot fire-and-forget path called after business writes; adding a write to it changes its
contract from read-only to read-write, on every event of every tenant forever.

- **Minimal fix shape (claim):** files `apps/api/src/messaging/messaging-config.service.ts` (make the
  seeder shared/public), `apps/api/src/messaging/messaging.service.ts` (call it once from `notify()`
  when `rules.length === 0`) **or** the tenant-provisioning service + a backfill script under
  `apps/api/scripts/`. Invariant: _the documented default matrix exists for every tenant without any
  human having visited a settings page._
- **REG test (T1):** `messaging.service.spec.ts` (new case): `notificationRule.findMany` mocked to `[]`
  on first call, template mocked present → **received today** `outcomes.length === 0` and
  `notificationRule.createMany` **not** called; **expected** the defaults get seeded (`createMany`
  called once with `skipDuplicates: true`) and `INVOICE_SENT` yields ≥1 outcome. If the ruling is
  provisioning-side, the REG test moves to the provisioning service spec + a backfill-script spec.
- **Tests that pin the wrong behavior:** none. `messaging-config.service.spec.ts:66-77` and `:118-131`
  drive seeding only through `getMatrix()`; no test exercises `notify()` on an unseeded tenant.
- **Sequencing:** its customer-visible effect is gated behind B145 (no transport ⇒ nothing lost today),
  but its **jest-observable** wrong value (`[]` + no rows) exists today, so the proof does not depend on
  B145. Land order matters for the story, not the test.
- **Feature-shaped: NO.** An already-shipped feature's documented default is not delivered.
- **Tier:** T1, appropriate.

---

## B183 — WhatsApp/SMS consent has readers and no writers

### Refutation attempts

| Alternative                                              | Killed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A writer exists somewhere (DTO, import, webhook, script) | repo-wide grep for `smsConsent\|waConsent\|messageOptOut\|MessageOptOut` (dist excluded): the only code hits are the **readers** `messaging.service.ts:99-100,108,114`, the spec's mocks (`messaging.service.spec.ts:37-38,44,126-127,136,148-149`), the test mock registry `apps/api/src/testing/prisma-mock.ts:145`, the schema (`sales.prisma:164-165,177`, `tenancy.prisma:151`, `platform.prisma:363`), the split map, and `0_init/migration.sql`. Docs corroborate: `docs/product/customers.md:265` — _"An operator-facing write path must set smsConsent/waConsent and stamp consentUpdatedAt (currently failing/absent)"_; `docs/product/data-comms.md:294-295` lists both missing tests. |
| The gate is mis-ordered / leaks                          | It is correct: consent (`messaging.service.ts:106-110`) then opt-out (`:113-116`), both behind `requiresConsent(channel)`, both before dispatch. Nothing leaks; the Verifier's correction stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The cells are already visually marked unavailable        | Only WhatsApp carries decoration, and it is about _templates_, not consent: `NotificationsSettingsTab.tsx:233-239` renders `WA_STATUS_BADGE[cell.template.waApprovalStatus]` for `channel === "WHATSAPP"`. SMS renders a bare `MiniSwitch` (`:227-232`). `setRuleEnabled` (`messaging-config.service.ts:186-199`) refuses only the G12 invoice pair, never WA/SMS-without-consent.                                                                                                                                                                                                                                                                                                                |

### Verdict — **confirmed** (facts), with the record's primary fix **feature-shaped**

Exact diverging line: **`messaging.service.ts:109`** — `if (!consented) return skip("NO_CONSENT");`
reading `Customer.waConsent`/`smsConsent`, both `Boolean @default(false)`
(`apps/api/prisma/schema/sales.prisma:164-165`) with no writer in the repo. The `MessageOptOut` half is
the mirror image: reader at `:114`, model at `apps/api/prisma/schema/platform.prisma:363-378`, no
creator anywhere.

- **Two fix shapes, very different scope — the lead picks:**
  - **(a) Defect-shaped (recommend for F23):** files `messaging-config.service.ts` (mark WA/SMS cells
    `unavailable` — the _same_ capability flag B180/B145 need — and have `setRuleEnabled` refuse to
    enable an unavailable cell) + `NotificationsSettingsTab.tsx` (render the flag). Invariant: _an
    operator cannot switch ON a cell the engine can never fire._
  - **(b) Feature-shaped (recommend DEFER):** operator-editable consent (customer form field + PATCH
    stamping `consentUpdatedAt`) and a STOP/manual opt-out writer. Net-new capability that would still
    land on a stub transport underneath (B145) — it buys nothing observable today.
- **REG test (T1):** `messaging-config.service.spec.ts` — `getMatrix()` on a fully-seeded tenant:
  **received today** the `ORDER_CONFIRMED:WHATSAPP` cell is `{ enabled: false, locked: false }` with no
  unavailable marker, and `setRuleEnabled(waRuleId, true)` **resolves** with `enabled: true`;
  **expected** the cell reports unavailable and `setRuleEnabled(..., true)` throws
  `BadRequestException` (the same shape as the G12 refusal at `:190-191`).
- **Tests that pin the wrong behavior:** `messaging.service.spec.ts:32-39` mocks
  `smsConsent: true, waConsent: true` on the happy path — it _assumes_ a consented state the product
  cannot reach. Not false-green about the gate itself (`:120-133` correctly tests the deny path), but it
  hides that the consented state is unreachable in production. No test asserts a WA cell is enableable,
  so fix (a) breaks nothing existing.
- **Siblings:** B180 and B145 (see cross-cutting). Also `PAYMENT_REMINDER`, per
  `docs/product/invoicing.md:457` — _"permitted on all customer channels but has no writer, so that
  toggle governs nothing"_ — the same class and **not currently a registry row**; worth filing if the
  lead adopts the capability-flag fix (it seeds OFF, so lower harm — the same reasoning the Verifier
  used to exclude the payment-reminder half of B180).
- **Feature-shaped:** **(a) NO, (b) YES.**
- **Tier:** T1 for (a).

---

## Overall

Six of the seven rows survive refutation as _diagnoses_; the interesting result of this pass is how
many of the _suggested fixes_ do not, and how few of these rows are the same kind of thing.

**B145 is the only High and the only row whose wrong value is durable** — a `Message` row plus an
`unreadCount` bump persisted for a delivery that never happened, and an API response saying `"sent"`.
Its cause is confirmed at `messaging.service.ts:175` (write at `:155-168`), but the record's fix is
refuted twice over: patching `StubProvider` leaves **PORTAL** — two of the three customer-facing
default-ON cells — still fabricating deliveries, and `"failed"` is the wrong word for "no transport
configured". Per **L-081** the gate belongs inside `sendMessage()`, the primitive that performs the
write. **B160** and **B182** are confirmed defects with clean T1 repros, each carrying one refuted
assumption: B160's "held" copy is false _and_ the UI default (`quietHoursEnabled ?? true`) contradicts
the engine's own default (`false` with no row); B182's "seed at provisioning" fix would fix new tenants
only and leave every existing tenant unseeded. **B180 and B183 are the same defect as B145 wearing
different clothes** — a config surface advertising capability the engine lacks — and all three collapse
into one seam: a capability declaration consulted by both `MessagingConfigService` and `sendMessage()`.
I recommend the lead rule that F23 ships **that one seam** (B145 + B180-seed + B183-greying) as its
spine, with B160's copy/default correction alongside — which is also what the committed fix card's
"untransported channels honest FIRST" ordering implies.

**Two rows should leave the batch.** **B37** is confirmed but feature-shaped (D5): a backend and a typed
client exist, a screen was never written, and the record's "just wire the hooks" fix is refuted outright
— `useMessages(runId)` is `enabled: !!runId` and `messages.service.ts:29` forbids a driver the no-runId
read, so the fix necessarily includes run resolution and a chat UI. It is also a different module
(`apps/api/src/messages`) from the rest of F23 and has **no T1 proof lane** (its only observable is a
React Native render). **B181 is refuted as a bug**: the `|| true` at `notifications.service.ts:57` is
real and deliberate, but no reachable configuration makes `true` the wrong answer (Expo needs no
credentials; `apps/mobile/lib/auth.ts:132` is the only token source and mints Expo tokens only), so it
is dead code without a wrong-value repro — F29 housekeeping, not a bug fix, and shipping it here means
shipping a row whose "proof" is the absence of a branch.

**Three constraints the lead must rule on before build.** (1) **Tiers are frozen T1** in
`F23.jsonl`/the fix card, yet B160's copy, B180's row qualifier and B183's greying are web-rendered —
provable at T1 only as RTL jest tests (precedent: `settings-users.test.tsx`); anything else is a tier
change. (2) **B180 × B146 conflict**: F11's plan for B146 fires `FAILED_DELIVERY` on stop skip, so
seeding that key OFF here could disable an alert F11 is about to build — leave `FAILED_DELIVERY` out of
the reseed or coordinate. (3) **PORTAL's classification** is a product decision, not a code fact: it has
no customer-facing reader today (`@Roles(OPERATOR)` on the thread routes, no buyer-portal messages page,
`messages.service.ts:67-71` filters INTERNAL), so honest = `skipped` — unless the lead would rather build
the portal inbox, which is feature work. Finally, four of the seven records carry stale or wrong
citations (audit: B145 `FILE_NOT_FOUND`, B180 `OUT_OF_BOUNDS`, plus B160/B183's `schema.prisma` pointers
retired by the schema-folder split `60d10e66`/#621); every one has been re-anchored above and none of the
underlying claims changed as a result.
