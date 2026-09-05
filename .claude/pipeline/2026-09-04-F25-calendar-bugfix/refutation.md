# Cause refutation — B59, B90, B91, B118, B185 (F25-calendar)

> S2, read-only. Method: **assume every suspected cause is wrong**, then try to disprove it by tracing the
> repro input to the wrong output in the code itself. Every line below is re-read at the pinned sha; the S1
> brief and the registry are treated as hypotheses, never evidence (L-026, L-031).
>
> No `templates/CAUSE-REFUTATION.md` exists in the skill (`templates/` holds only `BUG-TEST-PLAN.md`,
> `CAUSE-BRIEF.md`, `CAUSE-RULING.md`), so this file uses the section set named in the task.

**Pinned sha for every citation: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d`**
(`fix(api): customer-keyed advisory lock for order merges (imp-02) + wave D (#609)`) — the same sha S1 used.
All `git show`/`git blame` run against it. Line numbers below are this pass's own read, not the registry's.

---

## 0. The data contract, established first (it decides three of the five verdicts)

Before any per-id verdict: "is `X` a calendar date or a timestamp?" is the question every one of B59/B90/B91
turns on. The repo answers it in code, not in the register:

| Fact                                                                                                    | Evidence at pinned sha                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RouteRun.scheduledDate` is a **calendar date stored at UTC midnight**                                  | `apps/web/app/(dashboard)/routes/page.tsx:32-34` — `// Calendar dates stored at UTC midnight (run scheduledDate) need the UTC renderer; formatDate above is the local-time one, correct for createdAt.`                                                                                                                                                                                                                                                                                            |
| … and the only production writer makes it so                                                            | `apps/web/app/(dashboard)/routes/page.tsx:85` `const today = new Date().toISOString().split("T")[0]` → `:101` `{ routeId, scheduledDate: date, … }`; `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx:313` same shape. API: `apps/api/src/routes/routes.service.ts:907` `scheduledDate: new Date(dto.scheduledDate)` — a bare `YYYY-MM-DD` parses as UTC midnight per ES spec. There is exactly one `routeRun.create` in product code (`tx.routeRun.create`, `routes.service.ts:903-907`). |
| `fmtDate` is documented as **forbidden** for calendar fields, `fmtCalendarDate` is the UTC-anchored one | `apps/web/lib/format.ts:21-30` (`⚠️ NOT for calendar dates stored at UTC midnight (dueDate, issueDate, scheduledDate, expiresAt, …)`); `apps/web/lib/formatting.ts:27-28`, `:55-65` (`timeZone: "UTC"`); mobile mirror `apps/mobile/lib/format-date.ts:1-14`, `:25-44` (and its explicit `Do NOT use this for real timestamps (paidAt, createdAt, receivedAt, lastRunAt, …)`).                                                                                                                     |
| The same −1-day trap is already documented and fixed at a sibling site                                  | `apps/mobile/app/(driver)/route/index.tsx:178-183` (`NEW-rweb-7` comment) → `:183` `new Date((run.scheduledDate ?? "").slice(0,10).replace(/-/g,"/"))`.                                                                                                                                                                                                                                                                                                                                            |

So: local-time rendering of `scheduledDate` **is** a contract violation, not a taste call. That is what makes
B59/B90/B91's _class_ survivable. It is also what lets me refute several specific sites below — the same rule
says a real timestamp rendered locally is **correct**, and several cited "offenders" are timestamps.

Schema note: `apps/api/prisma/schema.prisma` has **no `@db.Date` anywhere** — `scheduledDate` (`:1200`),
`expiresAt` (`:3671`, `:2303`), `issueDate` (`:1892`) are all plain `DateTime`. The calendar-ness is a
convention enforced only by writers. That is why the deviant writer found under B91 matters.

---

## B59 — Edit Route Run rolls `scheduledDate` back one day on every save

### Trace (repro input → wrong output)

Input: a run with `scheduledDate = 2026-06-10T00:00:00.000Z`; operator in `America/Los_Angeles` (UTC−7 in
June) opens Edit Route Run, changes **only** the driver, clicks Save.

1. `apps/web/app/(dashboard)/routes/[id]/page.tsx:876` / `apps/web/app/(dashboard)/routes/page.tsx:348-356`
   pass `run.scheduledDate` straight through — it is the API's JSON serialisation of a Prisma `DateTime`,
   i.e. the full ISO string `"2026-06-10T00:00:00.000Z"` (`apps/web/lib/api/routes.ts:75` types it `string`).
   **No normalisation upstream** — the first refutation attempt fails here.
2. `EditRunModal.tsx:33` — `const [date, setDate] = React.useState(formatLocalDate(run.scheduledDate));`
   (state is seeded once; there is no re-derivation on prop change).
3. `EditRunModal.tsx:17-23` — the **read path**, verbatim:
   ```ts
   function formatLocalDate(value: string): string {
     const d = new Date(value); // 2026-06-09 17:00 local in America/Los_Angeles
     const y = d.getFullYear(); // LOCAL getter
     const m = String(d.getMonth() + 1).padStart(2, "0"); // LOCAL getter
     const day = String(d.getDate()).padStart(2, "0"); // LOCAL getter
     return `${y}-${m}-${day}`; // "2026-06-09"
   }
   ```
   → the `<input type="date">` at `:98-104` pre-fills **2026-06-09**.
4. `EditRunModal.tsx:50-56` — the **write path**, verbatim:
   ```ts
   const handleSave = () => {
     const body: { id: string; driverId?: string | null; scheduledDate?: string; notes?: string } = {
       id: run.id,
       notes,
     };
     if (driverId !== initialDriverId) body.driverId = driverId || null;
     if (!isInProgress) body.scheduledDate = date;      // ← line 56
   ```
   The value sent is the raw input string `"2026-06-09"` — a **date-only** string, i.e. neither "local
   midnight" nor an ISO instant. (The second refutation attempt — "maybe it re-serialises to a local-midnight
   ISO, so the API's parse cancels the display shift" — fails: nothing wraps `date`.)
5. `apps/web/lib/api/routes.ts:394` — `apiClient.patch('/route-runs/${id}', body)`.
6. `apps/api/src/routes/routes.controller.ts:271-280` — `@Patch(":id")`, `@Body() body: { driverId?; scheduledDate?; notes? }`.
   **There is no `UpdateRouteRunDto`** (`git ls-tree apps/api/src/routes/dto` lists 12 DTOs, none of them
   `update-route-run.dto.ts`) — so no `@IsDateString`, no transformation, nothing.
7. `apps/api/src/routes/routes.service.ts:1341-1345`:
   ```ts
   const data: any = {};
   if (dto.driverId !== undefined) data.driverId = dto.driverId;
   if (dto.scheduledDate) data.scheduledDate = new Date(dto.scheduledDate); // ← line 1343
   if (dto.notes !== undefined) data.notes = dto.notes;
   return this.prisma.forTenant().routeRun.update({ where: { id }, data });
   ```
   `new Date("2026-06-09")` → `2026-06-09T00:00:00.000Z`. **No normalisation on write** — the third
   refutation attempt fails. The wrong day is _persisted_, not merely displayed.

### Verdict — **confirmed**

Both halves of the suspicion hold, and they are independent defects that compose:
the read path corrupts the pre-fill, the write path makes an untouched field a write on every save.

### Diverging line

- **Display divergence:** `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx:19-21` — three LOCAL
  getters (`getFullYear`/`getMonth`/`getDate`) applied to a UTC-midnight instant. Intent per
  `apps/web/lib/format.ts:25-29` is that this exact field is read in UTC.
- **Persistence divergence:** `EditRunModal.tsx:56` — `if (!isInProgress) body.scheduledDate = date;`. The
  guard is _status_, never _dirtiness_; `date` is never compared to its own initial value (contrast `:55`,
  which **does** dirty-check `driverId !== initialDriverId` one line above — the same function already knows
  the pattern).

### Evidence

- `git show <sha>:"apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx"` lines 17-23, 33, 50-56, 98-104 (quoted above).
- `git show <sha>:apps/api/src/routes/routes.service.ts` line 1343 (quoted above); controller `:271-280`.
- `git blame <sha> -L 17,23 / -L 56,56` → `8980490e2` (Najath Akram, 2026-05-02 21:39:16 −0500,
  `Reapply "fix(qa): land all 32 findings from 2026-05-02 full-coverage QA"`) for every implicated line
  except the closing brace at `:23` (`9d56a06d7`). Introduced inside a 32-finding QA batch, not as a date change.
- Registry line drift **corrected**: the update-path write is at `routes.service.ts:1343` (create path at
  `:907`), not `:1289`/`:875`/`:968` as the register cites. Same construct, different lines.

### Actual cause

`EditRunModal` treats `run.scheduledDate` as a local-time instant on the way in (`:19-21`) and re-submits the
resulting string on every save regardless of whether the operator touched the date (`:56`); the API's update
path applies it verbatim with no normalisation (`routes.service.ts:1343`). Any save by a negative-offset
operator therefore shifts the run's calendar day back by one, cumulatively.

### Missing evidence

- No production incident, row count, or affected-run count in any source. The bug is argued from code.
- No test exists to disturb: `git ls-tree -r <sha> -- "apps/web/app/(dashboard)/routes/_components"` returns
  only the component; `git grep EditRunModal <sha> -- apps/web/e2e` returns nothing.

### Fix-shape facts (constraints, not a proposal)

- `EditRunModal` is rendered from **two** call sites, with two differently-shaped props:
  `apps/web/app/(dashboard)/routes/[id]/page.tsx:876` (passes the full `run` object) and
  `apps/web/app/(dashboard)/routes/page.tsx:348-356` (constructs a 5-field literal). Anything added to
  `EditableRun` must be satisfiable at both.
- The `<input type="date">` at `:98-104` requires exactly `YYYY-MM-DD`; whatever produces the seed value must
  keep that shape or the input silently renders empty.
- `routes.service.ts:1343` is guarded by `if (dto.scheduledDate)` (truthy), so an **omitted** key already
  leaves the stored date untouched — the API needs no change for a dirty-check-only fix on the client.
- The PATCH body has **no DTO** (controller `:276` takes an inline type). Adding validation there is a
  behaviour change for every other client of `PATCH /route-runs/:id`, including the DRIVER role
  (`routes.controller.ts:273` `@Roles(OPERATOR, DRIVER)`, service `:1329-1339` restricts drivers to their own
  run and forbids `driverId`).
- `isInProgress` (`:48`) also disables the driver select and the date input (`:83`, `:102`) — the status gate
  at `:56` is not redundant with a dirty check; it is a separate rule about IN_PROGRESS runs.

---

## B90 — Mobile Exceptions flags on-schedule runs as "Late route"

### Trace

Input: run `scheduledDate = 2026-06-10T00:00:00.000Z`, `status = IN_PROGRESS`; device in `America/New_York`
(UTC−4 in June), wall clock `2026-06-10 09:00` local.

1. `apps/mobile/app/(operator)/exceptions.tsx:36` — `useOperatorRouteRuns({ status: "IN_PROGRESS", limit: 20 })`.
   **The query carries no date parameter at all.** So the task's first fork resolves: there is _no_ server-side
   day bound; the day comparison is 100% client-side filtering of an already-fetched list. Nothing upstream
   normalises `run.scheduledDate` — the API returns the serialised `DateTime`.
2. `:42-43` — `const today = new Date(); today.setHours(0, 0, 0, 0);` → `2026-06-10T04:00:00.000Z` (local
   midnight). Correct for "the operator's today".
3. `:60-61` — `const scheduled = new Date(run.scheduledDate); scheduled.setHours(0, 0, 0, 0);`
   `new Date("2026-06-10T00:00:00.000Z")` is `2026-06-09 20:00` **local**; `setHours(0,0,0,0)` floors to the
   previous **local** midnight → `2026-06-09T04:00:00.000Z`.
4. `:62` — `if (scheduled < today)` → `2026-06-09T04:00Z < 2026-06-10T04:00Z` → **true** → the run is pushed as
   `late_route` (`:66-74`) on the very day it is scheduled.

Refutation attempts that failed: (a) "the bound is really a server query that assumes UTC stamps" — no date
param is sent (`:36`); (b) "`setHours` on both sides cancels out" — it does not, because the two operands are
in _different_ frames: `today` is a genuine local instant, `scheduled` is a UTC-anchored calendar value;
(c) "maybe the field isn't UTC midnight" — see §0, the sole writer makes it so.

### Verdict — **confirmed**

Which side is "correct" is decided by the data contract, and the contract is unambiguous (§0): the compared
field is a UTC-anchored **calendar date**, so it must be reduced to a calendar day in UTC before being compared
to the device's calendar day. `today` is the correct operand; `scheduled` is the wrong one.

Scope note the register understates: this is **negative-offset only**. For a positive-offset device (e.g.
UTC+5:30), `new Date(utcMidnight)` lands on the _same_ local day and `setHours` floors correctly — no
misflag. Any red-bar test must pin the timezone.

### Diverging line

`apps/mobile/app/(operator)/exceptions.tsx:61` — `scheduled.setHours(0, 0, 0, 0);` (device-local floor applied
to a UTC-anchored calendar instant). `:60` is the enabling parse; `:62` is where the wrong boolean is read.

### Evidence

- File quoted verbatim above from `git show <sha>:"apps/mobile/app/(operator)/exceptions.tsx"` lines 36, 40-43, 58-76.
- The in-repo statement of the correct pattern for **this same field**:
  `apps/mobile/app/(driver)/route/index.tsx:178-183` (the `NEW-rweb-7` comment + `.slice(0,10).replace(/-/g,"/")`).
- **S1 gap closed:** `git blame <sha> -L 58,62 -- "apps/mobile/app/(operator)/exceptions.tsx"` → all five lines
  are `5b3d533e0`; `git show -s 5b3d533e0` = `Najath Akram, Tue Apr 21 11:58:12 2026 −0500,
"feat(mobile): full feature sprint — bugs, Finance tab, expenses, offline, customer portal"` — i.e. the
  late-route rule shipped inside a broad feature sprint, never as a date-correctness change (same provenance
  shape as B59's `8980490e2`).
- No test: `git ls-tree -r <sha> -- apps/mobile/__tests__` contains no `exceptions*` file.

### Actual cause

`exceptions.tsx:61` normalises a UTC-anchored calendar instant with the device-local `setHours`, mixing frames
in the `<` at `:62`. For any negative-UTC-offset device the run's calendar day is read as the previous day,
so every IN_PROGRESS run scheduled _today_ satisfies the "late" predicate.

### Missing evidence

- No production report of a spurious "Late route" row; argued from code.
- `apps/mobile/lib/api/routes.ts`'s `RouteRun.scheduledDate` type was not opened this pass (the field is
  consumed as a string at `:60` and elsewhere, which is sufficient for the trace but not a type citation).

### Fix-shape facts

- `today` (`:42-43`) is shared with nothing else in the memo — the other two loops (`:46-56` urgent orders,
  `:79-89` returns) never read it, so changing how "today" is derived has no other consumer inside this file.
- The memo's dependency array is `[urgentOrdersQ.data, pendingReturnsQ.data, activeRunsQ.data]` (`:94`) — it
  does **not** depend on time, so the "today" value is frozen for the life of the mounted screen either way;
  any fix inherits that existing staleness rather than introducing it.
- Mobile tests are pure-logic-only by convention (`CLAUDE.md`, `apps/mobile/__tests__/*.test.ts`) — a red bar
  for this needs the predicate extracted or asserted as a pure function, not a screen render.

---

## B91 — Calendar-date fields rendered with local-time formatters

This is the id where refutation changes the answer most. I classified **every** cited site by whether the
rendered field is a calendar date or a real timestamp, from the field's writer.

### Per-site trace and classification

| #   | Site (pinned sha)                                                                                                                                         | Rendered field                    | Field's true kind (writer evidence)                                                                                                               | Verdict                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/web/app/(dashboard)/dashboard/page.tsx:86` — `new Date(row.original.scheduledDate).toLocaleDateString()`                                            | `RouteRun.scheduledDate`          | Calendar (§0)                                                                                                                                     | **confirmed offender**                                                                                                                                   |
| 2   | `apps/web/app/(dashboard)/routes/my-runs/page.tsx:51-57` — `new Date(run.scheduledDate).toLocaleDateString(undefined, {weekday,month,day})`               | `scheduledDate`                   | Calendar (§0)                                                                                                                                     | **confirmed offender** — and note the _same file_ already does it right for grouping at `:293` (`run.scheduledDate.slice(0, 10)`) and `:301`             |
| 3   | `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx:534-538` — `new Date(run.scheduledDate).toLocaleDateString([], {...})`                            | `scheduledDate`                   | Calendar (§0)                                                                                                                                     | **confirmed offender**                                                                                                                                   |
| 4   | `apps/web/app/(dashboard)/deliveries/page.tsx:74-75` — `const date = run?.scheduledDate ?? row.original.createdAt; … new Date(date).toLocaleDateString()` | **mixed**                         | `scheduledDate` = calendar; `createdAt` = real timestamp                                                                                          | **confirmed offender for the `scheduledDate` branch only** — the fallback branch is correct today and would _break_ under a blanket swap (see fix-shape) |
| 5   | `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:273` — `` `· Expires ${fmtDate(auth.expiresAt)}` ``                                 | `CustomerAuthorization.expiresAt` | Calendar for 3 of 4 writers, **not** for the 4th — see "The deviant writer" below                                                                 | **confirmed offender, with a data caveat**                                                                                                               |
| 6   | `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:199` — `Expires {fmtDate(row.expiresAt)}`                                                           | same field                        | same                                                                                                                                              | **confirmed offender, same caveat**                                                                                                                      |
| 7   | `apps/web/app/(dashboard)/finance/reports/page.tsx:1234` — `{fmtDate(r.date)}`                                                                            | **polymorphic**                   | `bookkeeping.service.ts:2135` `date: inv.issueDate` (calendar), `:2147` `date: cn.createdAt` (timestamp), `:2159` `date: p.createdAt` (timestamp) | **confirmed offender for INVOICE rows only**; CREDIT_NOTE and PAYMENT rows are correct today                                                             |
| 8   | `apps/mobile/app/(customer)/payments.tsx:32-38` (`fmtDate` = local) called at `:145` on `c.expiresAt`                                                     | `CreditNote.expiresAt`            | Calendar — every writer is `new Date("YYYY-MM-DD").toISOString()`: web `credit-notes/page.tsx:217`, mobile `credit-notes/new.tsx:202-207`         | **confirmed offender**                                                                                                                                   |
| 9   | `apps/mobile/app/(auth)/role-picker.tsx:103` — `new Date(nextRun.scheduledDate).toLocaleDateString(...)`                                                  | `scheduledDate`                   | Calendar (§0)                                                                                                                                     | **confirmed offender** (fix-card claim verified)                                                                                                         |

Sites cited by the fix card that this pass **refutes** (the field is a real timestamp, so local rendering is
the _documented-correct_ behaviour per `format.ts:22-23` and `format-date.ts:11-13`):

| Site                                                                                                         | Rendered field                | Why it is NOT a bug                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/app/(dashboard)/promotions/page.tsx:57-62` (`fmtWindow(startsAt, endsAt)`)                         | `Promotion.startsAt`/`endsAt` | The form is `<input type="datetime-local">`: `:42-50` `toLocalInput` and `:52-55` `fromLocalInput` (`// datetime-local is in the operator's local zone; store as UTC ISO`) → `:395-396`. The API compares them as **instants**: `apps/api/src/promotions/promotions.service.ts:242` `startsAt: { lte: now }, endsAt: { gte: now }`. These are timestamps, not calendar dates. **Refuted.** |
| `apps/web/app/buyer/portal/[seller]/shop/page.tsx:449` — `new Date(activePromo.endsAt).toLocaleDateString()` | same `endsAt`                 | Same reason. **Refuted.**                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/mobile/app/(operator)/customers/[id]/statement.tsx:154` — `new Date(t.date).toLocaleDateString()`      | `t.date`                      | `apps/api/src/customers/customers.service.ts:342` `date: i.createdAt.toISOString()` and `:355` `date: c.createdAt.toISOString()` — both real timestamps. **Refuted.**                                                                                                                                                                                                                      |
| `apps/mobile/app/(operator)/suppliers/[id].tsx:152` — `new Date(row.date).toLocaleDateString()`              | supplier-statement `row.date` | Not traced to its writer this pass; the sibling statement builder above uses `createdAt`. **Undetermined — do not cite as an offender without the writer.**                                                                                                                                                                                                                                |
| `apps/mobile/app/(customer)/finances.tsx:145` — `new Date(p.date).toLocaleDateString()`                      | a _payment_ row's `date`      | Payments are events with a time-of-day; the analogous builder uses `createdAt`. Writer not traced. **Undetermined.**                                                                                                                                                                                                                                                                       |
| `apps/mobile/components/CostHistorySheet.tsx:53` — `new Date(h.date).toLocaleDateString(...)`                | cost-history `h.date`         | Writer not traced this pass. **Undetermined.**                                                                                                                                                                                                                                                                                                                                             |
| `apps/mobile/app/(customer)/shelf.tsx:42` (`formatDate`)                                                     | call site not traced          | **Undetermined.**                                                                                                                                                                                                                                                                                                                                                                          |

Citation error to record (L-026): the fix card names **`templates/page.tsx:85` (nextFireDate)** without a
prefix. `apps/web/app/(dashboard)/routes/templates/page.tsx` **does not exist at this sha**
(`fatal: path … does not exist`). The real site is
`apps/web/app/buyer/portal/[seller]/templates/page.tsx:81-85` — `new Date(template.nextFireDate).toLocaleDateString("en-GB", …)`;
whether `nextFireDate` is a calendar date was not traced. **Undetermined, and the cited path is wrong.**

### The deviant writer (this is the material finding under B91)

`CustomerAuthorization.expiresAt` has **four** writers, and one of them does not store a UTC-midnight calendar
value:

| Writer              | Line                                                                                                                                                              | What it stores for an entered `2027-01-01`                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Web operator        | `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:64` — `const iso = new Date(expiresAt).toISOString();` (from `<input type="date">`, `:140`) | `2027-01-01T00:00:00.000Z` ✔ calendar                                                                                  |
| Web buyer portal    | `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:106` — `new Date(expiresAt).toISOString()`                                                                  | `2027-01-01T00:00:00.000Z` ✔ calendar                                                                                  |
| Mobile buyer        | `apps/mobile/app/(customer)/licenses.tsx:117-130` — validates an exact `YYYY-MM-DD` that round-trips (`:122-125`), then `onSubmit(…, d.toISOString(), true)`      | `2027-01-01T00:00:00.000Z` ✔ calendar                                                                                  |
| **Mobile operator** | `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` — `expiresAt: new Date(`${expiresAt.trim()}T23:59:59`).toISOString(),`                                | **local** 23:59:59 → on a UTC−5 device, `2027-01-02T04:59:59.000Z` ✘ **not** UTC midnight, and on the **next** UTC day |

Consequence, stated as a fact: today, `fmtDate` (local) renders the mobile-operator-written row _correctly_
(Jan 1) and the other three writers' rows _wrongly_ (Dec 31) for a UTC−5 viewer; `fmtCalendarDate` (UTC) would
invert that exactly — correct for three writers, one day **late** for the fourth. The display sites at
AuthorizationsTab `:273` and buyer licenses `:199` therefore cannot be made correct for all rows by changing
the formatter alone. The API accepts both shapes: `CreateAuthorizationDto:11-13` / `RenewAuthorizationDto:8-10`
/ `SubmitAuthorizationDto:25-26` are all bare `@IsISO8601()`, and `authorizations.service.ts:200`, `:266`,
`:354-356` all persist `new Date(dto.expiresAt)` verbatim.

### Verdict — **confirmed** (the class and 9 sites), with the register's site list corrected

The suspected cause survives for sites 1-9. It is **refuted** for promotions (both sites) and mobile
`statement.tsx`, and **undetermined** for five further fix-card claims whose writers were not traced. Site 5/6
carry a data caveat (the deviant writer) that a display-only fix cannot resolve.

### Diverging lines

`dashboard/page.tsx:86` · `routes/my-runs/page.tsx:52` · `routes/[id]/dispatch/page.tsx:534` ·
`deliveries/page.tsx:75` (for the `scheduledDate` branch of `:74`) · `customers/_components/AuthorizationsTab.tsx:273` ·
`buyer/portal/[seller]/licenses/page.tsx:199` · `finance/reports/page.tsx:1234` (INVOICE rows only) ·
`apps/mobile/app/(customer)/payments.tsx:145` (via the local `fmtDate` defined at `:32-38`) ·
`apps/mobile/app/(auth)/role-picker.tsx:103`.
Plus the write-side divergence at `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84`.

### Evidence

Every table row above is a `git show <sha>:<path>` read this pass; the four writers and the polymorphic
`bookkeeping.service.ts:2131-2166` row builder are quoted by line. Correct-sibling counter-examples that
prove the helper is the house standard for these exact fields:
`apps/web/app/(dashboard)/routes/page.tsx:440-451` (`fmtCalendarDate(run.scheduledDate)`, with a comment
explaining why), `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx:635`,
`apps/web/app/(dashboard)/finance/reports/page.tsx:1106`, `apps/web/app/buyer/portal/[seller]/finances/page.tsx:232`,
`apps/mobile/app/(operator)/credit-notes/[id].tsx:165`, `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx:1279`,
`apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx:892`, `apps/mobile/app/(operator)/estimates/[id].tsx:145`.

Counter-example inside a cited file, proving `fmtDate` is not wrong _everywhere_ there:
`AuthorizationsTab.tsx:278` — `fmtDate(auth.verifiedAt)` on a real timestamp is **correct** and must not be swapped.

### Actual cause

Nine display sites decode a UTC-anchored calendar instant with local-time APIs (`toLocaleDateString()` with no
`timeZone`, or the deliberately-local `fmtDate`/`formatDate`), against an explicit in-repo contract that names
these very fields as UTC. Independently, one _writer_ (`mobile/(operator)/customers/[id]/licenses.tsx:84`)
stores `expiresAt` as a local end-of-day instant instead of UTC midnight, so the license-expiry column holds
two incompatible shapes.

### Missing evidence

- Five fix-card sites (`suppliers/[id].tsx:152`, `(customer)/finances.tsx:145`, `CostHistorySheet.tsx:53`,
  `(customer)/shelf.tsx:42`, buyer `templates/page.tsx:85`) have **no writer trace** — classification unknown.
- The register's "three duplicate local formatters" claim was partially checked: `apps/web/lib/format.ts:31`
  (`formatDate`) and `apps/web/lib/formatting.ts:30` (`fmtDate`) both exist and are both local-time;
  `apps/mobile/utils/format.ts:8` was not opened.
- No count of affected rows in any environment; nothing shows how many `CustomerAuthorization` rows were
  written by the deviant mobile path.
- The spec's open question (does the e2e tenant carry a regulated tracked category for a licence-expiry
  oracle) is still unresolved — not investigated this pass.

### Fix-shape facts

- `deliveries/page.tsx:74` and `finance/reports/page.tsx:1234` render **polymorphic** values. A blanket
  formatter swap at either site converts a today-correct timestamp render into a tomorrow-wrong one. The
  branch/type discriminator already exists at both (`run?.scheduledDate ?? …createdAt`; `r.type` is available
  on the row and already drives `<StatusBadge status={r.type} />` at `:1237`).
- `AuthorizationsTab.tsx` contains **both** kinds five lines apart (`:273` calendar, `:278` timestamp).
- `apps/mobile/app/(customer)/payments.tsx:32-38` defines its **own** local `fmtDate` and uses it for both
  `c.date` (a `createdAt`, `customers.service.ts:355` — correct) and `c.expiresAt` (calendar — wrong) at
  `:144-145`. The shared `fmtCalendarDate` already exists at `apps/mobile/lib/format-date.ts:25`.
- Any change to the mobile-operator licence writer is a **data-shape** change on an existing column with rows
  already written both ways — a read-only report of the distribution is the prerequisite, not part of a
  display fix (registry's own verifier note calls B91 "display-only", which the deviant writer contradicts).

---

## B118 — On-Time % cutoff is a UTC day-end

### Trace

Input: run `scheduledDate = 2026-06-10T00:00:00.000Z`; tenant timezone `America/New_York` (EDT, UTC−4); a stop
completed at 8:15pm local → `completedAt = 2026-06-11T00:15:00.000Z`.

1. `apps/api/src/analytics/analytics.service.ts:336` — `const dayEnd = new Date(run.scheduledDate);`
2. `:337` — `dayEnd.setUTCHours(23, 59, 59, 999);` → `2026-06-10T23:59:59.999Z` = **7:59:59.999pm EDT**.
3. `:342` — `if (stop.completedAt <= dayEnd) agg.onTimeStops += 1;` → `2026-06-11T00:15Z <= 2026-06-10T23:59:59.999Z`
   is **false** → the stop lands in the denominator (`:341`) but not the numerator.
4. `:363` — `onTimeRate: agg.completedStops > 0 ? (agg.onTimeStops / agg.completedStops) * 100 : null`.

Refutation attempts: (a) "`completedAt` might be client-supplied, so an offline replay could carry the true
local time" — **fails**: `CompleteStopDto` (`apps/api/src/routes/dto/complete-stop.dto.ts`, full file, 54
lines) has **no `completedAt` field at all**, and `main.ts:145-149` runs `ValidationPipe({ whitelist: true,
transform: true, forbidNonWhitelisted: true })`, so a client that _sent_ one would be 400'd. The server stamps
it at four sites: `routes.service.ts:2270`, `:2347`, `:2505`, `:2621`, all bare `completedAt: new Date()`.
(Registry cited `:1705`; that line is wrong — corrected here.)
(b) "maybe some other reader already applies a tenant-tz day-end that analytics just needs to call" —
**fails**: `git grep "timezone: true" <sha> -- apps/api/src` returns exactly two hits, both in
`apps/api/src/invoices/invoices.service.ts` (`:233`, `:2403`). `git grep endOfCalendarDay <sha> -- apps`
returns **nothing**. `analytics.service.ts` contains no occurrence of `timezone`, `tenantConfig`, or
`TenantConfig` at all.
(c) "maybe the register's timezone field is the wrong one" — **fails**: `schema.prisma:461-467`,
`model TenantConfig { … timezone String @default("America/New_York") … }`, and it is the field
`invoices.service.ts:233` selects. Default confirmed as `America/New_York`, not UTC.

### Verdict — **confirmed** (mechanism), with an intent caveat the ruling must resolve

The suspected cause is factually exact: the cutoff is a UTC day-end, `TenantConfig.timezone` exists with a
non-UTC default, and analytics reads it nowhere. The observed wrong output follows deterministically from
`:337`.

**But the code does not diverge from its own documented intent.** `analytics.service.ts:322-328` states the
rule verbatim — _"a completed stop counts as on-time when its completedAt falls on or before the END of its
run's scheduledDate calendar day **(UTC)**"_ — and `git blame <sha> -L 335,352` puts every implicated line on
`de3afd50a` (najathakram, 2026-08-28, `feat(analytics): on-time %, stops/hour, avg duration on route & driver
performance (#478)`), whose commit body records the same UTC framing as a design choice at the metric's
introduction. This matches the register's own verifier note. So B118 is a **specification change** (the
documented definition is wrong for US tenants), not a repair of code that departed from its spec — a
distinction the fix ruling has to make explicitly, because it decides whether the existing specs are pins or
must be rewritten.

Register correction retained and re-verified: the cutoff is 7:59:59.999pm EDT (8:15pm local is late), not
"~7pm"; the register's own 7:30pm-EDT repro would score **on-time** under current code.

### Diverging line

`apps/api/src/analytics/analytics.service.ts:337` — `dayEnd.setUTCHours(23, 59, 59, 999);` (the cutoff), read
at `:342`. Contributing, unchangeable-by-this-fix: `routes.service.ts:2270/2347/2505/2621` stamp `completedAt`
server-side with no client override, so an offline replay's `completedAt` is the _upload_ time.

### Evidence

- `analytics.service.ts:319-343` and `:355-368` quoted from `git show <sha>:apps/api/src/analytics/analytics.service.ts` (verbatim above).
- `schema.prisma:461-467` (`TenantConfig.timezone String @default("America/New_York")`).
- `git grep "timezone: true" <sha> -- apps/api/src` → 2 hits, both `invoices.service.ts`.
- `invoices.service.ts:59-89` — `startOfCalendarDay(timeZone, now)` maps an **instant → that tenant-local
  calendar day's UTC midnight**, falling back to UTC on an unknown IANA zone without throwing (`:80-87`).
  It is the _instant → calendar-day_ direction; there is no _calendar-day → tenant-local day-end_ helper
  anywhere in the repo.
- Existing specs assert the current arithmetic only: `apps/api/src/analytics/analytics.service.spec.ts:910`,
  `:939`, `:958`, `:1001`, `:1067`, `:1102` — none constructs a timezone-boundary fixture, none references
  `TenantConfig.timezone` (verified by grep this pass).

### Actual cause

`analytics.service.ts:337` anchors the on-time cutoff to the end of the scheduled **UTC** day while
`completedAt` is a server-stamped real instant, so any delivery completed after ~8pm tenant-local (EDT) on its
scheduled day falls past the cutoff and is counted late. `TenantConfig.timezone` is available and read by
`invoices.service.ts` for exactly this class of question, but `AnalyticsService` never loads it.

### Missing evidence

- **No production evidence of a deflated On-Time % reading** — no tenant KPI value, no row count, nothing in
  the register beyond verification provenance. This is the weakest-evidenced id in the batch.
- No evidence about how often offline replays actually occur (the second half of the register's suggested fix
  rests entirely on that).
- `AnalyticsService`'s constructor/injections were not read, so whether it can reach `TenantConfig` in its
  current shape (tenant-scoped Prisma client vs an explicit tenantId argument) is untraced.

### Fix-shape facts

- The on-time rule is _documented_ at `:319-334`; changing behaviour without changing that doc-comment leaves
  the file self-contradictory.
- Six existing assertions in `analytics.service.spec.ts` encode the current arithmetic. A tenant-tz cutoff
  changes none of them **only if** their fixtures' `completedAt` values stay inside both cutoffs — that has to
  be checked fixture by fixture, not assumed.
- `accumulateRunMetrics` is `private` and called per run inside a group fold; it currently takes
  `(agg, run)` only — any tenant timezone has to be threaded in from the caller, not fetched inside the loop.
- `startOfCalendarDay(tz, instant)` already exists and is exported from `apps/api/src/invoices/invoices.service.ts:69`
  (imported by its spec at `:22`), with DST-boundary tests at `invoices.service.spec.ts:7041-7049` and
  `:7075-7083`, including the invalid-zone fallback. It is the _instant → calendar day_ direction; there is no
  existing _day → day-end_ helper. Importing an invoices-module symbol into analytics is a new cross-module
  dependency.
- `run.scheduledDate` is also the analytics window filter (`analytics.service.ts:310-313`
  `{ scheduledDate: { gte: fromDate, lte: toDate } }`) — that comparison is untouched by the on-time question
  but shares the same field's UTC framing.

---

## B185 — iOS `-1` sentinels for heading/speed 400 the whole location ping

### Trace (tracker → POST → DTO validation → service persist)

Input: an iOS fix where the device cannot resolve course or speed, so `coords.heading === -1` and
`coords.speed === -1`.

1. `apps/mobile/lib/location-tracker.native.ts:32-39` (background task) and `:78-85` (the one-shot on
   `startLocationTracking`) build the payload:
   ```ts
   heading: sample.coords.heading ?? null,                                  // :35  −1 is NOT null → −1 is sent
   speedKph: sample.coords.speed != null ? sample.coords.speed * 3.6 : null, // :36  −1 → −3.6 is sent
   ```
   `??`/`!= null` only guard `null`/`undefined`; **nothing maps the sentinel** and nothing clamps. First
   refutation attempt ("something upstream strips negatives") fails here — and again at every later step.
2. `:19` — `await apiClient.post("/drivers/me/location", payload);` wrapped in `:18-23`, whose `catch {}` is
   empty by design (`// Silent — telemetry failures should not surface to the driver.`). So the rejection is
   invisible to the driver **and** to the operator map.
3. `apps/api/src/drivers/drivers.controller.ts:65-70` — `@Post("me/location")`, `@Body() dto: PostLocationDto`.
4. `apps/api/src/drivers/dto/post-location.dto.ts` (full file, 44 lines):
   ```ts
   @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(360) heading?: number;     // :17-22
   @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(500) speedKph?: number;    // :24-29
   ```
   `@Min(0)` fails on `-1` **and** on `-3.6`. So **two** properties are rejected, not one — the register's
   framing ("heading and speed minimums") is right, and both fire on the same ping.
5. `apps/api/src/main.ts:145-149` — `new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })`.
   A failing constraint on any property rejects the **entire request** (400), so a ping that carries a perfect
   `lat`/`lng`/`recordedAt` is discarded wholesale.
6. `apps/api/src/drivers/drivers.service.ts:93-118` — `recordLocation` is never reached. Its only extra check
   is `:100-103` (`recordedAt` parses); `:105-116` persists `lat/lng/heading/speedKph/batteryPct/recordedAt`
   verbatim. **No negative-stripping, no plausibility gate, no null-island check** anywhere on the path.

Second refutation attempt — "`@IsOptional()` plus `@Type(() => Number)` might coerce `null` to `0`, so the
`null` branch is the real bug instead": **fails**. `class-transformer`'s
`TransformOperationExecutor.js:86-90` returns `value` unchanged when it is `null`/`undefined` before calling
`Number(value)`, and `@IsOptional()` skips all constraints for `null`. So the `null` path is clean; only the
`-1` path 400s.

### Verdict — **confirmed**

The inverted-validation half (the stronger half, per the register's own verifier note) is exactly as filed and
is confirmed on both properties. The hardening half (no `accuracy`, no null-island check) is also confirmed as
a code fact — with one correction that changes its fix shape (below).

### Diverging line

`apps/api/src/drivers/dto/post-location.dto.ts:20` (`@Min(0)` on `heading`) and `:27` (`@Min(0)` on `speedKph`)
— the constraints reject the platform's documented "unavailable" encoding. Equivalently, the client-side
divergence is `apps/mobile/lib/location-tracker.native.ts:35` and `:36` (and their duplicates at `:81`, `:82`),
which forward the sentinel unmapped. The failure is _silenced_ at `location-tracker.native.ts:20-23`.

### Evidence

- All four files quoted verbatim above from `git show <sha>:…`.
- `apps/api/src/main.ts:145-149` (ValidationPipe options).
- `node_modules/class-transformer/cjs/TransformOperationExecutor.js:86-90` (the `null` short-circuit for
  `Number`) — read from the working tree, not the pinned sha, since it is a dependency.
- **Correction to the register's evidence line (L-035 exactly):** the register says "no accuracy field" and the
  suggested fix says "add an optional accuracy field". The **column already exists**:
  `apps/api/prisma/schema.prisma:928-931` —
  ```prisma
  // F01/B185: horizontal accuracy radius in meters, straight from the device
  // fix — lets readers drop or flag low-confidence pings. F25 wires the
  // tracker payload and the DTO.
  accuracy   Decimal? @db.Decimal(8, 2)
  ```
  i.e. an earlier enablement batch pre-provisioned it **for this batch**, and the schema comment names F25 by
  name. `heading`/`speedKph` are `Decimal?` (`:926-927`) — nullable, so a mapped-to-null sentinel persists fine.
- Platform surface: `location-tracker.web.ts` and `location-tracker.ts` are no-op stubs (full files read) —
  the payload builder exists **only** in `.native.ts`, so this code is invisible to every automated surface
  (**L-025** applies precisely: a `.native`/`.web` split is untested code unless something runs that platform).

### Actual cause

The mobile tracker forwards iOS's `-1` "unavailable" encoding for `course`/`speed` unmapped
(`location-tracker.native.ts:35-36`, `:81-82`); `PostLocationDto`'s `@Min(0)` on `heading` (`:20`) and
`speedKph` (`:27`) then fail, and Nest's global `ValidationPipe` 400s the **whole** ping — discarding a valid
`lat`/`lng`/`recordedAt` — after which `postLocation`'s empty `catch` (`:20-23`) swallows the rejection so no
surface reports a gap in the breadcrumb feed.

### Missing evidence

- **The `-1` sentinel itself is not verifiable from this repository.** It is an iOS/CoreLocation platform
  behaviour (`CLLocation.course`/`.speed` = −1 when invalid) surfaced through `expo-location`; nothing in the
  repo asserts or documents it, and there is no test or comment naming it. The whole id rests on that external
  fact — the ruling should treat it as an assumption to verify on a device (or against the expo-location
  typings) before the red bar is written around `-1` specifically. The DTO defect (`@Min(0)` rejects any
  negative) is repo-verifiable regardless of what value iOS sends.
- No production evidence: no count of dropped pings, no operator report of a stale live map.
- No test exists on this path: no spec was found for `recordLocation` or `PostLocationDto` this pass (not
  exhaustively grepped).
- Whether Android's `expo-location` ever emits negatives was not investigated.

### Fix-shape facts

- The payload is built **twice** in the same file — `:32-39` (background task) and `:78-85` (foreground
  one-shot) — with identical field expressions. Both must change together or the sentinel survives on one path.
- `DriverLocation.accuracy` exists (`schema.prisma:931`) and is `Decimal?`; `whitelist: true` +
  `forbidNonWhitelisted: true` (`main.ts:146-148`) means the tracker **cannot** send `accuracy` until the DTO
  declares it — sending it today would 400 the ping exactly like the sentinel does. No migration is needed for
  the column; the wiring is DTO + service + tracker.
- The readers cited by the register pass rows straight through with no quality signal:
  `apps/api/src/routes/routes.service.ts:733-742` and `:766-776` (the five-minute latest-row lookup) — anything
  that starts dropping low-confidence fixes changes what those readers return.
- `drivers.service.ts:105-116` writes `heading`/`speedKph` straight from the DTO; both columns are nullable
  (`schema.prisma:926-927`), so mapping a sentinel to `null` client-side needs no server change.
- The empty `catch` at `location-tracker.native.ts:20-23` is deliberate and documented; it is also the reason
  this shipped unnoticed. Any behavioural test of the reject path must observe the server, not the client.

---

## Sibling observations (facts only — same shape elsewhere, no fix proposals)

Recorded because a bug's twin ships more often than the bug returns (BUGFIX-NOTES, "Sibling sweep"; L-029, L-031).

**Local getters / local floors applied to `RouteRun.scheduledDate` (B59/B90 shape):**

- `apps/web/app/(dashboard)/dashboard/page.tsx:86` — `new Date(scheduledDate).toLocaleDateString()`.
- `apps/web/app/(dashboard)/routes/my-runs/page.tsx:52` — `.toLocaleDateString(undefined, {weekday, month, day})`.
- `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx:534` — `.toLocaleDateString([], {weekday, month, day})`.
- `apps/web/app/(dashboard)/deliveries/page.tsx:75` — `.toLocaleDateString()` on `scheduledDate ?? createdAt`.
- `apps/mobile/app/(auth)/role-picker.tsx:103` — `.toLocaleDateString(undefined, {month, day})`.
- `apps/mobile/app/(operator)/exceptions.tsx:61` — `setHours(0,0,0,0)` (the B90 site itself).
- Correct counterparts in the same field, for contrast: `apps/web/app/(dashboard)/routes/page.tsx:450`
  (`fmtCalendarDate`), `apps/web/app/(dashboard)/routes/my-runs/page.tsx:293` and `:301`
  (`scheduledDate.slice(0, 10)`), `apps/mobile/app/(driver)/route/index.tsx:183`.

**Two-writer disagreement on one column (the B91 caveat):**

- `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` stores `CustomerAuthorization.expiresAt` as
  `new Date("<YYYY-MM-DD>T23:59:59").toISOString()` (local end-of-day), while
  `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:64`,
  `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:106`, and
  `apps/mobile/app/(customer)/licenses.tsx:130` all store `new Date("<YYYY-MM-DD>").toISOString()` (UTC midnight).
- The API accepts both without normalising: `authorizations.service.ts:200`, `:266`, `:354-356`
  (`new Date(dto.expiresAt)`), behind bare `@IsISO8601()` DTOs
  (`create-authorization.dto.ts:11-13`, `renew-authorization.dto.ts:8-10`, `submit-authorization.dto.ts:25-26`).

**Boundary semantics that read the same column as a strict instant (adjacent to the above, not part of any filed id):**

- `apps/api/src/authorizations/authorizations.service.ts:86` — `a.expiresAt && new Date(a.expiresAt) < now`
  (lazy EXPIRED display); `:129`, `:395`; mirrored client-side at `apps/web/lib/api/authorizations.ts:87`.
  With a UTC-midnight `expiresAt`, a licence dated "expires 2027-01-01" is already expired at 00:00Z, i.e.
  ~7pm local on 2026-12-31 for a US-Eastern tenant.
- `apps/api/src/credit-notes/credit-notes.service.ts:491`, `:528`, `:643`, `:717`, `:975` — same
  `expiresAt <= now` instant comparison on the (UTC-midnight) credit-note calendar field;
  `apps/web/app/(dashboard)/credit-notes/page.tsx:29` and `credit-notes/[id]/page.tsx:284` mirror it.

**Polymorphic `date` fields fed into a single formatter:**

- `apps/api/src/bookkeeping/bookkeeping.service.ts:2135` (`inv.issueDate`, calendar), `:2147` (`cn.createdAt`),
  `:2159` (`p.createdAt`) all populate one `rows[].date`, rendered by one `fmtDate` at
  `apps/web/app/(dashboard)/finance/reports/page.tsx:1234`. The same builder shape appears at `:1953`
  (`date: inv.issueDate`) and `:1992` (`date: est.createdAt`).
- `apps/api/src/customers/customers.service.ts:342` and `:355` build a `date` from `createdAt` only —
  consumed by `apps/mobile/app/(operator)/customers/[id]/statement.tsx:154` and
  `apps/mobile/app/(customer)/payments.tsx:144` (both correct as local renders).

**Timestamps correctly rendered locally (recorded so they are not swept in by mistake):**

- `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:278` (`fmtDate(auth.verifiedAt)`).
- `apps/web/app/(dashboard)/promotions/page.tsx:59-60` and `apps/web/app/buyer/portal/[seller]/shop/page.tsx:449`
  (`Promotion.startsAt`/`endsAt` — `datetime-local` in, instant comparison at
  `apps/api/src/promotions/promotions.service.ts:242`).
- `apps/web/app/(dashboard)/routes/page.tsx:453-456` (`run.startedAt` → `toLocaleTimeString`).
- `apps/web/app/(dashboard)/dashboard/page.tsx:81-84` (`row.original.startedAt` → `toLocaleTimeString`).

**Server-stamped `completedAt` with no client override (B118 shape):**

- `apps/api/src/routes/routes.service.ts:2270`, `:2347`, `:2505`, `:2621` — all `completedAt: new Date()`.
- `apps/api/src/routes/dto/complete-stop.dto.ts` (whole file) declares no timestamp field, and
  `apps/api/src/main.ts:146-148` sets `forbidNonWhitelisted: true`, so no client can add one.
- `apps/api/src/routes/routes.service.ts:3116` resets `completedAt: null` on a run reopen.

**Tenant-timezone awareness is a single-module capability:**

- Only `apps/api/src/invoices/invoices.service.ts:233` and `:2403` select `TenantConfig.timezone`; the only
  consumers are `:489`, `:628`, `:2412`, `:2637` via `startOfCalendarDay` (`:69-89`).
  `git grep endOfCalendarDay <sha> -- apps` returns nothing.

**Date-only string parsed to UTC midnight with no DTO in front of it:**

- `apps/api/src/routes/routes.service.ts:1343` (update, **no DTO at all** — controller `:276` takes an inline
  body type) versus `:907` (create, behind `CreateRouteRunDto:12` `@IsDateString()`). The list filter at
  `:1063-1068` reads the same field with `new Date(date)` + local `setDate(+1)` for the upper bound.

**Pre-provisioned schema column addressed to this batch (L-035):**

- `apps/api/prisma/schema.prisma:928-931` — `accuracy Decimal? @db.Decimal(8, 2)` with the comment
  `// F01/B185: … F25 wires the tracker payload and the DTO.` No reader, no writer, no DTO field exists yet.

**Lessons that bear on this batch's method (Lesson lines, read this pass):**

- **L-026** — _"A spec's factual claims about a file are a hypothesis, not evidence — read the file before
  editing it, and report the correction rather than quietly conforming or quietly diverging."_ Applied: the
  register's line numbers for B59 (`:1289`), B118 (`:1705`, `:886`) and B91 (`templates/page.tsx`) are all
  wrong at this sha and are corrected above.
- **L-031** — _"A reported location is a hypothesis, not a finding. Before fixing, re-derive which call sites
  can actually REACH the bad state, and sweep the whole file for siblings — the reachable ones are often not
  the reported one."_ Applied: B91's site list gained three sites the register never named and lost three the
  fix card wrongly named.
- **L-035** — _"Before designing where something is stored, grep the schema for a column addressed to your
  batch — the schema comment IS the spec."_ Applied: `DriverLocation.accuracy` already exists for B185.
- **L-025** — _"A `Platform`/`isWeb` branch is untested code unless something runs that platform."_ Applied:
  B185's entire payload builder lives in `location-tracker.native.ts`; `.web.ts` and the type-stub are no-ops.
- **L-029** — sibling-path enumeration; applied as the sweep above (notably the two duplicate payload builders
  in `location-tracker.native.ts` and the four `completedAt` stamp sites).
