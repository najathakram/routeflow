# Build plan — F23 (messaging engine honesty) — bug-pipeline, mode bugfix, scale small

Base master `12cdc26a`; worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09`; branch `fix/F23-messaging-engine`.
Design of record: `cause-ruling.md` §2 (one capability seam). Tests of record: `bug-test-plan.md`. One PR (D6). Commits carry `Bookkeeping-Follow-Up: pending`.

## Check (SETTLED by the lead on 12cdc26a, 2026-09-06)

`grep -rn "NotificationEvent.FAILED_DELIVERY" apps/api/src --include=*.ts | grep -v -E "/messaging/|\.spec\.ts"` → no firing site. Therefore `FAILED_DELIVERY` is DROPPED from `DEFAULT_ON` with the other three, the allowlist in `default-on-is-wired.spec.ts` is EMPTY, and the PR body carries the F11/B146 coordination note. Baseline re-runs the grep and records the answer; if it now finds a site, keep the key and allowlist it with a comment naming the file.

## Packages

| id  | title                                                                                                     | files                                                                                                                                                                | effort | dependsOn | brief                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | capability seam in the engine (B145)                                                                      | `apps/api/src/messaging/providers/message-provider.interface.ts`, `apps/api/src/messaging/providers/stub.provider.ts`, `apps/api/src/messaging/messaging.service.ts` | high   | —         | ruling §2: `transports(channel)`; stub declares none; `skip("NO_TRANSPORT")` after quiet-hours computation, before record+bump; `SkipReason` gains `NO_TRANSPORT`; INTERNAL untouched. Make T1/T2 green; T10 pins green (mock provider declares transports). |
| P2  | config surface: unavailable cells, DEFAULT_ON, seeding, settings default (B180 + B182 + B183a + B160 api) | `apps/api/src/messaging/messaging-config.service.ts`, `apps/api/src/messaging/messaging.service.ts`                                                                  | high   | P1        | ruling §2: `MatrixCell.unavailable`; `setRuleEnabled` refuses unavailable; `DEFAULT_ON` trimmed per the Check; shared `seedDefaultsFor` called from `notify()` when no rules; `getSettings()` default `quietHoursEnabled:false`. Make T3/T6/T7/T8 green.     |
| P3  | static guard (B180)                                                                                       | `apps/api/src/messaging/default-on-is-wired.spec.ts`                                                                                                                 | low    | P2        | T5 exactly (precedent `apps/api/src/common/no-bare-cron.spec.ts`); allowlist per the Check.                                                                                                                                                                  |
| P4  | web tab: qualifiers + honest copy (B160 + B180 web)                                                       | `apps/web/app/(dashboard)/settings/_components/NotificationsSettingsTab.tsx`, `apps/web/lib/api/messaging.ts` (type gains `unavailable`)                             | medium | P2        | ruling §2 web; targeted edits; RTL tests T4/T9 green.                                                                                                                                                                                                        |

Non-goals: B37 (feature, deferred), B181 (refuted; F29 housekeeping), B183(b) consent writers, a quiet-hours hold queue, a portal inbox, any provider implementation, any migration.

## Test packages (authored BEFORE implementation)

| id     | files                                                                                                                                                                                                                                         | tests                    | effort | brief                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| TP-API | `apps/api/src/messaging/messaging.transport-honesty.spec.ts` (new), `apps/api/src/messaging/messaging-config.service.spec.ts`, `apps/api/src/messaging/messaging.service.spec.ts`, `apps/api/src/messaging/default-on-is-wired.spec.ts` (new) | T1 T2 T3 T5 T6 T7 T8 T10 | high   | `bug-test-plan.md` exactly incl. Harness notes (mock provider declares transports; rewrite `:135-150`); implement nothing. |
| TP-WEB | `apps/web/app/(dashboard)/settings/notifications-settings.test.tsx` (new)                                                                                                                                                                     | T4 T9                    | medium | RTL per the `settings-users.test.tsx` precedent; implement nothing.                                                        |

## Gates

- Red gate: `cd apps/api && npx jest src/messaging --runInBand -t "REG-B(145|160|180|182|183)"` and `cd apps/web && npx jest --runInBand -t "REG-B(160|180)"` → fail today.
- perRound: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` · `cd apps/api && npx jest src/messaging src/messages src/notifications --runInBand` · `cd apps/web && npx tsc --noEmit -p tsconfig.json`
- final: `cd apps/api && npx jest --silent` · `cd apps/web && npx jest --silent` · `node scripts/validate-lessons.mjs`
- Probe (revert-fix): `messaging.service.ts` → REG-B145.

## Pipeline args

See `pipeline-args.json`.
