# Fix ruling — F23 (B145 · B160 · B180 · B182 · B183a; B181 refuted; B37 deferred) messaging engine honesty

> Fable @ high, 2026-09-06, over `cause-brief.md` (S1) and `refutation.md` (S2) in this dir (pre-planned read-only
> against master 12cdc26a) and the committed fix card `.claude/pipeline/fix-cards/F23-messaging-notification-honesty.md`.
> Worktree `rf-F09`, branch `fix/F23-messaging-engine`. AGENT-SAFE (owner's blanket go). One PR (D6).

## 1. Cause verdicts (from S2)

| Bug  | Verdict                               | Diverging line                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B145 | confirmed (record's fix REFUTED)      | `messaging.service.ts:147-176`: the record+bump runs regardless; `StubProvider` (`providers/stub.provider.ts:21`) returns `status:"queued"` and can never fail → `outcome:"sent"` + a `Message` row + `unreadCount` bump for a delivery that never transported. Patching the stub leaves PORTAL fabricating; `"failed"` is the wrong word. |
| B160 | confirmed                             | `messaging.service.ts:127-133` computes quiet hours, `:148/:175` discard it; `messaging-config.service.ts:228` defaults `quietHoursEnabled` to `true` when no row exists while the engine's default is false; `NotificationsSettingsTab.tsx:519` copy claims a hold.                                                                       |
| B180 | confirmed                             | `messaging-config.service.ts:78-86` `DEFAULT_ON` seeds `URGENT_ORDER_PLACED`, `LOW_STOCK`, `FAILED_DELIVERY`, `PAYMENT_FAILED_NSF` ON with zero firing sites.                                                                                                                                                                              |
| B182 | confirmed                             | `seedMissing()` is private and reachable only via `getMatrix()` ← `GET /messaging/config` (settings tab); `notify()` never seeds → `[]` rules for a never-visited tenant.                                                                                                                                                                  |
| B183 | confirmed; primary fix FEATURE-SHAPED | consent flags default `false` (`sales.prisma:164-165`) with zero writers; WA/SMS cells render as ordinary enableable switches. Only shape (a) ships.                                                                                                                                                                                       |
| B181 | REFUTED as a bug                      | `notifications.service.ts:57` `                                                                                                                                                                                                                                                                                                            |     | true`is dead code with no reachable wrong value (Expo-only). Registry →`refuted`; F29 housekeeping. |
| B37  | confirmed, FEATURE-SHAPED (D5)        | run chat has a backend + typed client and no screen; different module. **Deferred**, not built.                                                                                                                                                                                                                                            |

## 2. Fix design — ONE seam: a capability declaration consulted by config AND send (L-081)

- **`MessageProvider` interface** (`providers/message-provider.interface.ts`) gains `transports(channel): boolean`; `StubProvider` declares NONE. `sendMessage()` (`messaging.service.ts`) returns `skip("NO_TRANSPORT")` for any channel ≠ INTERNAL whose provider does not transport it, placed AFTER the quiet-hours computation (`:133`) and BEFORE the record+bump block (`:139`); `SkipReason` gains `"NO_TRANSPORT"`. INTERNAL stays `"sent"` (in-app rows are read by `messages.service.ts:67-71`). **PORTAL ruling:** no customer-facing reader exists → honest = skipped today; a portal inbox is FILED as a feature.
- **Invariant (B145):** `outcome === "sent"` ⟺ a `Message` row was written ⟺ a configured transport (or INTERNAL) accepted the payload.
- **`MatrixCell.unavailable?: "NO_TRANSPORT" | "NO_CONSENT_WRITER" | "NO_TRIGGER"`** exposed by `MessagingConfigService.getMatrix()` from the same capability + the consent facts (B183a) + the wired-events set (B180); `setRuleEnabled(id, true)` refuses an unavailable cell with `BadRequestException` (same shape as the G12 refusal `:190-191`).
- **B180 seed:** drop ALL FOUR unwired keys from `DEFAULT_ON` — `URGENT_ORDER_PLACED`, `LOW_STOCK`, `FAILED_DELIVERY`, `PAYMENT_FAILED_NSF`. S3 check on 12cdc26a (2026-09-06): `NotificationEvent.FAILED_DELIVERY` has NO firing site outside `messaging/` — B146 (F11, done) reconciles a skipped stop but never emits the event — so the allowlist is EMPTY and the PR body carries a one-line F11/B146 coordination note (re-add the key in the same PR that adds the trigger). Static guard spec `default-on-is-wired.spec.ts` (precedent `no-bare-cron.spec.ts`) with an explicit, empty allowlist array.
- **B182:** make the seeder shared (`seedDefaultsFor(tenantId)`), call it from `notify()` when `rules.length === 0` (`createMany` with `skipDuplicates`), so every existing tenant gets the documented matrix on first use; no provisioning change, no backfill script.
- **B160 (shape a):** `getSettings()` returns `quietHoursEnabled: false` when no row exists (engine default); the settings card copy states quiet hours are recorded, not yet enforced (no "held" claim). No hold queue (feature — deferred).
- **Web:** `NotificationsSettingsTab.tsx` renders `unavailable` cells as a qualifier ("Not available: no transport configured" / "needs customer consent" / "no trigger yet") instead of a live switch; copy change for B160.
- **Must NOT change:** the INTERNAL path; `messages.service.ts`; the deny-path consent test (`messaging.service.spec.ts:120-133`); no migration; no provider implementation beyond the capability method.

## 3. Regression tests — `bug-test-plan.md` (T1–T10). Tokens `REG-B145`, `REG-B160`, `REG-B180`, `REG-B182`, `REG-B183`.

## 4. Blast radius (read-only neighbours)

`apps/api/src/messages/messages.service.ts`, `apps/api/src/messaging/messaging.helpers.ts`, `apps/api/src/notifications/notifications.service.ts`, `apps/api/prisma/schema/sales.prisma`, `apps/api/prisma/schema/platform.prisma`.

## 5. Sibling patterns

- `status: "queued"` — a provider status that is not a delivery outcome.
- `\?\? true` in `messaging-config.service.ts` — a UI default that may contradict the engine default.
- `isConfigured\(\)[\s\S]{0,80}\|\| true` — a capability check hard-coded true.

## 6. Data repair

`Message` rows with `channel ∈ {EMAIL, PORTAL, WHATSAPP, SMS}` written by the stub (never transported) and their `unreadCount` bumps: a read-only report script (count per tenant/channel, owner-run) is FILED as a follow-up; no repair bundled.

## 7. Probe plan (`revertFix: true`)

| File                                          | REG test that must go red |
| --------------------------------------------- | ------------------------- |
| `apps/api/src/messaging/messaging.service.ts` | REG-B145 (T1)             |

## 8. Close-out bindings

Registry: `prove` B145/B160/B180/B182/B183 (all T1; the web copy/qualifier halves are RTL jest tests, tier unchanged); B181 → `refuted` with the S2 evidence; B37 → deferred feature (D5) at the next owner review. New rows to file: portal inbox (feature), `PAYMENT_REMINDER` toggle governs nothing (docs/product/invoicing.md:457), stub-written Message rows report script, B37 if the owner wants the chat screen built. Lesson (archive TWO; id from `nextId`) + code map in the docs follow-up.
