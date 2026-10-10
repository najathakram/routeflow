### RC-863 — confirm B863 cause

`platform-admin.service.ts:963-995` no `cycle:` in either upsert branch; `billing-cron.service.ts:484-498` selects no periodStart/externalPayment, calls `addCycle(start, s.cycle)`. Probe: `cd apps/api && npx jest src/billing/billing-cron.service.spec.ts -t "REG-ROLL-MANUAL-ANNUAL"` green today.
