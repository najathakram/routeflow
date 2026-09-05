# Fix ruling — B185 (F25-location)

> Fable @ high rules over the S1 brief + S2 refutation verbatim; it opens no file. One ruling per run.
> Planner ruling date: 2026-09-04. Pinned sha for every cited file:line: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d`.

## S2 verdict (quoted from `refutation.md`)

| id   | Verdict                                                                                                   | One-line reason (quoted)                                                                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B185 | **confirmed** (sentinel half; the accuracy/null-island half is a hardening gap with no wrong-value repro) | "iOS `-1` reaches JS unmapped — proven at the native layer — and trips `@Min(0)` on both `heading` and `speedKph`; nothing anywhere strips or clamps negatives, and the 400 provably bypasses the offline queue." |

Full trace (quoted): "iOS delivers `course`/`speed` as `-1` when unavailable, expo-location forwards those
numbers unchanged, and the tracker's nullish guards (`location-tracker.native.ts:35-36`, `:81-82`) do not
recognise them — so the ping reaches the API carrying `heading: -1` and `speedKph: -3.6`, which both violate
`@Min(0)` (`post-location.dto.ts:20`, `:27`) under the global `ValidationPipe`, producing a 400 that the
tracker's empty `catch` discards without retry. No `DriverLocation` row is written and the live map silently
loses that driver's breadcrumb. Separately and independently, no `accuracy` value is captured despite the
column existing for it, and no coordinate-plausibility check exists."

## 1. Cause ACCEPTED

Tracker forwards iOS course/speed sentinels (`-1`) unmapped at `location-tracker.native.ts:35-36` and
`:81-82`; DTO `@Min(0)` at `post-location.dto.ts:20`/`:27` rejects the whole ping; the empty catch at
`location-tracker.native.ts:20-23` hides it. The accuracy/null-island half is HARDENING (no wrong-value
repro) — wired because the column exists and the schema comment assigns it to this batch
(`schema.prisma:928-931`, `// F01/B185: horizontal accuracy radius in meters, straight from the device fix —
lets readers drop or flag low-confidence pings. F25 wires the tracker payload and the DTO.`), but it carries
NO REG claim of its own. Additional confirmed facts from S2 that shape the fix: **both** `heading` (`-1`) and
`speedKph` (`-3.6`) violate `@Min(0)` on the same ping, not just one; the 400 does **not** enter the mobile
offline retry queue (`api-client.ts:126`'s `isNetworkError` gate requires `!error.response`, and a 400 has a
response); Android sends `0`/`0` for the same unavailable state (passes `@Min(0)`, so Android never 400s —
it instead silently persists a false zero, which is a _different_, out-of-scope defect); exactly two call
sites exist (`postLocation` is module-private, called only at `:32` and `:78`).

## 2. Fix design (minimal diff)

NEW pure `apps/mobile/lib/location-payload.ts` exporting
`buildLocationPayload(coords: { latitude, longitude, heading?, speed?, accuracy? }, recordedAt: string)`
that maps negative or null `heading`/`speed` to `null`, converts `speed` m/s → km/h only for valid values,
passes `accuracy` through when ≥ 0 else omits it; BOTH duplicate sites (`:32-39` and `:78-85`) call it.

DTO: add `@IsOptional() @IsNumber() @Min(0) accuracy?: number`; keep `@Min(0)` on `heading`/`speedKph` (they
are now nullable-by-client, not by relaxed range). `drivers.service.ts:105-116` persists `accuracy`.

Must NOT change: the readers `routes.service.ts:750-761` (this sha's line numbers for the "latest row within
5 minutes" block — the card/register's `:733-742`/`:766-776` citation drifted, per `refutation.md`'s Gaps),
the empty-catch semantics at `location-tracker.native.ts:20-23` (out of scope; note it as a follow-up in the
PR body — the S2 pass explicitly traced that a 400 does not retry, but fixing the swallow itself is not part
of this fix design), the web/no-op `location-tracker.web.ts` platform stub.

**Ordering constraint (confirmed by S2, must be stated in the PR body and RESUME):** the API deploys on merge
before any mobile build carries the change — `main.ts:145-149`'s `forbidNonWhitelisted: true` means a mobile
build shipping `accuracy` in the payload BEFORE the API's DTO gains that field would 400 EVERY ping, on both
platforms, which is strictly worse than today's iOS-only partial rejection. Mobile ships via EAS/OTA
independently of the API, so this is not automatically atomic.

## 3. Regression tests

See `bug-test-plan.md` for the full G/W/T table (REG-B185, T1-T4; T5 pin).

## 4. Blast radius (`radiusFiles`)

- `apps/mobile/lib/location-tracker.native.ts`
- `apps/mobile/lib/location-payload.ts`
- `apps/api/src/drivers/dto/post-location.dto.ts`
- `apps/api/src/drivers/drivers.service.ts`
- `apps/api/src/drivers/drivers.service.spec.ts`
- `apps/api/src/routes/routes.service.ts` (read-only `:750-761`)
- `apps/api/src/main.ts` (read-only `:144-150` whitelist)

(7 files.)

## 5. Sibling pattern (`siblingPatterns`)

- `coords\.(heading|speed|course)` — a platform sentinel forwarded without a `< 0` guard.
- `@Min\(0\)` in `apps/api/src/drivers/dto` — a field a client may legitimately not know (present-but-invalid
  vs. absent are different platform realities; a min-bound alone cannot tell them apart).

## 6. Data repair

None — rejected pings were never stored (the 400 fires before `DriversService.recordLocation` runs; no
`DriverLocation` row exists to repair).

## 7. Probe plan

| File                                            | `revertFix` | REG test that must go red |
| ----------------------------------------------- | ----------- | ------------------------- |
| `apps/mobile/lib/location-payload.ts`           | true        | REG-B185 (payload test)   |
| `apps/api/src/drivers/dto/post-location.dto.ts` | true        | REG-B185 (DTO test)       |
