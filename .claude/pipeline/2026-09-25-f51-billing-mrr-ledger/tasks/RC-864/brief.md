### RC-864 — confirm B864 cause

`platform-admin.service.ts:1439-1461`: no status/class read, emit unconditional; `reconcilePriceLedger` no-ops (snapshot already 1200); activation :1001-1037 emits +1200 again. Probe: `-t "REG-OVERRIDE-BACKFILL-TRIAL"` green today.
