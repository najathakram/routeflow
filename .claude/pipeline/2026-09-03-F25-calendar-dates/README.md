# F25 — calendar-date correctness

Dev-pipeline artifacts (S1-S5) for bug-campaign batch F25 (B59 Critical, B90/B91/B118 Medium, B185 Low), transcribed from discovery report `f25-discovery.md` onto `origin/master@0cfad7ed`.

Rulings transcribed (see each artifact for the full text): (1) e2e spec **34**, project `calendar-dates`, `timezoneId: America/Los_Angeles`, deploy-only. (2) scope = verified sites only (L-008); `nextFireDate` is a non-goal. (3) B118 changes reported On-Time % history on read; accepted, no backfill. (4) D4 repair script `scripts/repair-f25-licence-dates.mjs` for the mobile-operator licence writer's pre-fix rows, owner-run. (5) timezone source of truth = `TenantConfig.timezone` via one new api helper `apps/api/src/common/calendar-date.ts`, extracted from `invoices.service.ts`. (6) web has no unit runner (D1) — web/mobile calendar helpers are byte-identical mirrors, proven by a mirror-identity pin. (7) scale = major, `ui: false`.

Files: `discovery.md`, `spec.md` (R1-R9), `test-plan.md` (T1,T2,T5-T16 + 2 unnumbered pins), `build-plan.md` (8 work packages + the exact DST-safe helper code), `pipeline-args.json`.
