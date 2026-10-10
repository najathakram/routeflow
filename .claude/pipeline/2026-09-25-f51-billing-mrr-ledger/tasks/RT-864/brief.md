### RT-864 — repro tests T6, T7, P3, P4

In `platform-admin.service.spec.ts` replace :1144 and the REG-OVERRIDE-BACKFILL-TRIAL `it` with T6/P3; add T7 (reuse the :2163 describe's catalog/`tenant.update` fixture values). wrongValue: `[1200]` (T6), `2400` (T7).
