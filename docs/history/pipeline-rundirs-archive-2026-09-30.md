# Pipeline run-dir archive (CL-1b, 2026-09-30)

59 dated run dirs under `.claude/pipeline/` (about 10.8 MB, 445 files) were removed from the working tree; the newest 14 stay.
Nothing executable reads an old run dir: `closeout.mjs`, `pipeline-ledger.mjs` and the code-map tools only touch the CURRENT run's dir and the shared `cost-ledger.jsonl` / `retro-*.md` / `.retro-marker.json`, all of which stay. The cost ledger keeps every run's row.

Source comments and registry records that cite `.claude/pipeline/<dir>/...` for an archived dir are history pointers; the content is recoverable from git.

Restore one file: `git show <sha>:.claude/pipeline/<dir>/<file>`. Restore a whole dir: `git checkout <sha> -- .claude/pipeline/<dir>`.
`<sha>` is the last commit that touched the dir (below). A machine-local tarball of all 59 dirs also exists on the machine that ran this archive (`local-assets/archive/pipeline-rundirs-2026-09-30.tar.gz`, gitignored, not authoritative).

| Run dir                                   | Files |  KB | Last commit    |
| ----------------------------------------- | ----: | --: | -------------- |
| `2026-08-30-campaign-schema-foundation`   |     4 |  13 | `e7eb16270845` |
| `2026-08-30-destructive-endpoint-guards`  |     4 |  38 | `c027a0aecf2c` |
| `2026-08-31-f02b-destructive-family`      |     4 |  49 | `f950543e6166` |
| `2026-08-31-f03-payment-truth`            |     4 |  43 | `f15994905923` |
| `2026-08-31-f04-pricing-mirrors`          |     4 |  28 | `b074a4f450d9` |
| `2026-08-31-f05-driver-at-door-money`     |     4 |  47 | `86844f883b55` |
| `2026-08-31-f06-update-order-items`       |     5 |  77 | `e6d1ab343bed` |
| `2026-08-31-f17-import-robustness`        |     1 |  21 | `b82ec14f9197` |
| `2026-08-31-f30-scan-loss`                |     3 |  21 | `5219e620b7fc` |
| `2026-09-01-F10-reopen-stop-state-guards` |     6 |  63 | `80bced166ae9` |
| `2026-09-01-F13-recurring-standing`       |     8 | 473 | `d7dcf3938fd5` |
| `2026-09-01-f07-order-lifecycle`          |     5 |  61 | `7dcf390c28ee` |
| `2026-09-01-f09-credit-notes-wallet`      |    24 | 371 | `597c72dca4a5` |
| `2026-09-02-F11-run-cancel-skip`          |     6 | 330 | `10ddc3fa7984` |
| `2026-09-02-F14-authz-matrix`             |     5 | 201 | `24421170fe68` |
| `2026-09-02-wave-a-completion`            |     8 | 427 | `d4f85fd2b607` |
| `2026-09-03-F25-calendar-dates`           |     6 | 230 | `91c5333b5a57` |
| `2026-09-03-imp-01-pricing-package`       |     6 | 271 | `22372911a213` |
| `2026-09-03-imp-02-order-merge-lock`      |     6 | 279 | `f60bd27c893b` |
| `2026-09-03-imp-03a-ddl-drift-gate`       |     6 | 321 | `f60bd27c893b` |
| `2026-09-03-registry-views`               |     1 |   8 | `91c5333b5a57` |
| `2026-09-04-F13-bugfix`                   |     7 | 220 | `d7dcf3938fd5` |
| `2026-09-04-F25-calendar-bugfix`          |     8 | 218 | `1f6483ec9de8` |
| `2026-09-04-F25-location-bugfix`          |     8 | 200 | `420eef71b77b` |
| `2026-09-04-bug-e2e-freshness-guard`      |     7 | 137 | `a5be86263d2c` |
| `2026-09-04-ocr-gate-observe-first`       |     8 | 159 | `7281e4d733b2` |
| `2026-09-04-portal-switcher`              |     7 | 190 | `7aa20e712bf9` |
| `2026-09-04-watchdog-spec-host-speed`     |     9 |  97 | `e07aa0b57919` |
| `2026-09-05-registry-guards`              |    15 | 178 | `243325d2cdcf` |
| `2026-09-05-registry-selftest-ci`         |     2 |  48 | `10ddc3fa7984` |
| `2026-09-06-F08-returns-end-to-end`       |    13 | 268 | `99d5b87a1a6e` |
| `2026-09-06-F12-route-windows`            |    11 | 244 | `1b413d071b0b` |
| `2026-09-06-F18-billing-plan-change`      |    12 | 429 | `7a2b112bea7a` |
| `2026-09-06-F23-messaging-engine`         |     8 | 181 | `f2a2736850d0` |
| `2026-09-06-campaign-check-freshness`     |    14 | 238 | `e3170422b6f2` |
| `2026-09-06-lock-liveness`                |     6 |  96 | `597c72dca4a5` |
| `2026-09-07-F16-list-caps`                |    14 | 582 | `4d97716878e5` |
| `2026-09-07-auth-redesign`                |    11 |  84 | `284b32b14987` |
| `2026-09-07-marketing-port`               |    17 | 862 | `d0ca101de328` |
| `2026-09-08-B246-scan-fab`                |     8 |  80 | `7fc01298ba29` |
| `2026-09-08-B263-scan-price-tray`         |     9 |  98 | `f52005f311a2` |
| `2026-09-08-F16b-invoice-counter`         |    10 | 128 | `85b7d53c15e0` |
| `2026-09-08-numbering-siblings`           |     8 | 151 | `1dca124248d7` |
| `2026-09-09-train1-driver-teardown`       |     7 |  50 | `8de65863431e` |
| `2026-09-09-wave-followup`                |     1 |   4 | `2025c2f1bced` |
| `2026-09-10-next-15`                      |     7 | 229 | `5b3b3c4e9219` |
| `2026-09-10-plane-sync`                   |     5 | 157 | `24233934bdaa` |
| `2026-09-10-train4-damage-report`         |     5 | 137 | `d85dce597afb` |
| `2026-09-10-train4-run-a`                 |     8 | 254 | `9ae8f443b720` |
| `2026-09-10-train4-run-b`                 |     5 | 258 | `24233934bdaa` |
| `2026-09-10-train4-run-c`                 |     8 | 113 | `36cefc1af182` |
| `2026-09-10-train4-run-d`                 |     8 | 303 | `692bdf8fd20b` |
| `2026-09-11-crm-gohighlevel-handoff`      |    22 | 380 | `0bfb58b2ee5b` |
| `2026-09-11-google-signin-monitor`        |     6 | 114 | `8f64d62820ca` |
| `2026-09-11-plane-harness`                |    11 | 219 | `24233934bdaa` |
| `2026-09-12-plane-learning`               |     4 |  71 | `24233934bdaa` |
| `2026-09-12-security-registry-tags`       |    14 | 189 | `de7b85683e88` |
| `2026-09-13-F15-customer-removal`         |     1 |  14 | `bc36a0dd285d` |
| `2026-09-13-F27`                          |     1 |   5 | `fbec7b7b1839` |
