# Area: web (`apps/web`)

Next.js 14 App Router operator/buyer dashboard with multi-tenant Radix + Tailwind UI; the
**golden reference** for API flows and DTOs; dev on `:3001`.

> **2026-09-13 split** (`docs/code-map-split-land`): this file used to hold ALL of web's
> signature-level content (311,043 bytes — over 3x the 100,000-byte area cap). The content
> below was moved verbatim into the part files under `web/` (see `_meta.json.notes` for the
> row-count proof). This file is now a table of contents only.

## Module index

| Part                                                 | Covers                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [web/where-to-find.md](web/where-to-find.md)         | Where to find (this area) — need/symptom → file/symbol                                                 |
| [web/app-shell-lib.md](web/app-shell-lib.md)         | App shell & lib                                                                                        |
| [web/routes-1.md](web/routes-1.md)                   | Routes (1/3): `(auth)/`, `(dashboard)/`                                                                |
| [web/routes-2.md](web/routes-2.md)                   | Routes (2/3): `(dashboard)/` continued + the 2026-08-25 customer-feedback / sale-integrity WP5 batches |
| [web/routes-3.md](web/routes-3.md)                   | Routes (3/3): `(platform-admin)/`, `buyer/`, `(marketing)/`, top-level                                 |
| [web/unit-tests.md](web/unit-tests.md)               | Unit tests (Jest + RTL, wave D)                                                                        |
| [web/e2e-tests.md](web/e2e-tests.md)                 | E2E tests (`apps/web/e2e/`)                                                                            |
| [web/components-shared.md](web/components-shared.md) | Components & shared                                                                                    |
| [web/api-hooks.md](web/api-hooks.md)                 | API hooks (`lib/api/`)                                                                                 |
| [web/catchup-2026-09-21.md](web/catchup-2026-09-21.md) | Catch-up 2026-09-21: restrictions UI, product labels, PO tab, scan-to-order, credit-limit guard, config snapshots tab |
| [web/landing-2026-10-12-r52-tail.md](web/landing-2026-10-12-r52-tail.md) | Landing 2026-10-12 R5.2 tail: super-admin automatic-locks card and reason input |
| [web/landing-2026-10-16-bk.md](web/landing-2026-10-16-bk.md) | Landing 2026-10-16: buyer cart line, product detail Batch A, portal-hide admin, serial scan queue |
| [web/landing-2026-10-16-bk2.md](web/landing-2026-10-16-bk2.md) | Landing 2026-10-16 (2nd): product price grid, credit-limit box, payment-due banner |
| [web/landing-2026-10-17-bk3.md](web/landing-2026-10-17-bk3.md) | Landing 2026-10-17 (3rd): product page saves the bare variant name, coded toast copy |
| [web/landing-2026-10-18-fixes-4.md](web/landing-2026-10-18-fixes-4.md) | Landing 2026-10-18 fixes-4: K11 jump strip and customer view, product page, New product piece price, password policy |
| [web/landing-2026-10-18-k11-money1.md](web/landing-2026-10-18-k11-money1.md) | Landing 2026-10-18 k11-money1: one floating price editor, price figures, limit=0 removal, price history chips |
| [web/landing-2026-10-20-bo-train-g1.md](web/landing-2026-10-20-bo-train-g1.md) | Landing 2026-10-20 bo-train/G1 (#3551): Capabilities card, activation add-on checklist, till permissions, SendInvoiceModal |
| [web/landing-2026-10-17-units-v2-3.md](web/landing-2026-10-17-units-v2-3.md) | Landing 2026-10-17 units-v2-3: price layer, units settings, K-cards, product image actions |
| [web/landing-2026-10-12-r52.md](web/landing-2026-10-12-r52.md) | Landing 2026-10-12 Release 5.2: edit rebase on 409, read-only gate and copy, billing card, counter QA polish, paid-at-sale |
| [web/landing-2026-10-12-r51-r42.md](web/landing-2026-10-12-r51-r42.md) | Landing 2026-10-12 Release 5.1 + 4.2: READ_ONLY refusal copy, hand-over stamp and rows, day close and Z wording, store-only header, edit log |
| [web/landing-2026-10-12-macbook.md](web/landing-2026-10-12-macbook.md) | Landing 2026-10-12 MacBook lane (pushed): merged-draft POS confirm, delivery + POS profile UI, dashboard KPIs never zero |
| [web/landing-2026-10-11-r4.md](web/landing-2026-10-11-r4.md) | Landing 2026-10-11 Release 4: email receipt, counter pass 2, last 7 days, refund slip, POS order page, revision marks |
| [web/landing-2026-10-11-r41.md](web/landing-2026-10-11-r41.md) | Landing 2026-10-11 Release 4.1: day close form and Z view, store-only invoice entry, receipt cashier, closed-day copy |
| [web/landing-2026-10-11-r5.md](web/landing-2026-10-11-r5.md) | Landing 2026-10-11 Release 5: billing strip, read-only gate (WriteButton), Billing status card, buyer seller-unavailable line, profile comps |
| [web/landing-2026-10-10-w22a2-w23.md](web/landing-2026-10-10-w22a2-w23.md) | Landing 2026-10-10 W22a-2 + W23: quick keys, create tenant, readiness card, park, void, zone UI, unit words |
| [web/landing-2026-10-09-w21b-w22a1.md](web/landing-2026-10-09-w21b-w22a1.md) | Landing 2026-10-09 W21b + W22a-1: counter price edit, leave guard, live cart persist, discount reapply, variant pickers, family cascade |
| [web/landing-2026-10-08-w21a.md](web/landing-2026-10-08-w21a.md) | Landing 2026-10-08 W21a: counter refund or store credit, Today's sales, register look and exit guard, Settings > Fulfillment (dark) |
| [web/landing-2026-10-06-w4-w10.md](web/landing-2026-10-06-w4-w10.md) | Landing 2026-10-06 (windows 4 to 10): order actions by role, business profile picker, billing confirm sheets, order suggestions |
| [web/landing-2026-10-01-w12-w27.md](web/landing-2026-10-01-w12-w27.md) | Landing 2026-10-01 w12-w27: settings hub, PO route/detail/scan, scan level/aim/hold, shell handoff, CN edit/void |
