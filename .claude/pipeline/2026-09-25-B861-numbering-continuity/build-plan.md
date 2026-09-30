# Build plan — B861 (board #2158) · SA-274

Branch `bug/2158-b861-numbering-card-never-reaches-live-invoice-num` off origin/master 21085bcb, worktree
`cool-leakey-1635b0`. Design of record: `cause-ruling.md` (SA-274 verbatim + §3 fix design). Tests:
`bug-test-plan.md`. Out of the engine (already written or run elsewhere): the read-only report
`apps/api/scripts/report-b861-numbering-config.mjs`, the DB-lane spec
`apps/api/src/import/numbering-continuity.db.spec.ts` + the T1i edit (prover-run, NEED-DB), docs.

Hard lines (every task): no schema change or migration; no caller of `reserveNext` changes its call;
the per-year loop (`mintForYear`) body is unchanged except that its scan escapes the prefix; no nested
`$transaction` on any mint path; tenant always explicit in raw SQL (L-100); never run a `*.db.spec.ts`
or anything against the compose DB (the prover owns it); no Playwright; no repo-wide suites.

### RC1 — Confirm the cause on the current tree

Reproduce with a scratch spec `apps/api/src/import/b861-rc-probe.spec.ts` (DELETE it before you
report): `NumberingService` over `createMockPrisma()`, a tx whose `numberingSequence.findUnique` returns
`{ prefix: "INV-", nextNumber: 10543, padding: 5 }` ONLY for `year: 0` and null for the calendar year,
`$queryRaw` → `[{ max: 0 }]`, `findUniqueOrThrow` → `{ prefix: "INV-", padding: 4, nextNumber: 1 }`,
`update` → `{ nextNumber: 2 }`, `invoice.findFirst` → null. Run
`cd apps/api && npx jest src/import/b861-rc-probe.spec.ts`. Named cause: `numbering.service.ts:254`
(`year > 0 && isYearScoped(docType)` → `mintForYear`, which keys on the calendar year and never reads
the year-0 row the card writes). Expected observation: `INV-2026-0001` (or the current year).

### RT1 — REG tests: service (unit)

File: `apps/api/src/import/numbering.service.spec.ts` (extend). Write REG-B861-A, B, C, D, E, F, G, H, I,
J exactly as `bug-test-plan.md` "Red set — api unit" says, with the shared tx fake it describes (models
Postgres by inspecting each raw call: `UPDATE` → GREATEST+1 RETURNING; `regexp_match` → max over a
`docs` list via JS RegExp; any other `^…` argument → taken probe; plus today's per-year surface so the
current code reaches its wrong value). Never assert SQL text. Pass not-yet-existing inputs
(`expectedNextNumber`) through `as any` so the file compiles today.
Also, in the same edit (harness, green before AND after the fix): key every existing reserveNext test's
`findUnique` mock on `where.tenantId_docType_year.year` (0 → null); wire the tx fake into the existing
getSettings/updateSettings tests; apply the three SA-274 amendments listed under "Amended on SA-274's
word" (remove the changed assertions — their new values live in E/F/I; retarget P2 to `RETURN`).
Run: `cd apps/api && npx jest src/import/numbering.service.spec.ts --runInBand`. Every REG-B861 test
fails on an assertion; every other test passes. wrongValue `INV-2026-0001`.

### RT2 — REG test: controller (unit)

New file `apps/api/src/import/numbering.controller.spec.ts`: REG-B861-K per the plan (NumberingService
mocked at the module boundary via `Test.createTestingModule`). Run:
`cd apps/api && npx jest src/import/numbering.controller.spec.ts`. wrongValue `PAY-0001`.

### RT3 — REG tests: web card (RTL)

New file `apps/web/app/(dashboard)/settings/import/numbering-card.test.tsx`: REG-B861-L, REG-B861-M and
pin P-4 per the plan. Render `SettingsImportPage` (default export of `page.tsx`); mock
`@/lib/api/numbering` (keep `formatDocumentNumber` via `jest.requireActual`), `@/lib/api/import-resolution`,
`@/lib/page-title-context`, and whatever else the page needs to render; follow an existing settings page
test in `apps/web/app/(dashboard)/settings/` for the providers/mocks idiom. Select inputs by their
aria-labels (`Invoices prefix`, …) — never by layout classes (L-212). Pass `expectedNextNumber` through
`as any` where TypeScript does not know it yet. Run:
`cd apps/web && npx jest "app/\(dashboard\)/settings/import/numbering-card.test.tsx"`.
wrongValue `"padding": 5`.

### FIX1 — Service: the saved card row drives live minting (SA-274)

Files: `apps/api/src/import/numbering.service.ts`, `apps/api/src/import/dto/update-numbering.dto.ts`,
`apps/api/src/import/numbering.controller.ts` (doc comments only), and
`apps/api/src/import/numbering.service.spec.ts` for HARNESS-ONLY adjustments (never change or delete a
REG-B861 assertion). Implement `cause-ruling.md` §3 D1–D3 exactly. The tricky parts:

```ts
/** Postgres ARE metacharacters, backslash-escaped, so a tenant prefix is matched literally. */
const escapeRegex = (s: string): string => s.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
```

- `scanMaxForYear(db, docType, tenantId, year, prefix)`: pattern
  `` `^${escapeRegex(prefix)}${year > 0 ? `${year}-` : ""}(\\d{1,9})(?:-R\\d+)?$` `` — the three literal
  table branches unchanged.
- `findTakenNumeric(db, docType, tenantId, prefix, n): Promise<string | null>` — returns the stored
  number of a tenant document matching `` `^${escapeRegex(prefix)}0*${n}(?:-R\\d+)?$` `` (`~`, `LIMIT 1`,
  three literal branches), else null.
- `reserveNext`: for `isYearScoped(docType)` run ONE `mintYearScoped(db, …)` on `opts.tx` if given, else
  in one `this.prisma.tenantTransaction(...)` (never both, never nested). Order: (1)
  `db.numberingSequence.findUnique({ where: { tenantId_docType_year: { tenantId, docType, year: 0 } } })`
  → saved → `mintConfigured`; (2) `year > 0` → `mintForYear` (unchanged); (3) else
  `BadRequestException` — a mint never creates a year-0 row. Non-year-scoped types: fast path unchanged.
- `mintConfigured` (≤ 5 attempts, then `ConflictException` like `mintForYear`): scan max with year 0 →

```sql
UPDATE "NumberingSequence"
SET "nextNumber" = GREATEST("nextNumber", ${max + 1}) + 1, "updatedAt" = NOW()
WHERE "tenantId" = ${tenantId} AND "docType" = ${docType}::"DocumentNumberType" AND "year" = 0
RETURNING "nextNumber", "prefix", "padding"
```

(via `db.$queryRaw`) → `reserved = nextNumber - 1`, candidate `this.format(prefix, reserved, padding)`
(no year) → `findTakenNumeric` null → return (warn-log when `reserved` > the saved `nextNumber`, naming
tenant and docType like `mintForYear`); taken → next attempt re-scans with the RETURNING prefix.

- `getSettings()`: `requireTenant()`; keep `findMany({ where: { year: 0 } })` byte-identical; three rows;
  previews computed inside ONE `tenantTransaction` read: saved → `format(prefix, Math.max(nextNumber,
max + 1), padding)`; unsaved → per-year row's `nextNumber` (else scan+1) with the loop's first-clash
  jump mirrored read-only (`findTaken` exact, ≤ 5), formatted with the year. `nextNumber` returned is the
  STORED value (the card's version token); unsaved → 1.
- `updateSettings(docType, dto)`: `requireTenant()`; `existing` = year-0 row. (a) `dto.expectedNextNumber`
  given and `(existing?.nextNumber ?? 1) !== expected` → `ConflictException` ("… numbering changed since
  you opened it — reload and try again"). (b) `dto.nextNumber` given and `≤ max` for the effective prefix
  (`dto.prefix ?? existing?.prefix ?? default`) → `BadRequestException` naming `findTakenNumeric(…, max)`
  and `max + 1`. (c) write: no `expectedNextNumber` → today's `upsert`, unchanged; with it → existing
  row: `updateMany({ where: { tenantId, docType, year: 0, nextNumber: expected }, data })`, count 0 →
  409; no row → `create`, P2002 → 409. Return the row with the true preview, `configured: true`.
- DTO: `@IsOptional() @IsInt() @Min(1) @Max(2_000_000_000) expectedNextNumber?: number;`
- `DOCUMENT_NUMBER_TYPES` → the three year-scoped types (keep its exported type `DocumentNumberType[]`
  so the controller's `includes` compiles); fix the stale comments (four → three; the card's row is live).

### FIX2 — Web card: send only what changed, drop PAYMENT, honest copy

Files: `apps/web/lib/api/numbering.ts`, `apps/web/app/(dashboard)/settings/import/page.tsx`.

- `numbering.ts`: `DocumentNumberType` → `"INVOICE" | "ESTIMATE" | "CREDIT_NOTE"`; `UpdateNumberingInput`
  gains `expectedNextNumber?: number`; `useUpdateNumbering` invalidates on settle (so a 409 refetches).
- `page.tsx` NumberingCard: drop PAYMENT from `DOC_TYPE_LABELS`; each draft keeps the values it was seeded
  from (`loaded`); dirty = draft ≠ loaded; `save` sends only the fields that differ from `loaded` plus
  `expectedNextNumber: loaded.nextNumber` (validate `nextNumber` only when it changed); success re-seeds
  draft+loaded from the returned row; a 409 drops that type's draft so it re-seeds from the refetch and
  toasts the server message. Copy (replace the paragraph at ~495): "Continue where your old system left
  off. Set the prefix and next number for each document type (last invoice INV-08841 → next INV-08842)
  and save. Until you save a row, that type keeps the yearly series (INV-2026-0001, INV-2026-0002…). New
  numbers always continue after the highest one already on file, so imported documents keep their
  numbers and nothing is issued twice." Nothing else on the page changes.

### RP1 — Revert probe: service

`file: apps/api/src/import/numbering.service.ts`, `test:` the RT1 REG command. Must go red.

### RP2 — Revert probe: web

`file: apps/web/app/(dashboard)/settings/import/page.tsx`, `test:` the RT3 REG command. Must go red.

## Pipeline args

```json
{
  "buildPlanPath": ".claude/pipeline/2026-09-25-B861-numbering-continuity/build-plan.md",
  "testPlanPath": ".claude/pipeline/2026-09-25-B861-numbering-continuity/bug-test-plan.md",
  "scriptsDir": "/Users/maznahamanullah/.claude/skills/dev-pipeline/scripts",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "runDir": ".claude/pipeline/2026-09-25-B861-numbering-continuity",
  "startedAt": "<ISO at launch>",
  "scale": "major",
  "mode": "bugfix",
  "lane": "high-risk",
  "profile": "standard",
  "workdir": "/Users/maznahamanullah/code/routeflow/.claude/worktrees/cool-leakey-1635b0",
  "context": "B861 / SA-274: a saved Numbering-card row (year 0) becomes the live continuous series for INVOICE/ESTIMATE/CREDIT_NOTE; max-first numeric guard; 400/409 on save; PAYMENT dropped from the card.",
  "siblingPatterns": [
    {
      "pattern": "regexp_match\\(|~\\*? \\$\\{",
      "note": "raw-SQL regex built from an interpolated value — the unescaped-prefix class"
    },
    {
      "pattern": "numberingSequence\\.(upsert|update|create|updateMany)\\(",
      "note": "writers of the numbering store outside numbering.service.ts"
    },
    {
      "pattern": "(INV|EST|CN|RET|ORD)-\\$\\{[A-Za-z.]*[yY]ear[A-Za-z()]*\\}-",
      "note": "per-year document numbers built by hand from a local counter outside NumberingService (import-zoho / backfill-invoices class)"
    }
  ],
  "tasks": [
    {
      "id": "RC1",
      "title": "Confirm the cause on the current tree",
      "type": "root-cause",
      "files": [],
      "tests": [],
      "dependsOn": []
    },
    {
      "id": "RT1",
      "title": "REG tests: service (unit)",
      "type": "repro-test",
      "files": [],
      "tests": ["apps/api/src/import/numbering.service.spec.ts"],
      "dependsOn": ["RC1"],
      "wrongValue": "INV-2026-0001"
    },
    {
      "id": "RT2",
      "title": "REG test: controller (unit)",
      "type": "repro-test",
      "files": [],
      "tests": ["apps/api/src/import/numbering.controller.spec.ts"],
      "dependsOn": ["RC1"],
      "wrongValue": "PAY-0001"
    },
    {
      "id": "RT3",
      "title": "REG tests: web card (RTL)",
      "type": "repro-test",
      "files": [],
      "tests": ["apps/web/app/(dashboard)/settings/import/numbering-card.test.tsx"],
      "dependsOn": ["RC1"],
      "wrongValue": "\"padding\": 5"
    },
    {
      "id": "FIX1",
      "title": "Service: the saved card row drives live minting (SA-274)",
      "type": "fix",
      "files": [
        "apps/api/src/import/numbering.service.ts",
        "apps/api/src/import/dto/update-numbering.dto.ts",
        "apps/api/src/import/numbering.controller.ts",
        "apps/api/src/import/numbering.service.spec.ts"
      ],
      "tests": [],
      "dependsOn": ["RC1", "RT1", "RT2"],
      "risk": "HIGH",
      "radius": [8, 20]
    },
    {
      "id": "FIX2",
      "title": "Web card: send only what changed, drop PAYMENT, honest copy",
      "type": "fix",
      "files": [
        "apps/web/lib/api/numbering.ts",
        "apps/web/app/(dashboard)/settings/import/page.tsx"
      ],
      "tests": [],
      "dependsOn": ["RC1", "RT3"],
      "radius": [5, 10]
    },
    {
      "id": "RP1",
      "title": "Revert probe: service",
      "type": "revert-probe",
      "file": "apps/api/src/import/numbering.service.ts",
      "test": "cd apps/api && npx jest src/import/numbering.service.spec.ts -t \"REG-B861\" --runInBand",
      "dependsOn": ["FIX1"]
    },
    {
      "id": "RP2",
      "title": "Revert probe: web",
      "type": "revert-probe",
      "file": "apps/web/app/(dashboard)/settings/import/page.tsx",
      "test": "cd apps/web && npx jest \"app/\\(dashboard\\)/settings/import/numbering-card.test.tsx\" -t \"REG-B861\"",
      "dependsOn": ["FIX2"]
    }
  ],
  "verifyCommands": {
    "perRound": [
      "cd apps/api && npx tsc --noEmit",
      "cd apps/api && npx jest src/import --runInBand",
      "cd apps/web && npx tsc --noEmit",
      "cd apps/web && npx jest \"app/\\(dashboard\\)/settings/import\""
    ],
    "final": [
      "cd apps/api && npx tsc --noEmit",
      "cd apps/api && npx eslint src/import/numbering.service.ts src/import/numbering.controller.ts src/import/dto/update-numbering.dto.ts src/import/numbering.service.spec.ts src/import/numbering.controller.spec.ts",
      "cd apps/api && npx jest src/import src/common/owner-report-db-url.spec.ts --runInBand",
      "cd apps/web && npx tsc --noEmit",
      "cd apps/web && npx eslint lib/api/numbering.ts \"app/(dashboard)/settings/import/page.tsx\" \"app/(dashboard)/settings/import/numbering-card.test.tsx\"",
      "cd apps/web && npx jest \"app/\\(dashboard\\)/settings/import\""
    ]
  },
  "formatCommand": "git ls-files -mo --exclude-standard | grep -E '[.](ts|tsx|mjs)$' | grep -v '^[.]claude/' | xargs -r npx prettier --write"
}
```
