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
