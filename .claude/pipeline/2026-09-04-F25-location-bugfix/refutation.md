# Cause refutation — B59 · B90 · B91 · B118 · B185 · F25-location

> Written by the S2 refutation agent, read-only, adversarial: for every id the suspected cause was
> ASSUMED WRONG and attacked. A verdict is `confirmed` only where the attack failed on evidence.
> No fix proposals — "Fix-shape facts" record constraints a fix must respect, not the fix.
>
> **Pinned sha for every citation: `origin/master` = `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d`**
> (identical to the sha the S1 brief pinned; `git fetch origin master` on 2026-09-04 resolves
> `origin/master` to exactly this commit). Every `file:line` below was read with
> `git show f60bd27c:<path>`. The one exception is `apps/mobile/node_modules/expo-location/**`,
> which is not tracked in git and was read from the working tree — flagged inline where used.
>
> No skill template exists for S2 (`~/.claude/skills/bug-pipeline/templates/` holds only
> `CAUSE-BRIEF.md`, `CAUSE-RULING.md`, `BUG-TEST-PLAN.md`), so the section list from the task brief
> is used. `BUGFIX-NOTES.md` §"Adversarial cause refutation (S2)" is the operating norm applied:
> in F11 every suggested fix was refuted on investigation, so a suggestion is a hypothesis until traced.

## Verdict summary

| id   | Verdict                                                                                                   | One-line reason                                                                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B59  | **confirmed**                                                                                             | Local getters on a UTC-midnight instant (`EditRunModal.tsx:21`), and the shifted day is written back unconditionally (`:56`); the API applies no normalisation that could absorb it.                                                                                                                                      |
| B90  | **confirmed**                                                                                             | Pure device-local filtering (`exceptions.tsx:61`) applied to a field the API stores as a UTC-midnight calendar stamp (`routes.service.ts:907`, `:1343`) — a local-midnight floor is the wrong operation for that contract.                                                                                                |
| B91  | **confirmed** (cited site list partly refuted)                                                            | 5 of the 8 cited render sites are genuine calendar-date fields; **3 render real timestamps and are correct today**, and one cited field is heterogeneous per row. One writer (`mobile (operator)/customers/[id]/licenses.tsx:84`) breaks the calendar contract at the source.                                             |
| B118 | **confirmed** (two premises corrected)                                                                    | `setUTCHours(23,59,59,999)` at `analytics.service.ts:337` vs the comparison at `:342` is real, but "TenantConfig.timezone … is ignored" holds only for analytics — a tenant-tz day-**start** helper already exists and is spec-covered; and the UTC rule is **documented** at `:325`, making this a specification defect. |
| B185 | **confirmed** (sentinel half; the accuracy/null-island half is a hardening gap with no wrong-value repro) | iOS `-1` reaches JS unmapped — proven at the native layer — and trips `@Min(0)` on **both** `heading` and `speedKph`; nothing anywhere strips or clamps negatives, and the 400 provably bypasses the offline queue.                                                                                                       |

---

## B59 — Edit Route Run rolls `scheduledDate` back one day on every save

### Trace (repro input → wrong output)

1. `routes/[id]/page.tsx:876` and `routes/page.tsx:348` both mount `<EditRunModal run={run} …>`.
   `run.scheduledDate` is typed `string` (`apps/web/lib/api/routes.ts:75`).
2. The API hands back the raw Prisma row: `findAllRuns` returns `normalisedData` built by spreading the
   row (`apps/api/src/routes/routes.service.ts:1115-1122`) with no date mapping, so `scheduledDate`
   serialises as a **full ISO UTC-midnight instant**, e.g. `"2026-09-04T00:00:00.000Z"`.
3. **Read** — `EditRunModal.tsx:33` seeds the date input from `formatLocalDate(run.scheduledDate)`:

   ```ts
   function formatLocalDate(value: string): string {
     // :17
     const d = new Date(value); // :18
     const y = d.getFullYear(); // :19  LOCAL
     const m = String(d.getMonth() + 1).padStart(2, "0"); // :20  LOCAL
     const day = String(d.getDate()).padStart(2, "0"); // :21  LOCAL
     return `${y}-${m}-${day}`; // :22
   }
   ```

   At UTC−4 (EDT) `2026-09-04T00:00:00.000Z` is `2026-09-03 20:00` locally, so `:21` yields `03` and the
   `<input type="date">` at `:98-104` pre-fills **`2026-09-03`** — yesterday.

4. **Write** — `handleSave` (`:50-65`):

   ```ts
   if (driverId !== initialDriverId) body.driverId = driverId || null; // :55  conditional
   if (!isInProgress) body.scheduledDate = date; // :56  UNCONDITIONAL
   ```

   `date` is the input's value, i.e. the bare calendar string `"2026-09-03"` — **not** a local-midnight
   ISO and **not** a UTC-midnight ISO. It ships on every save of any non-`IN_PROGRESS` run, including a
   driver-only reassignment.

5. `useUpdateRouteRun` PATCHes the body verbatim (`apps/web/lib/api/routes.ts:394`) to `/route-runs/:id`.
6. **API — no normalisation.** The controller takes a plain inline body type, _not_ a validated DTO
   class, so no transform runs (`apps/api/src/routes/routes.controller.ts:271-280`):

   ```ts
   @Patch(":id")
   updateRun(@Param("id") id: string,
             @Body() body: { driverId?: string | null; scheduledDate?: string; notes?: string },
             @CurrentUser() user: JwtPayload) { return this.routesService.updateRun(id, body, user); }
   ```

   and the service writes (`routes.service.ts:1343`):

   ```ts
   if (dto.scheduledDate) data.scheduledDate = new Date(dto.scheduledDate);
   ```

   A date-only string parses as **UTC midnight** per the ES spec, so `"2026-09-03"` is stored as
   `2026-09-03T00:00:00.000Z`. The API faithfully stores the day the client sent; it neither causes nor
   corrects the shift. Each subsequent open+save shifts one further day.

### Verdict — **confirmed**

### Diverging line

`apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx:21` —
`const day = String(d.getDate()).padStart(2, "0");` — a **local** calendar getter applied to a
UTC-midnight instant. `:19` and `:20` share the fault; `:21` is where the day number is actually lost.
The line that turns a display bug into **data destruction** is `:56`
(`if (!isInProgress) body.scheduledDate = date;`).

### Evidence

- Read path quoted above: `EditRunModal.tsx:17-23`, `:33`.
- Write path: `EditRunModal.tsx:56`; `apps/web/lib/api/routes.ts:394`.
- API absence of normalisation: `routes.controller.ts:271-280` (no DTO class),
  `routes.service.ts:1343` (`new Date(dto.scheduledDate)`).
- The contract this violates is documented in-repo: `apps/web/lib/format.ts:21-30` names
  `scheduledDate` explicitly as a calendar date and forbids local formatting;
  `apps/web/lib/formatting.ts:41-54` documents `fmtCalendarDate` as the UTC-anchored counterpart.
- The already-correct sibling for the same field: `apps/mobile/app/(driver)/route/index.tsx:178-183`,
  carrying the comment "NEW-rweb-7: scheduledDate is a UTC ISO string whose date component is the
  intended calendar date" and doing `(run.scheduledDate ?? "").slice(0, 10).replace(/-/g, "/")`.

### Refutations attempted and why each failed

1. _"The list API already returns a `YYYY-MM-DD`, so `new Date()` is safe."_ — **Failed.**
   `findAllRuns` (`routes.service.ts:1081-1122`) returns unmapped Prisma rows; `scheduledDate` is a
   `DateTime` (`schema.prisma:1200`) and serialises with its time component. And even a date-only string
   would still parse as UTC midnight and be shifted by the local getters at `:19-21`.
2. _"The write sends local midnight, which cancels the read shift."_ — **Failed.** `:56` sends the bare
   input string; `routes.service.ts:1343` parses it as UTC midnight. There is no compensating offset
   anywhere on the path — the wrong day is persisted verbatim.
3. _"`scheduledDate` is only sent when the date input changed."_ — **Failed.** `:55` is guarded by a
   dirty check (`driverId !== initialDriverId`); `:56` deliberately is not.
4. _"The API validates/normalises `scheduledDate` on PATCH like it does on create."_ — **Failed.**
   Create uses `CreateRouteRunDto` with `@IsDateString()` (`dto/create-route-run.dto.ts:12`); the PATCH
   path has **no DTO at all** (`routes.controller.ts:276`), so nothing validates or coerces it.

### Actual cause

`formatLocalDate` reads a UTC-anchored calendar instant with local component getters, so every
negative-UTC-offset operator is shown the previous day; because `handleSave` re-sends the date field on
every save regardless of whether it was touched, the API stores that previous day as the run's new
`scheduledDate`, and the loss compounds per save.

### Missing evidence

- No production row count or log line establishing how many runs have already been rolled back; the
  register and ledger carry none. Whether persisted data is already corrupted is **unestablished** — a
  read-only report would be needed before any repair is even discussed (`CAUSE-RULING` §6).
- No test pins today's behavior: at the pinned sha the only files referencing `EditRunModal` are the
  component and its two mount points.

### Fix-shape facts

- `routes.service.ts:1343` is a **shared** writer: the same `updateRun` serves drivers
  (`routes.controller.ts:273`, `@Roles(OPERATOR, DRIVER)`), and `:1336-1338` already blocks drivers from
  reassigning. Any change there affects both callers.
- `routes.service.ts:907` (create) parses the same way from `@IsDateString()` input — the storage shape
  (UTC midnight from a date-only string) is the established contract and must not change, or every
  reader listed under B90/B91 breaks.
- `routes.service.ts:1064-1067` builds the runs-list day filter with **local** `setDate`/`getDate` on a
  UTC instant — same file, same field, named by neither register entry (see Sibling observations).
- `EditRunModal.tsx` is reachable from two screens (`routes/[id]/page.tsx:876`, `routes/page.tsx:348`).
- Register citation drift: B59 cites `routes.service.ts:875, :1289, :968`; on the pinned sha the create
  write is `:907`, the update write is `:1343`, and the dispatch payload is `:1000`. All **MOVED**,
  content-identical.

---

## B90 — Mobile Exceptions flags on-schedule runs as "Late route"

### Trace

1. `apps/mobile/app/(operator)/exceptions.tsx:36` fetches
   `useOperatorRouteRuns({ status: "IN_PROGRESS", limit: 20 })`. The API applies **no date filter** for
   this call — `findAllRuns` adds `where.scheduledDate` only when a `date` query param is present
   (`routes.service.ts:1063-1068`), and none is sent.
2. The "Late" decision is therefore **entirely client-side** (`exceptions.tsx:42-43`, `:59-62`):

   ```ts
   const today = new Date();                      // :42
   today.setHours(0, 0, 0, 0);                    // :43  local midnight of the device's today — correct
   …
   const scheduled = new Date(run.scheduledDate);  // :60
   scheduled.setHours(0, 0, 0, 0);                 // :61  LOCAL floor of a UTC-midnight instant
   if (scheduled < today) {                        // :62
   ```

3. Arithmetic for a run scheduled **today**, on a UTC−4 device:
   `run.scheduledDate = 2026-09-04T00:00:00.000Z` → local `2026-09-03 20:00` → `:61` floors it to local
   `2026-09-03 00:00`. `today` floors to local `2026-09-04 00:00`. `:62` is `true`, so the run is pushed
   into the exception list as `"Late route — …"` (`:69`) with severity `warning` (`:71`).

### The data-contract question the task asks, answered

**It is device-local filtering, not a query bound** — and the data contract makes local filtering the
wrong operation for this field. `RouteRun.scheduledDate` is written **only** from a date-only string
parsed as UTC midnight, at both of its writers: `routes.service.ts:907`
(`scheduledDate: new Date(dto.scheduledDate)` from an `@IsDateString()` field) and `routes.service.ts:1343`
(update). It is a `DateTime` column (`schema.prisma:1200`) used as a **calendar-date** stamp. The correct
comparison is therefore _calendar day read in UTC_ against _the viewer's calendar day_; flooring the stamp
in device-local time re-interprets a calendar label as an instant and loses a day for every
negative-offset device.

### Verdict — **confirmed**

### Diverging line

`apps/mobile/app/(operator)/exceptions.tsx:61` — `scheduled.setHours(0, 0, 0, 0);`.
(`:42-43` are correct: `today` is a genuine "now", and a local floor is the right operation for it.
`:60` alone is harmless; `:61` is where the calendar value is coerced into the device's frame.)

### Evidence

- Screen code `exceptions.tsx:42-43`, `:59-76`, quoted above.
- Storage contract: `routes.service.ts:907`, `:1343`; column `schema.prisma:1200`.
- No server-side day filter on this call: `routes.service.ts:1063-1068` gates the filter on `date`,
  which `useOperatorRouteRuns({ status, limit })` never supplies.
- The already-correct in-repo pattern for the same field: `apps/mobile/app/(driver)/route/index.tsx:183`.
- The shared UTC-safe helper already exists on this surface: `apps/mobile/lib/format-date.ts:25-44`
  (`fmtCalendarDate`), whose header `:1-13` states the rule and explicitly warns it is _not_ for real
  timestamps.

### Refutations attempted and why each failed

1. _"The server already filters to today's runs, so the client comparison is redundant, not wrong."_ —
   **Failed.** No `date` param is sent (`exceptions.tsx:36`), so `routes.service.ts:1063` never engages.
   The client comparison is the only day logic on this path.
2. _"Device-local IS the intended frame — an operator cares about their own day."_ — **Failed on the
   data contract, not on taste.** The operator's own day _is_ the right frame for `today` (`:42-43`);
   the defect is that `run.scheduledDate` is not an instant that can be localised — it is a calendar
   label stored at UTC midnight, and localising the label is what shifts it.
3. _"`setHours(0,0,0,0)` on both sides cancels out."_ — **Failed.** It cancels only when both operands
   live in the same frame. `today` is a real local instant; `scheduled` is a UTC-anchored label, so the
   floor moves only the latter across a day boundary.

### Actual cause

A UTC-midnight calendar stamp is floored with local `setHours`, landing it on the previous local day for
every negative-UTC-offset device, so a run scheduled for today compares strictly-less-than today's local
floor and is reported as a late route.

### Missing evidence

- No captured device screenshot or log; B90's proof tier is `NO_TOKEN_UNVERIFIED` and the ledger shard
  carries `"proof":null,"evidence":null`.
- The positive-UTC-offset direction was not exercised: at UTC+X a same-day run floors to the same local
  day and is correctly not flagged, but a run scheduled for **tomorrow** could floor onto today. Not
  traced, because no repro asks for it.

### Fix-shape facts

- `exceptions.tsx` has no test at the pinned sha (no file under `apps/mobile/__tests__/` references it),
  and the screen is a React component. Under the project's "mobile Jest is pure-logic only" convention a
  T1 jest proof requires the comparison to be extracted into a pure helper, or it cannot be covered.
- `today` at `:42-43` must **not** change: it is the viewer's real current instant and its local floor is
  correct.
- The same `useMemo` (`:40-94`) also builds urgent-order and pending-return items; nothing else in it
  touches dates.

---

## B91 — Calendar-date fields rendered with local-time formatters

Per the task: **each cited site was classified as calendar-date vs real timestamp; a timestamp rendered
in local time is NOT a bug.** Three cited sites turn out to be timestamps, and one cited field is
heterogeneous per row.

### Per-site classification (all at the pinned sha)

| #   | Site                                                                       | Field                                          | Stored as                                                                        | Rendered with                                        | Bug?                                           |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| 1   | `apps/web/app/(dashboard)/dashboard/page.tsx:86`                           | `scheduledDate`                                | UTC-midnight calendar (`routes.service.ts:907`, `:1343`)                         | `new Date(...).toLocaleDateString()`                 | **YES**                                        |
| 1b  | same file `:81`                                                            | `startedAt`                                    | real timestamp                                                                   | `toLocaleTimeString` local                           | no — correct, do not touch                     |
| 2   | `apps/web/app/(dashboard)/routes/my-runs/page.tsx:52`                      | `scheduledDate`                                | UTC-midnight calendar                                                            | `toLocaleDateString(undefined, {weekday,month,day})` | **YES**                                        |
| 3   | `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx:534`               | `scheduledDate`                                | UTC-midnight calendar                                                            | `toLocaleDateString([], {...})`                      | **YES**                                        |
| 4   | `apps/web/app/(dashboard)/deliveries/page.tsx:74-75`                       | `run?.scheduledDate ?? row.original.createdAt` | **mixed** — calendar OR timestamp                                                | one `toLocaleDateString()` for both                  | **YES for the `scheduledDate` branch only**    |
| 5   | `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:273` | `auth.expiresAt`                               | calendar **by contract**, violated by one writer (below)                         | `fmtDate` (local)                                    | **YES**, with a writer caveat                  |
| 5b  | same file `:278`                                                           | `verifiedAt`                                   | real timestamp (set at verification; cleared at `authorizations.service.ts:206`) | `fmtDate` local                                      | no — correct, do not touch                     |
| 6   | `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:199`                 | `row.expiresAt`                                | same as #5                                                                       | `fmtDate` (local)                                    | **YES**, same caveat                           |
| 7   | `apps/web/app/(dashboard)/finance/reports/page.tsx:1234`                   | `r.date`                                       | **heterogeneous per row** — see below                                            | `fmtDate` (local)                                    | **PARTLY — register premise refuted**          |
| 8   | `apps/mobile/app/(customer)/payments.tsx:145`                              | `c.expiresAt`                                  | calendar (`creditNote.expiresAt`)                                                | local `fmtDate` (`:32-38`)                           | **YES**                                        |
| 8b  | same file `:144`                                                           | `c.date`                                       | **real timestamp** — `creditNote.createdAt` (`customers.service.ts:982`)         | local `fmtDate`                                      | no — correct, do not touch                     |
| 8c  | same file `:291`                                                           | `p.paidAt`                                     | real timestamp                                                                   | the same local `fmtDate` helper                      | no — correct, do not touch                     |
| ref | `apps/mobile/app/(operator)/credit-notes/[id].tsx:165`                     | `cn.expiresAt`                                 | calendar                                                                         | `fmtCalendarDate`                                    | already correct (the register's own reference) |

### #7 — the Receivable Summary premise is **refuted as stated**

The register says _"Receivable Summary date = issueDate per `bookkeeping.service.ts:2082`"_. At the pinned
sha `:2082` sits inside the `toDate` computation, and the row builders show the `date` column is fed by
**three different fields**:

```
apps/api/src/bookkeeping/bookkeeping.service.ts
  :2135   date: inv.issueDate,   // INVOICE     — calendar date (UTC midnight)
  :2147   date: cn.createdAt,    // CREDIT_NOTE — REAL TIMESTAMP
  :2159   date: p.createdAt,     // PAYMENT     — REAL TIMESTAMP
```

Only the `INVOICE` third of the rows is a calendar date. Swapping `fmtDate` → `fmtCalendarDate` at
`finance/reports/page.tsx:1234` would fix invoices and **newly break** credit-note and payment rows (an
8pm EDT payment would print as the next day). The citation `:2082` is **MOVED** → `:2135`.

### #5/#6 — the field's own write contract is broken by one writer

Four writers of `CustomerAuthorization.expiresAt` exist; three honour UTC midnight and **one does not**:

| Writer                  | Line                                                                      | Produces                                                   | Contract             |
| ----------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------- |
| web operator            | `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:64` | `new Date("YYYY-MM-DD").toISOString()` → `…T00:00:00.000Z` | ✔ UTC midnight       |
| web buyer / order guard | `apps/web/app/(dashboard)/orders/_components/LicenseGuardModal.tsx:97`    | `new Date(l.expiresAt).toISOString()`                      | ✔ UTC midnight       |
| **mobile operator**     | **`apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84`**           | ``new Date(`${expiresAt.trim()}T23:59:59`).toISOString()`` | **✘ local 23:59:59** |
| mobile buyer            | `apps/mobile/app/(customer)/licenses.tsx:130` (validated `:121-127`)      | `new Date("YYYY-MM-DD").toISOString()`                     | ✔ UTC midnight       |

A date-time literal with **no offset** is parsed as **local** time. On a UTC−5 device
`2027-01-01T23:59:59` local becomes `2027-01-02T04:59:59.000Z`, whose **UTC calendar day is 2 January**.
The API stores it verbatim: `authorizations.service.ts:200` (`expiresAt: new Date(dto.expiresAt)`), and
the DTOs validate shape only — `@IsISO8601()` at `dto/create-authorization.dto.ts:11-13`,
`dto/renew-authorization.dto.ts:8-10`, `dto/submit-authorization.dto.ts:25-26`. No normalisation anywhere.

**Consequence for the suggested fix:** at `AuthorizationsTab.tsx:273` and `licenses/page.tsx:199`,
swapping to `fmtCalendarDate` renders web-written rows correctly and renders **mobile-operator-written
rows one day LATE** (Jan 2 instead of Jan 1) — the current local `fmtDate` happens to print those rows
correctly today. The display fix and the writer fix are coupled.

### Verdict — **confirmed** (the defect class is real at 5 of 8 cited sites; the cited site list is partly refuted, and one field's write contract is itself broken)

### Diverging lines

- `apps/web/app/(dashboard)/dashboard/page.tsx:86` — `new Date(row.original.scheduledDate).toLocaleDateString()`
- `apps/web/app/(dashboard)/routes/my-runs/page.tsx:52` — `new Date(run.scheduledDate).toLocaleDateString(undefined, …)`
- `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx:534` — `new Date(run.scheduledDate).toLocaleDateString([], …)`
- `apps/web/app/(dashboard)/deliveries/page.tsx:75` — `new Date(date).toLocaleDateString()`, where `date` is `run?.scheduledDate ?? createdAt` (`:74`)
- `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:273` and `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:199` — `fmtDate(expiresAt)`
- `apps/mobile/app/(customer)/payments.tsx:145` — `fmtDate(c.expiresAt)`
- **writer:** `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` — ``new Date(`${expiresAt.trim()}T23:59:59`).toISOString()``

### Evidence

- Every render site quoted from `git show f60bd27c:<path>` at the lines tabulated above.
- `fmtDate` is local: `apps/web/lib/formatting.ts:30-39` (no `timeZone`). `fmtCalendarDate` is the
  UTC-anchored twin: `apps/web/lib/formatting.ts:55-65`, whose doc at `:50-53` forbids using it on real
  timestamps. Mobile mirrors: `apps/mobile/lib/format-date.ts:25-44`, doc `:11-13`.
- Receivable Summary row builders: `bookkeeping.service.ts:2131-2166`.
- Buyer statement rows: `apps/api/src/customers/customers.service.ts:974-988` —
  `date: c.createdAt.toISOString()` at `:982`, `expiresAt: c.expiresAt…` at `:986`.
- Licence writers tabulated above; API persist at `authorizations.service.ts:200`.

### Refutations attempted, and which succeeded

1. _"All eight cited sites are calendar fields."_ — **Refuted (attack succeeded).** `dashboard:81`
   (`startedAt`), `AuthorizationsTab:278` (`verifiedAt`), `payments.tsx:144` (`c.date` =
   `creditNote.createdAt`) and `payments.tsx:291` (`p.paidAt`) render real timestamps in local time,
   which is correct; and `finance/reports:1234` mixes both kinds in one column.
2. _"`expiresAt` is uniformly UTC midnight, so a UTC-forcing swap is safe."_ — **Refuted.**
   `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` writes local 23:59:59.
3. _"`scheduledDate` might be a real timestamp with a meaningful time-of-day."_ — **Failed.** Both
   writers parse a date-only string (`routes.service.ts:907`, `:1343`), and `RouteRun.startTime` is a
   separate field (`routes.service.ts:908`) — which is exactly where a time-of-day would live.
4. _"The formatter helpers could just be made UTC-safe in place."_ — **Failed.**
   `apps/mobile/app/(customer)/payments.tsx:32-38` defines one local `fmtDate` shared by a calendar
   caller (`:145`) and two timestamp callers (`:144`, `:291`); `apps/web/lib/formatting.ts:30`'s
   `fmtDate` is repo-wide. Converting either helper regresses correct callers.

### Actual cause

Calendar-date fields (`scheduledDate`, licence `expiresAt`, invoice `issueDate`, credit-note `expiresAt`)
are stored as UTC-midnight instants but rendered through local-time formatters, so every
negative-UTC-offset viewer sees the previous day. Independently, the mobile operator licence form writes a
_local_ end-of-day instant instead of UTC midnight, so that field's stored values do not all obey the
contract its readers are meant to assume.

### Missing evidence

- Whether rows written by `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` exist in
  production, and how many — no query was run (read-only pass; prod access out of scope). Until that is
  known, whether a data-repair question even arises is **unestablished**.
- `apps/web/app/(dashboard)/finance/reports/page.tsx` was read only around `:1234` and `:1048`/`:1101-1106`;
  other date columns in that 1200+-line file were not enumerated.
- `Invoice.issueDate` is `DateTime @default(now())` (`schema.prisma:1892`). Application writers use
  `startOfCalendarDay(...)` or `order.orderDate` (`invoices.service.ts:489, :628, :2412, :2637`), but any
  row created without an explicit `issueDate` — e.g. an import path not audited here — would carry a full
  timestamp. Not traced.

### Fix-shape facts

- **Must not change:** `dashboard/page.tsx:81`, `AuthorizationsTab.tsx:278`, `payments.tsx:144`,
  `payments.tsx:291`, and the CREDIT_NOTE/PAYMENT rows behind `finance/reports/page.tsx:1234`. These
  render real timestamps and are correct in local time.
- `deliveries/page.tsx:74` needs its two branches separated before either can be formatted correctly — a
  single call site cannot serve both field kinds.
- `finance/reports/page.tsx:1234` cannot be fixed at the render site alone: the row type
  (`r.type` ∈ INVOICE | CREDIT_NOTE | PAYMENT, `bookkeeping.service.ts:2137/:2149/:2161`) is already
  carried to the renderer and is the only available discriminator.
- Both shared helpers already exist and are documented — `apps/web/lib/formatting.ts:55` and
  `apps/mobile/lib/format-date.ts:25` — so no new abstraction is needed (matches the fix card's "residue
  sweep" framing).
- The licence display fix and the mobile licence writer fix are coupled: fixing the reader alone makes
  mobile-written rows print one day late; fixing the writer alone leaves existing rows and web display
  unchanged.
- `apps/mobile/lib/format-date.ts:32-43` offers `"short"`/`"monthDay"`/numeric styles; the mobile payments
  site currently renders `{ month: "short", day: "numeric", year: "numeric" }` (`payments.tsx:34-38`),
  which matches the `"short"` style.

---

## B118 — On-Time % cutoff is UTC day-end

### Trace

1. `getRoutePerformance` (`analytics.service.ts:378`) and `getDriverPerformance` (`:419`) load runs
   filtered on `scheduledDate` via `runDateFilter` (`:309-312`), then fold each run through
   `accumulateRunMetrics` at `:400` and `:447` — **two callers, one accumulator**.
2. `accumulateRunMetrics` (`:335-343`):

   ```ts
   const dayEnd = new Date(run.scheduledDate); // :336  UTC-midnight calendar stamp
   dayEnd.setUTCHours(23, 59, 59, 999); // :337  → 23:59:59.999 UTC of that day
   for (const stop of run.stops) {
     if (!stop.completedAt) continue; // :340
     runCompletedStops += 1; // :341
     if (stop.completedAt <= dayEnd) agg.onTimeStops += 1; // :342  the comparison
   }
   ```

   `23:59:59.999Z` is **19:59:59.999 EDT / 18:59:59.999 EST**.

3. `completedAt` is server-stamped at completion time, unconditionally, at **two** stop-level write sites:
   `routes.service.ts:2270` and `:2505` (`completedAt: new Date()`), plus the run-level stamps at `:2347`
   and `:2621`. No completion DTO accepts a client-supplied time — `dto/complete-stop.dto.ts:40-43`
   carries `driverNote`, `podPhotoUrls`, `signatureUrl` and no date.
4. A stop delivered at 8:00pm local on its scheduled day stamps `2026-09-05T00:00:00Z`, which is
   `> dayEnd`, so `:342` is false and the stop is counted late; `onTimeRate` (`:363`) is deflated.

### Verdict — **confirmed** — with two of the register's premises corrected

### Diverging line

`apps/api/src/analytics/analytics.service.ts:337` — `dayEnd.setUTCHours(23, 59, 59, 999);` — the day
boundary is fixed in UTC while the value it is compared against (`stop.completedAt`, `:342`) is a real
server-time instant whose "day" the tenant experiences in `TenantConfig.timezone`.

### The three checks the task asked for

1. **The comparison line — confirmed.** `:342` `if (stop.completedAt <= dayEnd)`, with `dayEnd` built at
   `:336-337`. The register cites `:335-343` with the comparison at `:342` — **accurate at the pinned sha**.
2. **`TenantConfig.timezone` is the field invoices uses, and its default — confirmed.**
   `apps/api/prisma/schema.prisma:467`: `timezone String @default("America/New_York")` — non-nullable with
   that default. Invoices reads exactly this field: `invoices.service.ts:233`
   (`select: { invoiceNotes: true, invoiceTerms: true, timezone: true }`), `:238`
   (`timezone: cfg?.timezone ?? null`), and again at `:2403`/`:2407`.
3. **Does another reader already apply a tenant-tz day-end analytics could reuse? — NO for a day-END;
   YES for a day-START.** This **partially refutes** the register's "TenantConfig.timezone exists and is
   ignored":

   ```ts
   // apps/api/src/invoices/invoices.service.ts:69-89
   export function startOfCalendarDay(timeZone?: string | null, now: Date = new Date()): Date {
     …Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", … }).formatToParts(now)…
     …catch { /* Unknown/invalid IANA zone stored on TenantConfig — fall back to UTC, never throw. */ }
     return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
   }
   ```

   Used at `invoices.service.ts:489, :628, :2412, :2637`; spec-covered including the DST and invalid-zone
   cases at `invoices.service.spec.ts:7041-7049` and `:7075-7083`. It computes the **start** of the
   tenant's _current_ day from a `now`; it does **not** compute the end of an arbitrary given calendar
   day, and nothing else in the API does. A repo-wide grep for `timezone` under `apps/api/src` returns
   only: `analytics/demand-range.ts` (comments), `invoices.service.ts` (the above), `messaging/*`
   (quiet-hours, a **separate** nullable `timezone` column on the messaging config), and
   `orders/orders.service.ts` / `regulated/period.ts` (comments explaining deliberate UTC choices).

### A premise the register misses: the UTC rule is **documented intent**

`analytics.service.ts:319-334` is a doc comment on the method itself, and `:325` states the rule
explicitly: _"…falls on or before the END of its run's scheduledDate calendar day (UTC)"_. The code
therefore **matches its own written contract**. The divergence is between that contract and the product
intent the register states ("A stop delivered on its scheduled calendar day counts on-time"). That makes
B118 a specification defect rather than an accidental slip — the ruling has to change the documented
definition, not merely a line.

### Evidence

- Quoted code: `analytics.service.ts:319-343`, `:355-368`; callers `:400`, `:447`; window filter `:309-312`.
- `completedAt` writers: `routes.service.ts:2270`, `:2505` (stop-level), `:2347`, `:2621` (run-level).
- Schema: `schema.prisma:467` (`TenantConfig.timezone`), `:1200` (`RouteRun.scheduledDate DateTime`).
- Existing tenant-tz helper: `invoices.service.ts:69-89`, specs `invoices.service.spec.ts:7041-7049`.
- Existing on-time specs pin the current boundary — see Fix-shape facts.

### Refutations attempted and why each failed

1. _"`completedAt` might already be normalised to the scheduled day."_ — **Failed.**
   `routes.service.ts:2270` and `:2505` write `new Date()` unconditionally; nothing rewrites it.
2. _"Analytics might already load `TenantConfig` and just not use it here."_ — **Failed.** No `timezone`
   reference exists anywhere under `apps/api/src/analytics/` except a comment in `demand-range.ts:5`. The
   service has no tenant-config read on this path.
3. _"A tenant-tz day-end helper already exists to reuse."_ — **Failed.** Only a day-**start**
   (`startOfCalendarDay`) exists, and it takes a `now`, not a target calendar day.
4. _"The UTC choice is an unnoticed oversight."_ — **Refuted (attack partly succeeded).** `:325`
   documents the UTC rule deliberately.

### Actual cause

The on-time boundary is computed as the end of the scheduled calendar day **in UTC**
(`analytics.service.ts:337`) and compared against a server-time `completedAt` (`:342`), so for a tenant
whose configured timezone is behind UTC — the default `America/New_York` — the cutoff falls in the early
evening local time, and every delivery completed after it, plus every next-morning offline replay, is
scored late; `onTimeRate` (`:363`) is systematically deflated for both the route and driver dashboards.

### Missing evidence

- No production numbers: no measured `onTimeRate` for a real tenant, no count of stops falling in the
  affected window. "Systematically deflated" is an inference from the arithmetic, not an observation.
- The offline-replay half of the register's claim is **unverified**: no offline completion-replay path was
  traced in this pass, so how much later than real-world completion a replayed `completedAt` lands is
  unknown. (The mobile offline queue exists — `apps/mobile/lib/api-client.ts:150-181` — but its replay
  timing for stop completion was not followed.)
- Whether any tenant actually has a non-default `TenantConfig.timezone` was not queried.

### Fix-shape facts

- **Harness blocker** (the classic bug-batch blocker per `BUGFIX-NOTES.md` §Harness-integrity):
  `apps/api/src/analytics/analytics.service.spec.ts` **encodes the current UTC boundary as expected
  behavior**. `:887` uses a stop at `2026-08-10T23:59:59.000Z` as the on-time edge case and `:888`
  `2026-08-11T00:30:00.000Z` as the late one, asserting `onTimeRate` = 5/6 at `:910`. Any tenant-tz or
  grace-window change moves those fixtures; `:939`, `:958`, `:1001`, `:1067` and `:1102` also assert
  `onTimeRate`.
- Two call sites change together: `analytics.service.ts:400` (route performance) and `:447` (driver
  performance) share `accumulateRunMetrics`.
- The doc comment `analytics.service.ts:319-334` states the rule and must be rewritten with the line, or
  the code and its contract diverge again.
- `startOfCalendarDay` is exported from `invoices/invoices.service.ts` — reusing it from `analytics/`
  creates an analytics→invoices module dependency, and its `catch` fallback to UTC on an invalid IANA
  zone (`invoices.service.ts:80-87`) is behavior any reuse inherits.
- Accepting a client-supplied `completedAt` would touch **two** DTO/write pairs
  (`dto/complete-stop.dto.ts` + `routes.service.ts:2270`, and the `CompleteWithPaymentDto` path + `:2505`),
  not the single site the register's `:1705` citation implies.
- Register citation drift: `routes.service.ts:886` → `:907`; `routes.service.ts:1705` → `:2270`/`:2505`.
  `schema.prisma:467` is accurate; `:1196` → `:1195`/`:1200`.

---

## B185 — iOS `-1` heading/speed 400s the whole ping

### Trace (tracker → POST → DTO validation → service persist)

1. **Sample.** iOS Core Location returns `course = -1` and `speed = -1` when those values are invalid
   (stationary, indoors, insufficient fix quality). **The native bridge passes them through unmapped** —
   `apps/mobile/node_modules/expo-location/ios/LocationUtils.swift:30-31` (working-tree read, untracked):

   ```swift
   "heading": location.course,
   "speed": location.speed
   ```

   No sentinel translation, no `hasCourse`-style guard. The JS typings declare `heading: number | null`
   and `speed: number | null` and mention `null` only "on Web"
   (`node_modules/expo-location/build/Location.types.d.ts:277-285`) — so the sentinel arrives at the JS
   boundary as a **number**, not `null`.

2. **Payload.** `apps/mobile/lib/location-tracker.native.ts:35-36` (background task) and `:81-82`
   (foreground one-shot) build:

   ```ts
   heading: sample.coords.heading ?? null,                                   // :35 / :81
   speedKph: sample.coords.speed != null ? sample.coords.speed * 3.6 : null, // :36 / :82
   ```

   `?? null` and `!= null` guard only JS `null`/`undefined`. `-1` passes both, so the wire body carries
   `heading: -1` and `speedKph: -3.6` (`-1 * 3.6`).

3. **Transport.** `apps/mobile/lib/api-client.ts:9` is a plain `axios.create({ baseURL, timeout })`; the
   request interceptor (`:77-82`) only attaches `Authorization` and `X-Tenant-Slug`. **No body transform,
   no null-stripping, no clamping.** The literal object is what is serialised.
4. **Validation.** `apps/api/src/main.ts:144-150` installs
   `new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })` globally, so
   `PostLocationDto` runs before the handler. `apps/api/src/drivers/dto/post-location.dto.ts`:

   ```ts
   @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(360) heading?: number;    // :17-21
   @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(500) speedKph?: number;   // :23-28
   ```

   `@IsOptional()` skips validation **only** for `null`/`undefined`; `-1` and `-3.6` are neither, so
   `@Min(0)` fires on **both fields at once** and the pipe throws a 400 before
   `DriversController.postLocation` (`drivers.controller.ts:65-70`) is entered.

5. **Persist — never reached.** `DriversService.recordLocation` (`drivers.service.ts:93-116`) validates
   only that `recordedAt` parses (`:100-102`) and then creates the row (`:105-115`). No `DriverLocation`
   row is written for a rejected ping.
6. **Swallowed, and NOT queued for retry.** The 400 reaches the response interceptor, whose offline branch
   requires `isNetworkError = !error.response && !!error.request` (`api-client.ts:126`, gate at `:150-156`).
   A 400 **has** a response, so the branch is skipped and the error falls through to
   `return Promise.reject(error)` (`:195`), landing in `location-tracker.native.ts:20-23`'s empty `catch`.
   No retry, no toast, no log — the operator's live map simply stops receiving that driver's breadcrumb.

### Verdict — **confirmed** (sentinel / `@Min(0)` half). The accuracy + null-island half is a genuine **absence** but has no reproducible wrong value — see Missing evidence.

### Diverging lines

- `apps/mobile/lib/location-tracker.native.ts:35` — `heading: sample.coords.heading ?? null` (and its
  duplicate at `:81`): a nullish guard applied to a value whose "unavailable" encoding is `-1`, not null.
- `apps/mobile/lib/location-tracker.native.ts:36` / `:82` — `sample.coords.speed * 3.6` propagates the
  sentinel as `-3.6`.
- `apps/api/src/drivers/dto/post-location.dto.ts:20` (`@Min(0)` on `heading`) and `:27` (`@Min(0)` on
  `speedKph`) — the two constraints that reject the ping.

### The four checks the task asked for

- **Which field(s) actually get rejected, and on what value:** **both** — `heading` on `-1` and `speedKph`
  on `-3.6`, each violating `@Min(0)`. A single stationary/indoor iOS sample trips two constraints in one
  request. `@Max(360)`/`@Max(500)` are not involved. `lat`/`lng` pass their range checks (`:5-16`).
  `batteryPct` (`:30-34`) is never sent by the tracker at all.
- **Does anything already strip negatives?** **No.** Traced end to end: no clamp in the tracker
  (`location-tracker.native.ts:32-39`, `:78-85`); no body transform in axios (`api-client.ts:9`,
  interceptor `:77-82`); no DTO transform beyond `@Type(() => Number)` (`post-location.dto.ts:18`, `:25`);
  no service-side normalisation (`drivers.service.ts:93-116`, whose only guard is `recordedAt`). Nothing
  anywhere strips, clamps, or maps the sentinel.
- **Only two call sites:** `postLocation` is a module-private function (`location-tracker.native.ts:17`,
  not exported), called exactly at `:32` (background task) and `:78` (foreground one-shot). _(Resolves the
  S1 brief's open unknown #4.)_
- **Android:** the analogous mapping is
  `apps/mobile/node_modules/expo-location/android/src/main/java/expo/modules/location/records/LocationResults.kt:125-126`
  (`heading = location.bearing.toDouble(), speed = location.speed.toDouble()`), with no
  `hasBearing()`/`hasSpeed()` consultation. Android's `Location` returns `0.0f` for an unset bearing or
  speed, so Android sends `0`/`0`, which **passes** `@Min(0)`. The 400 is therefore **iOS-only**; Android
  instead persists a _false_ zero heading and zero speed with no marker that the values were unavailable.
  _(Resolves the S1 brief's open unknown #2 — the platforms fail differently.)_

### Evidence

- Native mapping: `expo-location/ios/LocationUtils.swift:22-35` (working tree, untracked) — resolves the
  S1 brief's open unknown #1 at the platform layer.
- JS typings: `expo-location/build/Location.types.d.ts:277-285`.
- Tracker: `apps/mobile/lib/location-tracker.native.ts:17-24`, `:26-41`, `:74-88` (quoted above).
- Transport: `apps/mobile/lib/api-client.ts:9`, `:77-82`, `:120-129`, `:147-156`, `:191-196`.
- Pipe: `apps/api/src/main.ts:144-150`. DTO: `apps/api/src/drivers/dto/post-location.dto.ts` (44 lines,
  `@Min(0)` at `:20` and `:27`). Controller: `apps/api/src/drivers/drivers.controller.ts:65-70`.
  Service: `apps/api/src/drivers/drivers.service.ts:93-116`.
- Column awaiting a writer: `apps/api/prisma/schema.prisma:928-931` —
  `accuracy Decimal? @db.Decimal(8, 2)` with the comment _"F01/B185: horizontal accuracy radius in meters
  … F25 wires the tracker payload and the DTO."_ (**L-035 applies verbatim** — an enablement batch
  pre-added the column addressed to this batch; the schema comment is the spec.)
- No coverage: `apps/api/src/drivers/drivers.service.spec.ts` contains **zero** occurrences of
  `recordLocation`; no mobile test references the tracker.

### Refutations attempted and why each failed

1. _"expo-location already normalises the iOS sentinel to `null`, so `?? null` is sufficient."_ —
   **Failed on native evidence.** `LocationUtils.swift:30-31` passes `location.course` and
   `location.speed` straight into the JS dictionary.
2. _"`@IsOptional()` makes `@Min(0)` inert."_ — **Failed.** `@IsOptional()` skips validation only for
   `null`/`undefined`. `-1` is a present number, so `@Min(0)` runs.
3. _"axios or the DTO's `@Type(() => Number)` strips or coerces the negative away."_ — **Failed.**
   `@Type(() => Number)` only casts type; `Number(-1) === -1`. axios applies no body transform.
4. _"The 400 is queued and replayed by the offline queue, so no ping is actually lost."_ — **Failed.**
   The queue triggers only on `!error.response` (`api-client.ts:126`, `:150-156`); a 400 carries a
   response and is rejected at `:195` into the tracker's empty catch.
5. _"The driver or operator sees an error, so it isn't silent."_ — **Failed.**
   `location-tracker.native.ts:20-23` is an empty `catch` with an explicit "Silent" comment.
6. _"This is Android-and-iOS, so the fix is platform-neutral."_ — **Failed / corrected.** Android emits
   `0`, not `-1`; it never 400s. Only iOS produces the rejection, and Android produces a _different_
   defect — a fabricated zero.
7. _"`accuracy` can simply be added to the tracker payload today."_ — **Failed.**
   `forbidNonWhitelisted: true` (`main.ts:148`) means an `accuracy` property not on the DTO makes the pipe
   reject the **entire** ping — a tracker-first rollout would break every ping, iOS and Android.

### Actual cause

iOS delivers `course`/`speed` as `-1` when unavailable, expo-location forwards those numbers unchanged,
and the tracker's nullish guards (`location-tracker.native.ts:35-36`, `:81-82`) do not recognise them — so
the ping reaches the API carrying `heading: -1` and `speedKph: -3.6`, which both violate `@Min(0)`
(`post-location.dto.ts:20`, `:27`) under the global `ValidationPipe`, producing a 400 that the tracker's
empty `catch` discards without retry. No `DriverLocation` row is written and the live map silently loses
that driver's breadcrumb. Separately and independently, no `accuracy` value is captured despite the column
existing for it, and no coordinate-plausibility check exists.

### Missing evidence

- **The accuracy / null-island half has no wrong-value repro.** No stored row, log, or operator report
  shows a bad `(0,0)` fix or a low-confidence ping producing an observable wrong output. Per the
  behavioral-red-bar rule (`BUGFIX-NOTES.md` §"Behavioral red bar"), that half cannot yield a REG test
  that fails today on its own exact wrong value; it is a hardening gap, and the register's own Verifier's
  note says exactly that ("The claim as filed was a hardening gap (no wrong database write, no observed
  misbehaviour)"). Treated as **undetermined as a bug**, confirmed as an absence.
- No captured device payload from a real iOS handset — the `-1` chain is proven from Apple's documented
  `CLLocation` semantics plus the unmapped bridge, not from an observed request body.
- The `expo-location` version in the working tree was not pinned into this report (the package is
  untracked); a version bump could change `LocationUtils.swift`.
- No production count of dropped pings; the 400s leave no client-side trace by construction.
- What behavior is intended for `(0,0)` beyond "should not silently pass" is still unspecified — the S1
  brief located no spec requirement row for a plausibility threshold, and neither did this pass.

### Fix-shape facts

- **Ordering constraint:** because of `forbidNonWhitelisted: true` (`main.ts:148`), the DTO must gain
  `accuracy` **before** any tracker build sends it; a mobile OTA shipping ahead of the API deploy would
  400 every ping on both platforms. Mobile ships via EAS/OTA independently of the API — the two are not
  atomically deployable.
- **Two duplicate payload sites** must move together: `location-tracker.native.ts:32-39` and `:78-85`
  build the same object independently.
- **L-025 applies:** `location-tracker.native.ts` is one side of a `.native`/`.web` platform split
  (`apps/mobile/lib/location-tracker.ts`, `.native.ts` and `.web.ts` all exist at the pinned sha). Nothing
  automated runs the native branch, which is exactly why this survived — any change here is unverified
  unless the payload construction is lifted into a pure, testable function.
- **L-035 applies:** `DriverLocation.accuracy` already exists (`schema.prisma:931`) and its schema comment
  names B185/F25 as the batch that wires it — no new column, no migration.
- **Relaxing `@Min(0)` is not free:** `heading` and `speedKph` are `Decimal?` columns
  (`schema.prisma:925-926`) that the live map reads via `routes.service.ts:750-761`; whatever value the
  DTO admits is what the map's consumers see.
- The read side surfaces no quality signal today: `routes.service.ts:750-761` takes the latest row within
  five minutes per driver with no accuracy or quality filter — so persisting `accuracy` changes nothing
  observable until a reader uses it.
- **Zero existing tests** to break or extend: `drivers.service.spec.ts` has no `recordLocation` case, and
  no mobile test touches the tracker. A T1 jest proof is available at the DTO level (validate
  `PostLocationDto` with `heading: -1`) without any device.
- Register/card citation drift (all content-identical, line numbers moved):
  `location-tracker.native.ts:31-39` → `:32-39`; `:72-84` → `:74-85`;
  `drivers.service.ts:99-116` → `:93-116`; `routes.service.ts:733-742, 766-776` → a single block at
  `:750-761` (no second block matching the `:766-776` description exists).

---

## Sibling observations

Facts only — same shape, different site. No judgement on whether any belongs in this batch.

**Local getters / a local floor applied to a UTC-midnight calendar stamp**

- `apps/api/src/routes/routes.service.ts:1064-1067` — the runs-list day filter builds its upper bound with
  **local** getters on a UTC instant:
  `const d = new Date(date); const nextDay = new Date(d); nextDay.setDate(nextDay.getDate() + 1); where.scheduledDate = { gte: d, lt: nextDay };`
  Same field and same file as B59/B90's writers; named by neither register entry.
- `apps/web/app/(dashboard)/routes/page.tsx:348` — the second `EditRunModal` mount point, so B59's
  read/write pair is reachable from two screens.

**Calendar-date field rendered with a local formatter (beyond B91's cited list)**

- `apps/web/app/(dashboard)/promotions/page.tsx:57-61` — `fmtWindow(startsAt, endsAt)` renders both with
  `new Date(x).toLocaleDateString(undefined, opts)`.
- `apps/web/app/buyer/portal/[seller]/shop/page.tsx:449` —
  `new Date(activePromo.endsAt).toLocaleDateString()`.
- `apps/web/app/buyer/portal/[seller]/templates/page.tsx:85` —
  `new Date(template.nextFireDate).toLocaleDateString("en-GB", …)`. _(The fix card lists this as
  `templates/page.tsx:85`; no file exists at `apps/web/app/(dashboard)/templates/page.tsx` at the pinned
  sha — the real path is the buyer-portal one, same line number.)_
- `apps/mobile/app/(auth)/role-picker.tsx:103` —
  `new Date(nextRun.scheduledDate).toLocaleDateString(undefined, …)`. _(The fix card lists this as
  `mobile role-picker.tsx:103` under `(operator)`; at the pinned sha the file lives at
  `apps/mobile/app/(auth)/role-picker.tsx`, same line number.)_
- `apps/mobile/app/(customer)/shelf.tsx:41-43` — a local `formatDate` helper,
  `new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short" })`.

**Cited as offenders by the fix card but rendering REAL TIMESTAMPS (local rendering is per-contract correct at these sites)**

- `apps/mobile/app/(operator)/customers/[id]/statement.tsx:154` — renders `t.date`, which is
  `invoice.createdAt` / `creditNote.createdAt` (`apps/api/src/customers/customers.service.ts:342`, `:355`).
- `apps/mobile/app/(operator)/suppliers/[id].tsx:152` — renders `row.date` from the supplier statement.
- `apps/mobile/app/(customer)/finances.tsx:145` — renders `p.date` for a payment row.
  _(All three are listed among the fix card's "15 confirmed offenders"; on the evidence above the fields
  they render are timestamps, not calendar dates.)_

**Already-correct UTC-anchored sites (the fix card's "must not be fixed" set, verified)**

- `apps/mobile/app/(driver)/route/index.tsx:183` — `.slice(0, 10).replace(/-/g, "/")`, with the
  explanatory comment at `:178-182`.
- `apps/mobile/app/(operator)/credit-notes/[id].tsx:165`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx:1279`,
  `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx:892`,
  `apps/mobile/app/(operator)/estimates/[id].tsx:145` — all `fmtCalendarDate`.
- `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx:635`,
  `apps/web/app/(dashboard)/orders/_components/CreditNotePicker.tsx:271`,
  `apps/web/app/(dashboard)/estimates/[id]/page.tsx:358`, `:503`,
  `apps/web/app/(dashboard)/estimates/page.tsx:937`,
  `apps/web/app/(dashboard)/finance/reports/page.tsx:1106` — all `fmtCalendarDate`.
- `apps/mobile/lib/buyer-payments-logic.ts:15-19` — `monthLabel` uses `Date.UTC(...)` with
  `timeZone: "UTC"`.
- `apps/api/src/invoices/invoices.service.ts:96-100` — `addCalendarDays` uses `setUTCDate`, with a comment
  naming the local-getter hazard.

**Local-time write of a value read as a calendar date (writer-side siblings)**

- `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` —
  ``new Date(`${expiresAt.trim()}T23:59:59`).toISOString()``: an offset-less date-time literal is parsed as
  **local**, so the stored instant's UTC calendar day is the next day for negative-offset devices. Its
  three sibling writers all produce UTC midnight (`apps/web/.../AuthorizationsTab.tsx:64`,
  `apps/web/.../LicenseGuardModal.tsx:97`, `apps/mobile/app/(customer)/licenses.tsx:130`).
- Downstream of that writer, `apps/api/src/authorizations/authorization-expiry.service.ts:101`
  (`expiresAt: { lt: now }`) and `authorization-guard.service.ts:67` (`new Date(auth.expiresAt) < now`)
  compare the stored instant directly against `now` — so a UTC-midnight row and a local-23:59:59 row
  expire at instants roughly 29 hours apart for the same chosen calendar day.
- `apps/mobile/app/(customer)/licenses.tsx:141` renders `row.expiresAt.slice(0, 10)` — a raw UTC slice,
  which prints a mobile-operator-written value as the day after the one that was typed.

**Three duplicate local date formatters coexist** (named by the fix card, verified present)

- `apps/web/lib/format.ts:31-36` (`formatDate`, local — with a `:21-30` doc warning it is not for calendar
  dates), `apps/web/lib/formatting.ts:30-39` (`fmtDate`, local), and
  `apps/mobile/app/(customer)/payments.tsx:32-38` (a file-local `fmtDate`, local). The UTC-safe
  counterparts are `apps/web/lib/formatting.ts:55` and `apps/mobile/lib/format-date.ts:25`.

**Existing tests that pin behavior a fix would move**

- `apps/api/src/analytics/analytics.service.spec.ts:885-890`, `:910` — fixtures placed exactly on the UTC
  day boundary (`2026-08-10T23:59:59.000Z` on-time, `2026-08-11T00:30:00.000Z` late) asserting
  `onTimeRate` = 5/6; further `onTimeRate` assertions at `:939`, `:958`, `:1001`, `:1067`, `:1102`.
- `apps/api/src/invoices/invoices.service.spec.ts:7041-7049`, `:7075-7083` — `startOfCalendarDay`'s
  tenant-tz, DST and invalid-zone behavior is already locked.
- `apps/mobile/__tests__/customer-authorizations-logic.test.ts:110-116` — `validateLicenseForm` asserts a
  `YYYY-MM-DD` shape and a past-date rejection, but nothing asserts the instant the writer produces.
