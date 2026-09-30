# Cause brief — B185 F25-location

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.

Pinned sha for all citations below: `origin/master` = `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d` (fetched
2026-09-04). All `git show`/`git blame`/`git log` invocations below were run against this sha unless a
different sha is named explicitly (e.g. the commits a blame resolves to).

## The bug as stated

- **Source — fix card** (`.claude/pipeline/fix-cards/F25-calendar-date-correctness.md`, "B185" section,
  quoted verbatim):

  > **B185 — iOS sends -1 for unavailable heading and speed, and the DTO's minimum rejects the whole ping**
  >
  > **Area:** Driver GPS tracking · API + mobile
  >
  > **Meant to do:** A breadcrumb feed driving a live operator map accepts every valid fix, and rejects
  > implausible or low-confidence ones.
  >
  > **Actually does:** iOS reports course and speed as -1 when unavailable and the tracker forwards them
  > unchanged; the DTO's non-negative minimums then 400 the entire ping, and the post helper's empty catch
  > swallows it. Separately, no accuracy is captured or validated and any in-range coordinate passes,
  > including the null island.
  >
  > **The gap:** The validation that exists silently rejects legitimate stationary and indoor fixes, while
  > the plausibility gate that would matter does not exist.
  >
  > **Evidence:** apps/mobile/lib/location-tracker.native.ts:31-39 and :72-84 (the payload is built from the
  > sample's coords with no accuracy field and no sentinel mapping), :17-24 (the post helper's empty catch);
  > apps/api/src/drivers/dto/post-location.dto.ts (full file: latitude/longitude range checks, heading and
  > speed minimums of 0, battery, recordedAt, runId — no accuracy field and no null-island check);
  > apps/api/src/drivers/drivers.service.ts:99-116 (the only extra check is that recordedAt parses);
  > apps/api/src/routes/routes.service.ts:733-742, 766-776 (the latest row within five minutes is passed
  > through with no quality signal).
  >
  > **Suggested fix:** Map the iOS -1 sentinels for heading and speed to null client-side (or relax the DTO
  > minimums) so valid pings stop 400-ing, and add an optional accuracy field the tracker populates so fixes
  > above a threshold — or at exactly (0,0) — can be dropped or flagged.

  **Proof-tier assignment** (same file, table above the bug list): `B185 | T1 | Hunt-round SHA 0b2c3a0a |
NO_TOKEN_UNVERIFIED`.

  **Ledger row** (`.claude/campaign/status/F25.jsonl`, quoted verbatim):
  `{"id":"B185","batch":"F25","tier":"T1","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"0b2c3a0a"}`

  **Register article** (`local-assets/docs/routeflow-bug-register.html`, `id="b185"`, quoted verbatim —
  chips: `Low` / `Open`):

  > **Meant to do:** A breadcrumb feed driving a live operator map accepts every valid fix, and rejects
  > implausible or low-confidence ones.
  >
  > **Actually does:** iOS reports course and speed as -1 when unavailable and the tracker forwards them
  > unchanged; the DTO's non-negative minimums then 400 the entire ping, and the post helper's empty catch
  > swallows it. Separately, no accuracy is captured or validated and any in-range coordinate passes,
  > including the null island.
  >
  > **The gap:** The validation that exists silently rejects legitimate stationary and indoor fixes, while
  > the plausibility gate that would matter does not exist.
  >
  > **Verifier's note:** The claim as filed was a hardening gap (no wrong database write, no observed
  > misbehaviour); the inverted-validation defect above it was found while verifying and is the stronger
  > half, so this entry leads with it. No user-visible error is shown either way, because the post helper
  > swallows the rejection.
  >
  > Rounds 4-5 · adversarially verified · Aug 29, 2026 · master@0b2c3a0a · round5 R5-3-4

  **Discovery report** (`.claude/pipeline/2026-09-03-F25-calendar-dates/discovery.md`, §2 table row for
  "Drivers on iOS whose device reports course/speed as unavailable", quoted verbatim):

  > Any GPS sample taken while stationary or indoors, where iOS returns `-1` for heading/speed | The entire
  > location ping 400s and is silently swallowed (`location-tracker.native.ts:17-24`'s empty catch) — the
  > live operator map loses that driver's breadcrumb | `apps/api/src/drivers/dto/post-location.dto.ts`
  > (`@Min(0)` on both fields, full 44-line file), `location-tracker.native.ts:35-36,81-82`

  **Spec** (`.claude/pipeline/2026-09-03-F25-calendar-dates/spec.md`, §3 requirements table, quoted
  verbatim, row "Ingest / validate (added row — B185)"):

  > A driver's GPS ping reaches the server and is validated | keep | R6 | DTO gains an optional `accuracy`;
  > sentinel mapping happens client-side before POST

- **Repro** — concrete example: a driver's iPhone is stationary indoors (e.g. warehouse loading dock) and
  `expo-location` reports `coords.heading = -1` and `coords.speed = -1` (the platform's documented
  "unavailable" sentinel for both fields on iOS). The tracker forwards these values verbatim as
  `heading: -1, speedKph: -1 * 3.6 = -3.6...` (see Code path below). **Input**: `POST /drivers/me/location`
  with body `{ lat: 34.05, lng: -118.24, heading: -1, speedKph: -3.6, recordedAt: "...", runId: "..." }`.
  **Observed (Y)**: `class-validator`'s `@Min(0)` on `heading` and `speedKph`
  (`apps/api/src/drivers/dto/post-location.dto.ts:17-29`) rejects the request — the global
  `ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })`
  (`apps/api/src/main.ts:145-149`) turns this into an HTTP 400 before `DriversService.recordLocation` ever
  runs — and the mobile `postLocation` helper's empty `catch` block
  (`apps/mobile/lib/location-tracker.native.ts:17-24`) swallows the 400 silently; no `DriverLocation` row is
  written, no error surfaces to the driver or operator. **Expected (Z)**: the ping is accepted and a
  `DriverLocation` row is written for the stationary/indoor fix (heading/speed recorded as unavailable
  rather than rejected), so the live operator map keeps receiving that driver's breadcrumb. The exact wrong
  value: a 400 response / a dropped ping (zero `DriverLocation` rows created for that sample) where a 200 /
  one row was expected.

  Second, independent half of the same bug id: **no accuracy field exists on the DTO at all**
  (`post-location.dto.ts`, full file, reproduced below) even though `DriverLocation.accuracy` exists in the
  schema (`apps/api/prisma/schema.prisma:931`) — so a client that already omits/never sends `accuracy` never
  gets it persisted, and (separately, per the card) no plausibility gate exists for the coordinate itself
  (e.g. `lat:0, lng:0`, the "null island" case, passes the `@Min/@Max(-90..90)/(-180..180)` range checks
  unchanged).

- **Suspected cause (claim, unverified)**: quoting the fix card's "Actually does" / evidence verbatim (see
  above): the mobile tracker builds its POST payload directly from `sample.coords.heading` /
  `sample.coords.speed` with no sentinel-to-null mapping
  (`location-tracker.native.ts:35-36` and `:81-82`), and the API DTO's `@Min(0)` on both fields
  (`post-location.dto.ts:20`, `:27`) has no allowance for the -1 sentinel or for `null`/absence, so the
  transformed negative value fails validation and the whole ping is rejected; the DTO also has no `accuracy`
  property to receive or validate horizontal-accuracy data, and no check rejects `(0,0)` or otherwise
  implausible coordinates. This is presented by the card/register as a claim to verify, not a confirmed root
  cause — the proof tier is `NO_TOKEN_UNVERIFIED` and Verifier's note in the register explicitly reframes
  the primary defect ("the inverted-validation defect... is the stronger half") relative to the originally
  filed hardening-gap framing.

## Code path

Entry point: the background/foreground location task and the manual `startLocationTracking` call in the
mobile app build a payload from the platform's raw `Location.LocationObject` and call `postLocation`, which
POSTs to `/drivers/me/location`; the API controller runs the request through the global `ValidationPipe`
against `PostLocationDto` before `DriversController.postLocation` → `DriversService.recordLocation` ever
executes.

`apps/mobile/lib/location-tracker.native.ts:17-24` (the post helper's empty catch):

```
async function postLocation(payload: LocationPayload): Promise<void> {
  try {
    await apiClient.post("/drivers/me/location", payload);
  } catch {
    // Silent — telemetry failures should not surface to the driver. The
    // server is the source of truth; we'll catch up on the next sample.
  }
}
```

`apps/mobile/lib/location-tracker.native.ts:26-40` (background-task payload construction — no sentinel
mapping, no accuracy field on `LocationPayload` at all):

```
if (!TaskManager.isTaskDefined(TASK_NAME)) {
  TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
    if (error) return;
    const payload = data as { locations?: Location.LocationObject[] };
    const sample = payload?.locations?.[payload.locations.length - 1];
    if (!sample) return;
    await postLocation({
      lat: sample.coords.latitude,
      lng: sample.coords.longitude,
      heading: sample.coords.heading ?? null,
      speedKph: sample.coords.speed != null ? sample.coords.speed * 3.6 : null,
      recordedAt: new Date(sample.timestamp).toISOString(),
      runId: activeRunId,
    });
  });
}
```

Note: `?? null` only guards against JS `null`/`undefined`; it passes `-1` straight through — `-1` is a
platform sentinel value, not JS `null`, so this line does not catch it.

`apps/mobile/lib/location-tracker.native.ts:74-85` (the `startLocationTracking` one-shot payload —
duplicates the same construction, same lack of sentinel handling):

```
  try {
    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    await postLocation({
      lat: current.coords.latitude,
      lng: current.coords.longitude,
      heading: current.coords.heading ?? null,
      speedKph: current.coords.speed != null ? current.coords.speed * 3.6 : null,
      recordedAt: new Date(current.timestamp).toISOString(),
      runId,
    });
  } catch {
    // best-effort
  }
```

(Line numbers on current master: this block is lines 74-85, not 72-84 as the card/register cite — see
"Gaps" below.)

`apps/api/src/drivers/dto/post-location.dto.ts` (full file, 44 lines — no `accuracy` property, no
null-island / plausibility check, `@Min(0)` on both `heading` and `speedKph`):

```
import { IsNumber, IsOptional, IsString, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class PostLocationDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(500)
  speedKph?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  batteryPct?: number;

  @IsString()
  recordedAt!: string;

  @IsOptional()
  @IsString()
  runId?: string;
}
```

`apps/api/src/main.ts:145-149` (the global pipe that turns the `@Min` failure into a 400, and would also
reject a client-added `accuracy` field today since it is not whitelisted):

```
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
```

`apps/api/src/drivers/drivers.service.ts:93-116` (`recordLocation` — the only extra validation is that
`recordedAt` parses; no accuracy handling, no coordinate plausibility check, confirming the card's claim):

```
  async recordLocation(userId: string, dto: PostLocationDto) {
    const driver = await this.prisma.forTenant().driver.findFirst({
      where: { userId },
      select: { id: true, tenantId: true },
    });
    if (!driver) throw new NotFoundException("Driver profile not found");

    const recordedAt = new Date(dto.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) {
      throw new BadRequestException("recordedAt must be an ISO date string");
    }

    await this.prisma.forTenant().driverLocation.create({
      data: {
        driverId: driver.id,
        runId: dto.runId ?? null,
        lat: dto.lat,
        lng: dto.lng,
        heading: dto.heading,
        speedKph: dto.speedKph,
        batteryPct: dto.batteryPct,
        recordedAt,
      },
    });
    return { ok: true };
  }
```

(No `accuracy: dto.accuracy` line — cannot exist, since the DTO has no such field.)

`apps/api/src/routes/routes.service.ts:750-761` (the live-map read side — "latest row within 5 minutes",
no accuracy/quality field read or surfaced; card cited :733-742/:766-776, current line numbers differ, see
"Gaps"):

```
    const driverIds = runs.map((r) => r.driverId).filter((d): d is string => !!d);
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    const recentLocations = driverIds.length
      ? await this.prisma.forTenant().driverLocation.findMany({
          where: { driverId: { in: driverIds }, recordedAt: { gte: fiveMinAgo } },
          orderBy: { recordedAt: "desc" },
        })
      : [];
    const latestByDriver = new Map<string, (typeof recentLocations)[number]>();
    for (const loc of recentLocations) {
      if (!latestByDriver.has(loc.driverId)) latestByDriver.set(loc.driverId, loc);
    }
```

`apps/api/prisma/schema.prisma:919-939` (`DriverLocation` model — `accuracy` column already exists,
confirming there is a place to persist it once the DTO/tracker are wired):

```
model DriverLocation {
  id         String   @id @default(uuid())
  tenantId   String?
  driverId   String
  runId      String?
  lat        Decimal  @db.Decimal(10, 7)
  lng        Decimal  @db.Decimal(10, 7)
  heading    Decimal? @db.Decimal(6, 2)
  speedKph   Decimal? @db.Decimal(6, 2)
  // F01/B185: horizontal accuracy radius in meters, straight from the device
  // fix — lets readers drop or flag low-confidence pings. F25 wires the
  // tracker payload and the DTO.
  accuracy   Decimal? @db.Decimal(8, 2)
  batteryPct Int?
  recordedAt DateTime
  createdAt  DateTime @default(now())

  driver Driver    @relation(fields: [driverId], references: [id], onDelete: Cascade)
  run    RouteRun? @relation(fields: [runId], references: [id], onDelete: SetNull)
  tenant Tenant?   @relation(fields: [tenantId], references: [id])
```

`apps/api/src/drivers/drivers.controller.ts:65-70` (the endpoint, guarded `JwtAuthGuard`/`AddonGuard` at
class level, `RolesGuard`/`DRIVER` at method level — no bearing on the validation bug itself, included for
path completeness):

```
  @Post("me/location")
  @UseGuards(RolesGuard)
  @Roles(UserRole.DRIVER)
  postLocation(@CurrentUser() user: JwtPayload, @Body() dto: PostLocationDto) {
    return this.driversService.recordLocation(user.sub, dto);
  }
```

## History

`apps/mobile/lib/location-tracker.native.ts`, `apps/api/src/drivers/dto/post-location.dto.ts`, and
`apps/api/src/drivers/drivers.service.ts`'s `recordLocation` method are all a single unmodified file (or
unmodified method) since one commit — `git log --oneline -- <file>` on each returns exactly one entry:

```
453b08b42 feat(mobile): full operator CRUD, live map, driver GPS, POD wiring (phases 1-10)
```

(`git blame` of every line in `location-tracker.native.ts` and `post-location.dto.ts` attributes 100% of
both files to `453b08b42`, Najath Akram, 2026-04-20 22:12:44 -0500.)

`git show --stat 453b08b42` (subject and full file list, quoted):

```
feat(mobile): full operator CRUD, live map, driver GPS, POD wiring (phases 1-10)

Operator: pending orders list/detail/create/edit, products CRUD + barcode scan +
stock adjust, customers CRUD + map view, routes create/edit/stop management/
assign driver, invoices list/detail/record payment/send/void, drivers CRUD,
returns approve/reject/receive, analytics KPIs, business settings.

Home KPI cards and More menu now navigate to all new screens. Fleet tab replaced
decorative SVG with react-native-maps showing live driver pins + route polylines +
customer pins (polls /routes/live every 15 s).

Driver: POD photo/signature/note screens wired to pod Zustand store, delivery
mutation includes captured artifacts. Cash payment wired to POST /invoices/:id/payments.
Return wired to POST /returns. Background GPS (expo-location) streams location while
run is IN_PROGRESS; web gets a no-op stub via .native/.web platform split.

API: DriverLocation model + migration, POST /drivers/me/location, GET /routes/live.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

 apps/api/prisma/schema.prisma                      |  34 +-
 apps/api/src/drivers/drivers.controller.ts         |   8 +
 apps/api/src/drivers/drivers.service.ts            |  28 ++
 apps/api/src/drivers/dto/post-location.dto.ts      |  44 +++
 apps/api/src/routes/routes.controller.ts           |   7 +
 apps/api/src/routes/routes.service.ts              |  78 +++++
 ... (further files/stats truncated by head -30 in this session)
```

This one commit introduced the entire GPS-tracking feature end to end (schema, DTO, service, controller,
mobile tracker) in a single sweep — the -1 sentinel / no-accuracy-field gap has existed unchanged since
that commit and was never touched again.

The `DriverLocation.accuracy` column was added later, by a _different_ commit that did not touch the DTO or
tracker:

```
e7eb16270 feat(db): campaign schema foundation F01 (migration 20260908) (#548)
```

Author `najathakram`, 2026-08-31 00:02:29 -0500. `git show --stat e7eb16270`'s subject/body (quoted, the
relevant clause): "...RouteRun.settlementVariance and settlementNote (B167, F05);
**DriverLocation.accuracy (B185, F25)**." — i.e. this commit is a schema-only enablement batch that
pre-added twelve columns across eight models for later campaign batches to wire up; it explicitly names
B185/F25 as the batch responsible for wiring the DTO and tracker to the column it added. `git blame -L
919,939` on `schema.prisma` confirms lines 928-931 (the `accuracy` field and its comment) are
`e7eb16270`, while every other line of the model is still `453b08b42`.

## Existing tests around this behavior

- `apps/api/src/drivers/drivers.service.spec.ts` exists (found via `git ls-tree`) but `grep -n "recordLocation"`
  against it at the pinned sha returns **zero matches** — `recordLocation` has no spec coverage at all today.
- No file matching `location`, `gps`, or `tracker` exists under `apps/mobile/__tests__/` at the pinned sha
  (`git ls-tree -r <sha> --name-only | grep -iE "__tests__.*(location|gps|tracker)"` → empty). The mobile
  Jest suite (pure-logic only, per project conventions) has no test for `location-tracker.native.ts`.
- No Playwright spec under `apps/web/e2e` references driver location/GPS (this is a mobile-only code path;
  web has no ingest UI for it, only the live-map read side in `routes.service.ts` which also has no cited
  spec in the sources gathered for this brief).
- Net: **zero existing tests exercise `PostLocationDto` validation, `recordLocation`, or the mobile
  tracker's payload construction** — the sentinel-rejection behavior, the missing accuracy field, and the
  missing coordinate plausibility check are all currently unverified by any automated test.

## Production evidence (if any)

None of the gathered sources (fix card, ledger shard, register article, discovery.md, spec.md) record any
production log lines, row counts, or dollar/id amounts for B185. The register article explicitly frames it
as a hardening gap rather than an observed incident ("The claim as filed was a hardening gap (no wrong
database write, no observed misbehaviour)"). No production evidence found.

## Open unknowns

- Whether iOS's Core Location actually still emits exactly `-1` (vs. `null`/`NaN`) for unavailable
  heading/speed on the Expo/React Native version this app targets — none of the sources include a device
  log or expo-location version-pinned confirmation; the claim rests on general iOS platform knowledge cited
  by the fix card, not a captured payload.
- Whether Android emits an analogous sentinel (the card and register discuss iOS only); if Android's
  behavior differs, the fix scope may need to cover both platforms or explicitly restrict to iOS.
- Whether any other DTO field (e.g. `batteryPct`, also `@Min(0)`) has an analogous platform sentinel not
  named in the card.
- Confirmation the two duplicate payload-construction sites (`:32-39` background task and `:78-85`
  foreground one-shot) are the ONLY two call sites of `postLocation` in the mobile app (a repo-wide grep for
  other callers of `postLocation`/`apiClient.post("/drivers/me/location"...)` was not run in this brief).
- What behavior is intended for `(0,0)`/"null island" beyond "should not silently pass" — the card names it
  but no spec.md requirement row for a plausibility threshold was located.

## Gaps

- The fix card/register cite `location-tracker.native.ts:72-84` for the foreground one-shot block; on the
  pinned sha it is actually lines 74-85 (`git show <sha>:apps/mobile/lib/location-tracker.native.ts | nl`).
  Content matches; only line numbers drifted (proof tier already flags this bug id `NO_TOKEN_UNVERIFIED`).
- The fix card/register cite `apps/api/src/routes/routes.service.ts:733-742, 766-776` for the live-map read
  side; on the pinned sha the "latest row within 5 minutes" block is at lines 750-761 and the surrounding
  `getLiveRoutes` method starts at line 730 — line numbers again drifted from the citation without a content
  change located at those exact ranges. Did not locate a second block near :766-776 matching the citation's
  description; only one "recentLocations"/"latestByDriver" block was found in the file.
- Could not verify the `git show --stat 453b08b42` full file list beyond `head -30` (truncated in the
  command run for this brief) — the six files shown account for the DTO/service/controller/schema/tracker
  surface named in the card, but whether the same commit touched additional files (e.g. a mobile route
  screen also consuming `DriverLocation`) was not checked.
- This batch's other four ids (B59, B90, B91, B118) are out of scope for this brief per the task's explicit
  instruction ("batch F25-location (ids B185)") and were not investigated beyond what was needed to quote
  the shared fix-card/ledger/spec context; no B91 display-site-by-line list or B118
  invoices.service.ts/analytics.service.ts quotes are included here.
- No `apps/mobile/lib/api-client.ts` (`apiClient.post`) internals were read — whether it applies any
  request-level normalization (e.g. stripping `null` fields) before the HTTP call was not checked, so it is
  unconfirmed whether the exact wire payload matches the JS object literal quoted above verbatim.
