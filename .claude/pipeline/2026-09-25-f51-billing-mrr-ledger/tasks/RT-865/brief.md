### RT-865 — repro tests T8-T14, P5-P7

`addon.service.spec.ts`: replace REG-ADMIN-ADDON-MRR with T8; add T9-T11, P5, P6 + the harness edits (test-plan). `subscription-mutation.service.spec.ts`: T12, T13, P7 + harness edits. NEW `apps/api/src/billing/addon-ledger.spec.ts`: T14 (imports `./addon-ledger`, created by FIX-865A). wrongValues: `undefined` (T8/T9), `[]` (T10), `resolved` (T11), `[24]` (T12), `-24` (T13).
