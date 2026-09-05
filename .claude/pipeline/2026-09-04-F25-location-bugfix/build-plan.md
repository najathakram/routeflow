# Build plan: F25-location bugfix — B185

> **Stage S5 — "how".** Authored by Fable 5 on 2026-09-04.
> Status: `DRAFT`
> Written AFTER [bug-test-plan.md](./bug-test-plan.md).
> Inputs: [cause-brief.md](./cause-brief.md) (S1), [refutation.md](./refutation.md) (S2),
> [cause-ruling.md](./cause-ruling.md) (S3), [bug-test-plan.md](./bug-test-plan.md) (T#).
> `mode: 'bugfix'`, `scale: 'small'` — this is a 2-app, ~4-file diff with no schema change and no UI surface.

**Gate to pass before S6:** every work package declares `satisfies:` and `provenBy:` (T#s).

---

## Preamble (small scale)

- **Problem:** a stationary/indoor iOS driver's GPS ping carries `heading: -1`/`speed: -1` (the platform's
  "unavailable" sentinel); the tracker forwards these unmapped, `PostLocationDto`'s `@Min(0)` rejects the
  whole ping with a 400, and the tracker's empty `catch` swallows it silently — the live operator map loses
  that driver's breadcrumb with no error anywhere. Separately, `DriverLocation.accuracy` already exists in
  the schema (pre-provisioned by a prior batch, `schema.prisma:928-931`, comment naming this exact batch) but
  nothing reads, validates, or writes it.
- **Who hits it:** any driver whose phone is stationary or indoors on iOS (warehouse dock, waiting at a
  gate) — an intermittent, silent gap in live-map tracking; Android is unaffected by the 400 (it sends `0`
  instead of `-1`, a separate, out-of-scope defect).
- **Success signal:** a stationary/indoor iOS ping is accepted (200, one `DriverLocation` row written) where
  it is 400'd and dropped today.
- **Requirements:**
  - `R1` — must: the mobile tracker maps a negative or null `heading`/`speed` to `null` before POSTing,
    at both payload-construction sites.
  - `R2` — must: `PostLocationDto` gains an optional, non-negative `accuracy` field that a client MAY send.
  - `R3` — must: `heading`/`speedKph`'s existing `@Min(0)` constraint is UNCHANGED (a present negative value
    is still rejected — only `null` is now a legal way to say "unavailable").
  - `R4` — should: `drivers.service.ts` persists `accuracy` when the DTO carries it.
- **Non-goals (scope fence):** the empty-catch swallow at `location-tracker.native.ts:20-23` (documented,
  deliberate, out of scope — note as a PR-body follow-up); the null-island / coordinate-plausibility check
  (no wrong-value repro exists — hardening, not a bug, per `cause-ruling.md` §1); Android's false-zero
  behavior (a different, unfiled defect); `routes.service.ts`'s live-map reader (explicitly untouched).

**Sufficient-for-small checklist:** `scale: 'small'` — 4 production files (`location-tracker.native.ts`,
`location-payload.ts` NEW, `post-location.dto.ts`, `drivers.service.ts`; the test files this plan mandates
do not count toward the bound); no UI surface added or changed; not itself money/auth/tenancy/migration/PII
(though `drivers.service.ts` sits inside a HIGH-risk-adjacent module for other reasons — reviewed at `high`
effort out of caution, see WP-API-LOC below, not because this diff itself is HIGH-risk); the problem was
already agreed via S1/S2/S3; four requirements.

---

## Constraints & conventions

- **Stack / test runner:** mobile — Jest, pure-logic only, `apps/mobile/__tests__/*.test.ts`,
  `testEnvironment: "node"`. Api — Jest, `apps/api/src/**/*.spec.ts`, `class-validator`/`class-transformer`
  DTOs validated via `Test.createTestingModule` conventions or direct `validate(plainToInstance(...))` calls
  (both patterns exist in this codebase; `post-location.dto.spec.ts` is NEW, so either is acceptable — direct
  `validate()` is simpler for a DTO-only spec and needs no Nest testing module).
- **Existing patterns to copy:** the DTO's own existing shape (`@IsOptional() @Type(() => Number) @IsNumber()
@Min(0) @Max(...)`) for `heading`/`speedKph`/`batteryPct` — `accuracy` follows the same additive-optional
  shape, minus a `@Max` (the schema column `Decimal? @db.Decimal(8,2)` is unbounded and no evidence names a
  plausible upper bound).
- **Must NOT change:** `routes.service.ts:750-761` (the live-map reader); `main.ts:144-150`'s
  `ValidationPipe` options; the empty catch at `location-tracker.native.ts:20-23`; `heading`/`speedKph`'s
  `@Min(0)`/`@Max` bounds.
- **Do-not-introduce list (repo-wide):** Vitest, Biome, Supabase, Vercel, a second HTTP client, a root-level
  test runner or root ESLint config.
- **Landmines:** `forbidNonWhitelisted: true` (`main.ts:148`) means the DTO must gain `accuracy` BEFORE any
  mobile build sends it, or every ping 400s on both platforms — see the Risks section. `postLocation` in
  `location-tracker.native.ts` is module-private (not exported) with exactly two call sites (`:32`, `:78`) —
  confirmed by S2's grep; both must be updated together.

---

## Test packages

### TP-LOC — seam extraction + REG/pin tests

- **writes:** `apps/mobile/lib/location-payload.ts` (NEW — seam, today's buggy/incomplete body),
  `apps/mobile/__tests__/location-payload.test.ts` (NEW, T1/T2),
  `apps/api/src/drivers/dto/post-location.dto.spec.ts` (NEW, T3/T4/T5). Edits (behaviour-preserving only):
  `apps/mobile/lib/location-tracker.native.ts` (both payload-construction sites call
  `buildLocationPayload` instead of building the object inline).
- **tests:** T1, T2, T3, T4, T5
- **brief:** exact G/W/T + oracle for each in `bug-test-plan.md`; T4's dual-assertion construction is spelled
  out there in full — copy it, do not re-derive a simpler version.
- **must fail with:** T1 `expected null received -1` (heading) / `expected null received -3.6` (speedKph);
  T2 `expected 4.5 received undefined`; T3 a `whitelistValidation` error on `accuracy`; T4 the
  `constraints` key check (see `bug-test-plan.md`'s note). T5 is a pin and must pass unchanged both before
  and after.

**Red gate command** (only REG-B185, every one must fail, none may pass):

```bash
cd apps/mobile && npx jest location-payload.test -t "REG-B185" && cd ../api && npx jest src/drivers/dto/post-location.dto.spec.ts -t "REG-B185" --runInBand
```

---

## Work packages

### WP-MOB-LOC — mobile sentinel mapping

- **files:** `apps/mobile/lib/location-payload.ts` (replace the seam body with the fixed mapping),
  `apps/mobile/lib/location-tracker.native.ts` (no further change beyond TP-LOC's call-site update — this
  package only changes the payload module's body).
- **satisfies:** R1
- **provenBy:** T1, T2
- **dependsOn:** none (test packages run before the first implementation wave by phase order — TP/WP
  ids resolve in separate `dependsOn` namespaces, so naming TP-LOC here would be a dropped, invalid edge)
- **effort:** medium
- **brief:** `buildLocationPayload`'s body becomes:
  ```ts
  export function buildLocationPayload(
    coords: {
      latitude: number;
      longitude: number;
      heading?: number | null;
      speed?: number | null;
      accuracy?: number | null;
    },
    recordedAt: string,
  ) {
    const heading = coords.heading != null && coords.heading >= 0 ? coords.heading : null;
    const speedKph = coords.speed != null && coords.speed >= 0 ? coords.speed * 3.6 : null;
    const accuracy = coords.accuracy != null && coords.accuracy >= 0 ? coords.accuracy : undefined;
    return { heading, speedKph, accuracy, recordedAt };
    // lat/lng/runId are added by each call site around this return, matching today's shape —
    // this function owns ONLY the sentinel-mapping fields per the ruling's minimal-diff instruction.
  }
  ```
  Both call sites in `location-tracker.native.ts` (`:32-39`, `:78-85`) spread this function's return
  alongside their existing `lat`/`lng`/`runId` fields — no change to how those three are built.

### WP-API-LOC — DTO + persistence

- **files:** `apps/api/src/drivers/dto/post-location.dto.ts`, `apps/api/src/drivers/drivers.service.ts`.
- **satisfies:** R2, R3, R4
- **provenBy:** T3, T4, T5
- **dependsOn:** none (same reason as WP-MOB-LOC — TP-LOC is a test package, not a valid WP dependency)
- **effort:** high (touches the driver-tracking write path that feeds the live operator map — reviewed at
  full depth per the project's "money/tenancy/auth only" default-medium rule's caution extension to
  operationally load-bearing paths; the DTO's whitelist behavior affects every driver ping, not just B185's
  repro)
- **brief:** add, after the existing `speedKph` block:
  ```ts
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  accuracy?: number;
  ```
  (no `@Max` — see Constraints). `drivers.service.ts`'s `recordLocation` (`:105-116`) `create()` call gains
  `accuracy: dto.accuracy` alongside the existing `heading`/`speedKph`/`batteryPct` fields. `heading`'s and
  `speedKph`'s own `@Min(0)`/`@Max` decorators are UNCHANGED — R3.

### WP-DOCS-LOC — close-out bookkeeping

- **files:** `.claude/campaign/status/F25.jsonl`, `.claude/code-map/api.md`, `.claude/code-map/mobile.md`,
  `.claude/code-map/_meta.json`, `.claude/code-map/CHANGELOG.md`, `.claude/lessons/LESSONS.md`,
  `.claude/lessons/_meta.json`.
- **satisfies:** (process)
- **provenBy:** verified by `node scripts/campaign-check.mjs` and `node scripts/validate-lessons.mjs`
- **dependsOn:** WP-MOB-LOC, WP-API-LOC
- **effort:** low
- **brief:** `F25.jsonl`: `B185` → `"state":"proven"` (evidence naming this spec + T1-T5 — jest-provable
  end to end, no deploy-only tier). Code-map surgical entries for `location-payload.ts` (new export
  signature), `post-location.dto.ts` (new field), `drivers.service.ts` (new persisted field) in `api.md`/
  `mobile.md`; `_meta.json` `mappedSha`/`generatedAt`/`notes` updated (notes REPLACED, never accumulated);
  CHANGELOG bullet added. **`.claude/lessons/LESSONS.md` is NOT appended again** — `L-047` was already
  written by `2026-09-04-F25-calendar-bugfix` (Run A) and its Guard line already names
  "REG-B185 DTO spec ([[L-026]] client sentinels never reach a validator unmapped)" covering this run too.
  `.claude/lessons/_meta.json` gets `updatedAt` bumped ONLY (no `activeCount` change, no new entry) — this
  is the explicit "lesson-free fix bumps `updatedAt` alone" escape, since the transferable lesson was already
  recorded by Run A. **Precondition: Run A's `WP-DOCS` must have already landed** (see `RESUME.md`'s
  sequencing rule) — if it has not, this package cannot safely bump `_meta.json` without racing Run A's own
  write to the same file.

### Package map

| WP          | satisfies  | provenBy   | dependsOn                                   | Wave           |
| ----------- | ---------- | ---------- | ------------------------------------------- | -------------- |
| TP-LOC      | —          | T1-T5      | —                                           | 0 (test-first) |
| WP-MOB-LOC  | R1         | T1, T2     | — (TP-LOC via phase order, not `dependsOn`) | 1              |
| WP-API-LOC  | R2, R3, R4 | T3, T4, T5 | — (TP-LOC via phase order, not `dependsOn`) | 1              |
| WP-DOCS-LOC | —          | —          | WP-MOB-LOC, WP-API-LOC                      | 2              |

Cross-check: R1-R4 all appear in some package's `satisfies:`. T1-T5 all appear in some package's
`provenBy:`.

---

## Acceptance criteria

1. `R1` — a stationary/indoor iOS ping (`heading: -1`, `speed: -1`) produces a payload with `heading: null`,
   `speedKph: null` at both call sites in `location-tracker.native.ts`.
2. `R2` — `PostLocationDto` accepts an optional `accuracy` ≥ 0 and rejects a negative one.
3. `R3` — a present negative `heading`/`speedKph` (not `null`) is still rejected by the DTO — the fix maps
   sentinels to `null` client-side, it does not relax the server-side bound.
4. `R4` — a ping carrying `accuracy` persists it on the created `DriverLocation` row.
5. A stationary/indoor iOS ping that previously 400'd now returns 200 and writes one row (validated by T3's
   DTO-level proof; end-to-end confirmation is a manual smoke, not part of this jest-scoped gate).
6. `routes.service.ts`'s live-map reader, `main.ts`'s `ValidationPipe` options, and the tracker's empty catch
   are byte-identical to before this change.

---

## Verification commands

Per round:

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx jest src/drivers --runInBand
cd apps/mobile && npx tsc --noEmit
cd apps/mobile && npx jest location-payload.test
```

Final:

```bash
cd apps/api && npx jest --silent
cd apps/mobile && npx jest --silent
node scripts/campaign-check.mjs
node scripts/validate-lessons.mjs
```

---

## UI verification

None — no UI surface changes (mobile background tracker + api DTO only). `uiVerify` is omitted from the
pipeline args.

---

## Risks & rollback

| Risk                                                                                                   | Likelihood                                   | Blast radius                                                                           | Mitigation                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile OTA ships `accuracy` in the payload before the API's DTO deploys                                | medium (mobile and api deploy independently) | Every ping 400s on both platforms until the API catches up — strictly worse than today | PR body states the ordering constraint explicitly; API PR merges and deploys FIRST; mobile OTA follows only after confirming the API deploy is live |
| `WP-DOCS-LOC` races Run A's `WP-DOCS` on the same `_meta.json`/`F25.jsonl` files                       | low if sequencing is followed                | Lost update / merge conflict on shared bookkeeping files                               | `RESUME.md`'s explicit sequencing rule: Run B launches only after Run A's close-out commit lands                                                    |
| `driverLocation` missing from the shared Prisma mock surfaces later when a service-level spec is added | low (this run's tests don't hit it)          | A future spec throws on `undefined.create` instead of a clean assertion failure        | Flagged in `bug-test-plan.md`'s harness notes as a backlog candidate, not fixed here (scope fence)                                                  |

- **Rollback:** revert the diff; no schema/migration involved (the `accuracy` column already exists,
  pre-provisioned by a prior batch).
- **Migration reversibility:** N/A.
- **Feature flag:** none.
- **Deploy day:** existing pings are unaffected; the fix only changes how a `-1`/`-3.6`-carrying ping is
  handled going forward. No backfill.
- **Observability:** none added — the PR body should note the empty-catch swallow remains a follow-up
  candidate for actually surfacing a dropped-ping rate.

---

## Pipeline args

```js
{
  planPath: '.claude/pipeline/2026-09-04-F25-location-bugfix/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-04-F25-location-bugfix/bug-test-plan.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '2026-09-04T13:20:00Z',
  mode: 'bugfix',
  scale: 'small',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25',
  context: 'F25 location batch B — B185 Low/hardening-adjacent; iOS -1 sentinel 400s the whole GPS ping; api deploys before any mobile OTA',
  formatCommand: "git ls-files -mo --exclude-standard | grep -E '\\.(ts|tsx|js|jsx|json|md)$' | grep -v '^\\.claude/pipeline/' | xargs -r npx prettier --write",

  radiusFiles: [
    'apps/mobile/lib/location-tracker.native.ts',
    'apps/mobile/lib/location-payload.ts',
    'apps/api/src/drivers/dto/post-location.dto.ts',
    'apps/api/src/drivers/drivers.service.ts',
    'apps/api/src/drivers/drivers.service.spec.ts',
    'apps/api/src/routes/routes.service.ts',
    'apps/api/src/main.ts'
  ],

  siblingPatterns: [
    { pattern: 'coords\\.(heading|speed|course)', note: 'platform sentinel forwarded without a < 0 guard' },
    { pattern: '@Min\\(0\\)', note: 'in apps/api/src/drivers/dto — a field a client may legitimately not know', pathHint: 'apps/api/src/drivers/dto' }
  ],

  testPackages: [
    {
      id: 'TP-LOC', title: 'seam extraction + REG/pin tests',
      files: [
        'apps/mobile/lib/location-payload.ts',
        'apps/mobile/__tests__/location-payload.test.ts',
        'apps/api/src/drivers/dto/post-location.dto.spec.ts'
      ],
      brief: 'Extract location-tracker.native.ts\'s current unmapped heading/speed construction verbatim into a named seam module both call sites call (behaviour-preserving). T1/T2 test the seam; T3/T4 test PostLocationDto\'s validation with the new accuracy field (whitelist violation pre-fix, Min(0) violation post-fix for a negative value); T5 pins every existing DTO case. Exact setup/oracle in bug-test-plan.md, including T4\'s dual-assertion construction.'
    }
  ],
  redGate: {
    commands: [
      'cd apps/mobile && npx jest location-payload.test -t "REG-B185"',
      'cd apps/api && npx jest src/drivers/dto/post-location.dto.spec.ts -t "REG-B185" --runInBand'
    ],
    expect: 'fail'
  },

  packages: [
    {
      id: 'WP-MOB-LOC', title: 'mobile sentinel mapping',
      files: ['apps/mobile/lib/location-payload.ts', 'apps/mobile/lib/location-tracker.native.ts'],
      brief: 'buildLocationPayload\'s body maps negative-or-null heading/speed to null, converts valid speed m/s->km/h, passes accuracy through when >= 0 else omits it. Both duplicate call sites in location-tracker.native.ts spread its return alongside their existing lat/lng/runId fields.',
      satisfies: ['R1'],
      provenBy: ['T1', 'T2']
    },
    {
      id: 'WP-API-LOC', title: 'DTO + persistence',
      files: ['apps/api/src/drivers/dto/post-location.dto.ts', 'apps/api/src/drivers/drivers.service.ts'],
      brief: 'Add @IsOptional() @Type(()=>Number) @IsNumber() @Min(0) accuracy?: number to PostLocationDto (no @Max). recordLocation\'s create() call gains accuracy: dto.accuracy. heading/speedKph\'s existing @Min(0)/@Max decorators are unchanged.',
      satisfies: ['R2', 'R3', 'R4'],
      provenBy: ['T3', 'T4', 'T5'],
      effort: 'high'
    },
    {
      id: 'WP-DOCS-LOC', title: 'close-out bookkeeping',
      files: [
        '.claude/campaign/status/F25.jsonl', '.claude/code-map/api.md', '.claude/code-map/mobile.md',
        '.claude/code-map/_meta.json', '.claude/code-map/CHANGELOG.md',
        '.claude/lessons/LESSONS.md', '.claude/lessons/_meta.json'
      ],
      brief: 'F25.jsonl: B185 -> proven. Code-map surgical entries for the 3 touched/new files + _meta.json + CHANGELOG bullet. LESSONS.md is NOT appended again (L-047 already covers B185 via Run A); _meta.json gets updatedAt bumped only. Precondition: Run A\'s WP-DOCS must already have landed.',
      satisfies: [],
      provenBy: [],
      dependsOn: ['WP-MOB-LOC', 'WP-API-LOC'],
      effort: 'low'
    }
  ],

  verifyCommands: {
    perRound: [
      'cd apps/api && npx tsc -p tsconfig.build.json --noEmit',
      'cd apps/api && npx jest src/drivers --runInBand',
      'cd apps/mobile && npx tsc --noEmit',
      'cd apps/mobile && npx jest location-payload.test'
    ],
    final: [
      'cd apps/api && npx jest --silent',
      'cd apps/mobile && npx jest --silent',
      'node scripts/campaign-check.mjs',
      'node scripts/validate-lessons.mjs'
    ]
  },

  mutationProbe: {
    targets: [
      { file: 'apps/mobile/lib/location-payload.ts', revertFix: true, behavior: 'negative/null heading and speed sentinels map to null', test: 'REG-B185' },
      { file: 'apps/api/src/drivers/dto/post-location.dto.ts', revertFix: true, behavior: 'accuracy is optional, >= 0, and does not relax heading/speedKph bounds', test: 'REG-B185' }
    ]
  }
}
```
