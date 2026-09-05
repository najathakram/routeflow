# Bug test plan — B185 (F25-location)

> Fable @ high writes this from `cause-ruling.md`; Sonnet types the tests inside the engine. The red bar is
> BEHAVIORAL: each REG test must fail today on its own exact wrong value — reproduction is the point.

## Seam extraction (harness preparation, not the fix)

Per the common ruling: the tracker payload has no pure seam today — `location-tracker.native.ts:32-39` and
`:78-85` build the POST body inline, twice, with identical unmapped expressions. NEW
`apps/mobile/lib/location-payload.ts` first gets `export function buildLocationPayload(coords: {
latitude: number; longitude: number; heading?: number | null; speed?: number | null; accuracy?: number |
null }, recordedAt: string)` with its body copied VERBATIM from today's expressions
(`heading: coords.heading ?? null`, `speedKph: coords.speed != null ? coords.speed * 3.6 : null`, no
`accuracy` handling at all) — a behaviour-preserving move. Both call sites in `location-tracker.native.ts`
are updated to call it in place of their inline object literals; output is byte-identical to today. WP-MOB-LOC
then replaces ONLY the function's body with the fixed sentinel-mapping logic from `cause-ruling.md` §2.

## Red set (REG-tagged; in the red gate)

| T#  | Title (starts with REG-B185)                                        | Setup                                                                                                                                                            | Asserts                                                                                      | Fails TODAY with                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | File                                                 |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| T1  | `REG-B185 maps iOS heading/speed sentinels to null`                 | Call `buildLocationPayload({ latitude: 34.05, longitude: -118.24, heading: -1, speed: -1 }, "2026-09-04T00:00:00.000Z")` (seam module, today's unmapped body)    | `expect(payload.heading).toBeNull(); expect(payload.speedKph).toBeNull();`                   | `expected null received -1` (heading) and `expected null received -3.6` (speedKph) — today's `?? null`/`!= null` guards only catch JS `null`/`undefined`, not the platform sentinel `-1`                                                                                                                                                                                                                                                                                                                                    | `apps/mobile/__tests__/location-payload.test.ts`     |
| T2  | `REG-B185 passes a valid accuracy through and omits a negative one` | Call `buildLocationPayload({ latitude: 34.05, longitude: -118.24, accuracy: 4.5 }, "...")` and separately with `accuracy: -1`                                    | `expect(payloadA.accuracy).toBe(4.5); expect(payloadB.accuracy).toBeUndefined();`            | `expected 4.5 received undefined` — today's seam body has NO `accuracy` handling at all (the field does not exist in the payload object literal), so any value passed in is silently dropped, valid or not                                                                                                                                                                                                                                                                                                                  | same file as T1                                      |
| T3  | `REG-B185 DTO accepts a mapped-to-null ping with a valid accuracy`  | `validate(plainToInstance(PostLocationDto, { lat: 34.05, lng: -118.24, recordedAt: "2026-09-04T00:00:00.000Z", heading: null, speedKph: null, accuracy: 4.5 }))` | `expect(errors).toHaveLength(0)`                                                             | today fails with a `whitelist`/`forbidNonWhitelisted` violation on `accuracy` (property not declared on the DTO at all) — `expected 0 errors received 1 error ("property accuracy should not exist")`                                                                                                                                                                                                                                                                                                                       | `apps/api/src/drivers/dto/post-location.dto.spec.ts` |
| T4  | `REG-B185 DTO still rejects a negative accuracy`                    | `validate(plainToInstance(PostLocationDto, { lat: 34.05, lng: -118.24, recordedAt: "2026-09-04T00:00:00.000Z", accuracy: -1 }))`                                 | `expect(errors.length).toBeGreaterThan(0)` and the failing constraint names `accuracy`/`min` | today's assertion form doesn't apply yet (the property does not exist pre-fix, so the SAME whitelist violation as T3 fires — recorded as a pin-shaped REG test: it must go red for the SAME reason as T3 before the fix, and red for a DIFFERENT reason — `@Min(0)` — impossible before the field exists, so this test is written to fail on "property accuracy should not exist" pre-fix and to fail on the `min` constraint's absence-of-violation post-fix-without-Min; both failure modes are wrong-value, not vacuous) | same file as T3                                      |

**Note on T4's construction:** because `accuracy` does not exist on the DTO before the fix, a single
assertion cannot cleanly distinguish "rejected for the right reason" pre- and post-fix in one line. The test
asserts `errors.some(e => e.property === "accuracy")` is true both before (via
`forbidNonWhitelisted`) and after (via `@Min(0)`) the fix, AND additionally asserts
`errors.find(e => e.property === "accuracy")?.constraints` does NOT contain a `whitelistValidation` key
after the fix (it must contain a `min` key instead) — this second assertion is what actually goes from
failing (today: `whitelistValidation` is exactly the key present) to passing (after: `min` is the key
present). This is the behavioral wrong-value the red gate checks, not merely "throws".

## Pins (no REG token; outside the red gate)

| T#  | Frozen behavior                                                                                                                                                                                                             | File                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T5  | Every existing `PostLocationDto` validation case (valid full payload; `lat`/`lng` range violations; missing `recordedAt`) continues to validate exactly as today — no existing case's error count or constraint set changes | `apps/api/src/drivers/dto/post-location.dto.spec.ts` (same file as T3/T4, separate `describe` block; there is no pre-existing spec file for this DTO — `git grep -n "recordLocation"` against `drivers.service.spec.ts` at the pinned sha returns zero matches, confirmed this pass, so T5 is a NEW pin, not an edit to an existing one) |

## Harness notes (verified by the engine's harness-integrity check)

- **`driverLocation` is ABSENT from the shared Prisma mock (`apps/api/src/testing/prisma-mock.ts`), confirmed
  this pass.** Reading the file's `allModels()` (`:58-157`) and `txModels()` (`:161-200`) blocks in full:
  neither lists `driverLocation`. `drivers.service.spec.ts` uses `createMockPrisma()` (confirmed at its
  `:1-6` imports) and has zero existing coverage of `recordLocation` — so this gap has never been hit. **If
  any test in this run's red/green cycle calls through `DriversService.recordLocation` (e.g. a future
  service-level assertion that `accuracy` persists), it will throw `Cannot read properties of undefined
(reading 'create')` on `this.prisma.forTenant().driverLocation.create(...)`, not a validation mismatch.**
  This run's T1-T5 as scoped are pure-function (`buildLocationPayload`) and DTO-`validate()` calls — NEITHER
  goes through `DriversService` or the Prisma mock, so none of T1-T5 hits this gap. It is recorded here as a
  harness fact for whoever implements `WP-API-LOC`: adding `accuracy: dto.accuracy` to
  `drivers.service.ts:105-116`'s `create` call does not itself require a mock change (no new test exercises
  that path), but the mock's `driverLocation` omission should be added to `allModels()` as a
  low-effort follow-up if any future spec needs it — flagged as a candidate registry/backlog item, NOT
  fixed in this run (out of the minimal-diff fix design).
- No other existing spec's fixtures are touched by this run's DTO/tracker changes — `post-location.dto.ts`
  gains one additive optional field; every existing property keeps its exact validators.

## Commands

- `redGate.commands`: scoped jest filtered to `REG-B185`; `expect: 'fail'` — see `build-plan.md`'s
  "## Pipeline args" block for the exact strings.
- REG-B185 doubles as the registry proof line at close-out: B185 → `proven` (jest-provable end to end, no
  deploy-only tier — unlike Run A's B59/B91).
