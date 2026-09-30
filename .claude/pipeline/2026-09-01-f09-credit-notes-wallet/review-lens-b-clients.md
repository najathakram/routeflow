# F09 · Review lens B — web + mobile + e2e (scope-coverage and operability)

Reviewer: lens B (read-only, committed content only — `git show HEAD:` / `git diff d12203a3...HEAD`).
Branch `fix/F09-credit-notes-wallet`, HEAD `5c0dc464`, base master `d12203a3`.
Method: refute-first. Every candidate below survived an attempt to explain it away from the
surrounding committed code; the refuted ones are recorded in the answers section, not as findings.

## VERDICT: **FIX-THEN-SHIP**

The shipped client behaviour is correct — R7/R8/R10/R12 are all satisfied and the DRAFT flow is
genuinely gone from web and mobile. **The new e2e spec is not.** Both of its tests will fail on the
deployed build for a reason this suite has already paid for twice (L-076, and a verbatim warning
comment in `15-stock-count-ui.spec.ts`), and the one that carries `REG-B18` cannot fail on B18's own
wrong value even after that is fixed. Nothing in `apps/web/app`, `apps/web/lib` or `apps/mobile` needs
to change; the fixes are confined to `apps/web/e2e/28-credit-note-wallet.spec.ts` (3 lines) plus two
stale API QA harness scripts.

Counts — **1 blocker · 2 major · 1 minor · 2 nit**.

---

## Findings

### B1 · BLOCKER · `apps/web/e2e/28-credit-note-wallet.spec.ts:102` and `:122`

**Claim.** Both heading locators are unscoped and resolve to **two** elements on the deployed
dashboard, so `toBeVisible()` throws a Playwright strict-mode violation and **both T13 and T14 fail**
— i.e. the entire new spec 28 goes red in the deploy-signal E2E run, and REG-B18/REG-B19 can never be
discharged.

**Evidence.**

- `packages/ui/src/web/PageHeader.tsx:21` renders `<h2>{title}</h2>`, and its own comment (`:18-20`)
  says "the dashboard layout's top bar already renders the page `<h1>`".
- `apps/web/app/(dashboard)/layout.tsx:709` — `{title && <h1 className="text-base font-semibold text-navy truncate">{title}</h1>}`,
  inside a `<header>` (`:686`) rendered unconditionally at `:1387` as a sibling of `<main id="main-content">`
  (`:1399`). No responsive hiding — it is in the a11y tree at the Desktop Chrome viewport.
- List page: `apps/web/app/(dashboard)/credit-notes/page.tsx:532` `setTitle("Credit Notes")` → the
  top-bar `<h1>Credit Notes</h1>`; `:633` `title="Credit Notes"` → the PageHeader `<h2>Credit Notes</h2>`.
  → `page.getByRole("heading", { name: "Credit Notes" })` matches **2**.
- Detail page: `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx:212` `setTitle(cn.creditNoteNumber)`
  → `<h1>CN-2026-0088</h1>`; `:330` `<h2 className="text-2xl font-bold text-navy">{cn.creditNoteNumber}</h2>`.
  → `page.getByRole("heading", { name: cn.creditNoteNumber })` matches **2**.
  (`getByRole`'s `name` defaults to `exact: false` — case-insensitive substring — so the match is if
  anything broader than exact, never narrower.)

**Refutation attempts, all failed.**

1. _"The top-bar h1 is mobile-only."_ — No. `layout.tsx:686` carries no `lg:hidden` / `hidden lg:*`
   class on the header, and `:709` none on the `<h1>`. The mobile-nav trigger next to it at `:690`
   **does** carry `lg:hidden`, which is exactly the class the `<h1>` would need and does not have.
2. _"`setTitle` may not have run yet."_ — It runs in a mount effect and the assertion has a 15 s
   timeout; the h1 is present well before the h2 assertion would otherwise settle. On the detail page
   the effect is gated on `cn`, the same data that renders the h2 — they appear together.
3. _"Radix/Next may portal the header elsewhere."_ — It is plain JSX in the same tree; `#main-content`
   at `:1399` is its sibling, which is precisely why other specs scope to that id.
4. _"Other specs do this and pass."_ — They do not. Every list/detail heading assertion in this suite
   is scoped: `21-destructive-guards.spec.ts:200`, `22-payment-truth.spec.ts:209-211`,
   `23-run-settlement-note.spec.ts:167`, `30-recurring-standing.spec.ts:272`,
   `34-calendar-dates.spec.ts:116` all go through `page.locator("#main-content")`;
   `19-compliance-pack-gate.spec.ts:32` through `page.getByRole("main")`; and
   `15-stock-count-ui.spec.ts:150-153` uses `{ level: 2 }` with the comment "level: 2 — the dashboard
   shell's `<h1>` page title ALSO reads 'Stock Counts' (via setTitle), so an unleveled heading match
   resolves 2 elements and violates strict mode." Spec 28 is the only unscoped one. This is the
   sibling of lesson **L-076** (same string rendered twice ⇒ strict-mode violation).

**Failure scenario.** Post-deploy E2E runs `npx playwright test` with no `--project` filter
(`.github/workflows/ci.yml:712`), so the `credit-note-wallet` project runs. T13 errors at line 102 and
T14 at line 122 with `strict mode violation: locator(...) resolved to 2 elements`. The prod E2E
baseline moves from 130/0/26 to 128 pass / 2 fail, B18 and B19 stay stuck at `proven-pending-deploy`,
and the failure looks like a product regression rather than a locator bug.

**Proposed fix (one line each).** Scope both through the content region, matching the majority
precedent: `page.locator("#main-content").getByRole("heading", { name: "Credit Notes" })` at `:102`
and `page.locator("#main-content").getByRole("heading", { name: cn.creditNoteNumber })` at `:122`
(`{ level: 2 }` per spec 15 is an equally valid alternative).

---

### B2 · MAJOR · `apps/web/e2e/28-credit-note-wallet.spec.ts:66` + `:125-127` (the REG-B18 oracle)

**Claim.** T14's `toHaveCount(0)` on the `Issue Credit Note` button is **vacuous as a regression
oracle**: it passes identically on the pre-fix build, so a green REG-B18 is not evidence that B18 was
fixed and a future reintroduction of the DRAFT branch would not be caught.

**Evidence.** The fixture pins `status: "ISSUED"` (`:66`). On base `d12203a3` the only element named
"Issue Credit Note" was the sidebar button inside `{status === "DRAFT" && (…)}` in `[id]/page.tsx`
(removed at diff hunk `@@ -643,28 +558,13 @@`), plus the `IssueConfirmModal` footer button — and that
modal is a Radix `Dialog.Root` (`packages/ui/src/web/Modal.tsx:36`) with no `forceMount`, so its
content is unmounted while `open={false}`. With an ISSUED fixture neither is in the DOM on the buggy
build ⇒ count 0 ⇒ green before _and_ after.

**Refutation attempts, failed.** (a) _"The build is the real proof."_ — Partly true: `bug-test-plan.md`
lists `R7→T14 (+ build: DRAFT branches no longer compile)`, and the compile-time proof is genuine. But
the test carries the `REG-B18` token, and `scripts/campaign/bugs.mjs:2261-2263` makes that token the
thing campaign-check matches; the deploy-signal run is what `build-plan.md` §Close-out uses to
"discharge B18/B19". A discharge signal that cannot go red is exactly the failure mode **L-041**
records ("the run cited as their proof turned out to have executed nothing"). (b) _"A DRAFT fixture
would not compile."_ — The fixture is an untyped object literal in an e2e file (`creditNoteFixture()`
at `:57-74` has no `CreditNote` annotation), so `status: "DRAFT"` compiles fine and is exactly the
wire shape R7/R8 promise the UI now ignores.

**Failure scenario.** Someone reintroduces a `status === "DRAFT"` Issue affordance (or reverts the P5
hunk). T14 stays green because the fixture is ISSUED; B18 is reported discharged; the dead flow is
back on the deployed build with no signal.

**Proposed fix.** Change the T14 fixture to `status: "DRAFT"` (inline `{ ...creditNoteFixture(), status: "DRAFT" }`
at `:113`, or a `creditNoteFixture({ status })` parameter) so the assertion fails on the pre-fix build
and pins "even a DRAFT payload shows no Issue affordance" — which is the actual R7/R8 guarantee.

---

### B3 · MAJOR · `apps/api/scripts/qa-run.js:1295-1302` and `apps/api/scripts/e2e-verify.ts:1286-1303`

**Claim.** Two manual QA harnesses are still clients of the route deleted by P2
(`credit-notes.controller.ts` `@Post(":id/issue")`, removed at diff hunk `@@ -48,13 +48,6 @@`) and
will now fail against any deployed build.

**Evidence.**

- `qa-run.js:1295` — `await test(53, "POST /credit-notes/:id/issue → status ISSUED", …)` then
  `assert(r.status === "ISSUED", …)`. A 404 makes `r.status` undefined ⇒ hard assertion failure.
- `e2e-verify.ts:1286` — `expect([200, 201, 400].includes(status), …)`; 404 is not in that list ⇒ fail.

**Refutation attempts, failed.** (a) _"They are wired into a gate, so CI would have caught it."_ — The
opposite: `git grep -rn "e2e-verify|qa-run"` outside the two files returns exactly one hit, a doc
cross-reference in `apps/api/scripts/qa-ui-checklist.md:4`. Neither is referenced by any npm script or
workflow, so nothing red-flags them; they rot and produce a false failure the next time an operator
runs the QA battery. (b) _"They are out of this lens."_ — They are the client-side consequence of the
controller route deletion, which this lens is explicitly scoped to. (c) _"`bug-test-plan.md`'s
harness-integrity list already covers them."_ — It lists the jest fixtures and the mobile helper test
only; these two scripts are not in it.

**Failure scenario.** The next manual QA pass reports `53 FAIL` / `POST /credit-notes/:id/issue`
against a healthy deploy, and someone spends a session chasing a phantom regression.

**Proposed fix.** Delete `qa-run.js` test 53 and the `e2e-verify.ts` "POST /credit-notes/:id/issue"
check — the endpoint no longer exists. The `test(53, …)` ids are labels, so removing the call is enough.

---

### B4 · MINOR · `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx:63`

**Claim.** Operator-visible copy still promises an issuing step. The void-confirm modal body reads
"Voiding this credit note will mark it as cancelled. It can no longer be issued or applied."

**Refutation attempt, failed.** _"'issued' here is the ordinary verb (= created)."_ — In a
void-confirmation it describes what a **void note can no longer have done to it**, i.e. a state
transition; and a note is created ISSUED, so it can never be "issued" again in either sense. Every
other surviving "Issue"/"Issued" string on both pages is either the ISSUED **status** (`page.tsx:37`,
`[id]/page.tsx:346,568`) or the **Issue Date** field (`[id]/page.tsx:420,544`; `page.tsx:721,733`) —
legitimate, keep. The list EmptyState "Issue a credit note to refund or adjust a customer's balance."
(`page.tsx:813`) and the create-modal description (`:250`) use "issue" as a synonym for "create",
which stays true; only `:63` names it as a lost capability.

**Proposed fix.** "…It can no longer be applied."

---

### B5 · NIT · `apps/web/lib/api/credit-notes.ts:3` + `:7`

`import type { CreditNoteStatus } from "@routeflow/types";` and
`export type { CreditNoteStatus } from "@routeflow/types";` both name the same symbol from the same
module. It compiles (the `export … from` form creates no local binding, so there is no duplicate
identifier) and I could not find a rule in `apps/web/eslint.config.mjs`'s chain that I can confirm
forbids it — **I did not run lint, so I am not asserting it is clean.** Mobile does the same job with
one import plus a bare `export type { CreditNoteStatus };` (`apps/mobile/lib/api/credit-notes.ts:2,10`).
**Fix (optional):** adopt the mobile form for symmetry.

### B6 · NIT · `apps/mobile/lib/credit-notes-logic.ts:28-29`

With the union now 3-valued, the `default: return { variant: "gray", label: status }` branch is
unreachable and `status` narrows to `never` there. It still compiles and is a safe runtime fallback
for an unexpected wire value, so this is **not** a defect — but it means a future 4th
`CreditNoteStatus` would silently render a gray pill instead of failing the build.
`packages/types/api/enums.ts` + `enum-parity.spec.ts` are the real guard, so no change is required;
recorded only so it is a decision rather than an oversight. (Same shape, pre-existing and unchanged:
`page.tsx:560-565` still computes `kpiCounts.applied` / `kpiCounts.void`, which `showCount` at `:680`
never displays.)

---

## The eight answers

### 1 · R7/R8 completeness — CONFIRMED COMPLETE for the clients (no finding)

`git grep -n useIssueCreditNote|canIssue|IssueConfirmModal HEAD -- apps` → **all empty**. Remaining
hits of the sweep pattern, each classified:

| Hit                                                                                                                                                    | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/app/(operator)/credit-notes/new.tsx:30-31` `case "DRAFT": return { variant: "gray", label: "Draft" }`                                     | **DIFFERENT DOMAIN — correct to keep.** It is inside `invoiceStatusPill(status: string)` (`:25-44`), the **invoice** picker's pill for the invoice being credited; the sibling cases are SENT/VIEWED/PARTIAL/PAID/OVERDUE and `HIDDEN_INVOICE_STATUSES` at `:23` is `{VOID, WRITTEN_OFF}`. Invoice DRAFT is legitimate, and `cause-ruling.md` §2 explicitly keeps DRAFT sources allowed. `build-plan.md` §6's instruction to touch `new.tsx` was mis-scoped; **not touching it is the right call** and this deviation is worth one line in the close-out. |
| `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx:99-105` (comment + `all.filter(inv => inv.status !== "PAID" && !== "VOID" && !== "WRITTEN_OFF")`) | **DIFFERENT DOMAIN.** Invoice statuses in the apply-to-invoice picker. The comment explains why invoice DRAFT is deliberately _not_ hidden — consistent with the ruling.                                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/api/scripts/qa-run.js:1295`, `apps/api/scripts/e2e-verify.ts:1286` (`/credit-notes/:id/issue`)                                                   | **LEFTOVER OF THE DEAD FLOW → finding B3.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/mobile/lib/api/credit-notes.ts:9`, `apps/mobile/__tests__/credit-notes-helpers.test.ts:5`, `28-credit-note-wallet.spec.ts:12`                    | Explanatory comments naming DRAFT as impossible — fine, keep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Sub-items. **i18n/copy:** there is no i18n catalogue in this repo (copy is inline); the only stale
string is `[id]/page.tsx:63` → B4. **Filter chips:** web `page.tsx:36-39` and mobile `index.tsx:20-25`
both drop `DRAFT`; mobile's `FilterId` is derived from `FILTERS` (`index.tsx:27`) so no dead branch
survives. **Status pills:** web uses `<Badge status={…} />`, a shared multi-domain component correctly
untouched; mobile's `creditNotePillFor` switch (`credit-notes-logic.ts:21-31`) drops DRAFT — see B6 on
its default. **Mobile `new.tsx` DRAFT case:** refuted above. **`switch` over `CreditNoteStatus`:** the
only one in the tree is mobile's `creditNotePillFor`; web uses `status === "…"` comparisons and covers
all three values (`[id]/page.tsx:346` ISSUED, `:369` APPLIED||VOID, `:568` ISSUED).

### 2 · L-072 — CONFIRMED SATISFIED

- Web `apps/web/lib/api/credit-notes.ts:3` `import type { CreditNoteStatus } from "@routeflow/types";`
  and `:7` `export type { CreditNoteStatus } from "@routeflow/types";` (was the hand-typed
  `"DRAFT" | "ISSUED" | "APPLIED" | "VOID"`).
- Mobile `apps/mobile/lib/api/credit-notes.ts:2` `import type { CreditNoteStatus } from "@routeflow/types";`
  and `:10` `export type { CreditNoteStatus };`.
- `packages/types/api/enums.ts:60-61` —
  `export const CREDIT_NOTE_STATUS_VALUES = ["ISSUED", "APPLIED", "VOID"] as const;` /
  `export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUS_VALUES)[number];` — **exactly** the Prisma
  enum at `apps/api/prisma/schema/finance.prisma:56-60` (ISSUED, APPLIED, VOID). Re-exported from the
  package root at `packages/types/index.ts:144`; both apps declare `"@routeflow/types": "*"`
  (`apps/web/package.json:31`, `apps/mobile/package.json:28`).
- `git grep -n -E '"ISSUED" \| "APPLIED"' HEAD -- apps` → **empty**. No hand-typed credit-note status
  union remains anywhere under `apps/`.
- The mobile jest manual mock `apps/mobile/__tests__/__mocks__/@routeflow/types.js` is not a hazard:
  both new imports are type-only and erased before runtime, so the mock is never consulted for
  `CreditNoteStatus`.

### 3 · B19 render sites — CONFIRMED SATISFIED; mobile is out of scope and NOT a gap

- `apps/web/app/(dashboard)/credit-notes/page.tsx:852` (list row) — `{cn.invoice?.invoiceNumber ?? cn.invoiceId}`.
  This cell is a `<span>`, not a link, on base and on HEAD (row navigation is
  `router.push('/credit-notes/' + cn.id)` at `:826`), so there is no href to preserve here.
- `[id]/page.tsx:431` and `:561` — both `{cn.invoice?.invoiceNumber ?? cn.invoiceId}` with
  `href={`/invoices/${cn.invoiceId}`}` unchanged at `:427` and `:558`. **The id is kept in both hrefs.**
- Type match: web `CreditNote.invoice?: { id: string; invoiceNumber: string }`
  (`lib/api/credit-notes.ts:16`) is exactly the API's select in **both** readers — `findAll`
  `credit-notes.service.ts:310-313` (new) and `findOne` `:350-353` (pre-existing).
  `findAllForUser` (`:323-345`) and `findOneForUser` (`:359-371`) both delegate, so the routes the web
  app actually calls (`GET /credit-notes` → `findAllForUser`, `GET /:id` → `findOneForUser`) each carry
  the field. No half-wired reader.
- Mobile: `apps/mobile/lib/api/credit-notes.ts:12-28` has no `invoice` field — **correct, and not a
  gap.** `git grep -n invoiceId HEAD -- "apps/mobile/app/(operator)/credit-notes"` shows mobile never
  renders the id as text; the only user-visible use is `[id].tsx:132`
  `{cn.invoiceId ? " · Applies to invoice" : " · Applies to next invoice (auto)"}`. B19 does not
  manifest on mobile, and `build-plan.md` P6 correctly scopes mobile to R7/R8 only. Nothing to record
  as an owed gap.

### 4 · R12 — CONFIRMED SATISFIED (the non-empty grep is a false positive)

`useApplyAdvancePayment` is gone from `apps/web/lib/api/customers.ts` (diff removes `:282-297`); it had
**zero** callers on base (`git grep -n useApplyAdvancePayment d12203a3 -- apps/web` → only the
definition). `git grep -n useApplyAdvancePayment HEAD -- apps` is **not** empty, but the three
surviving hits are mobile's own, independently-defined and actively-used hook:
`apps/mobile/lib/api/customers.ts:174` (definition) called from
`apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx:38,1100`. The ruling names
`apps/web/lib/api/customers.ts:282-297` specifically; deleting mobile's would break a live screen.
`useApplyAdvanceToInvoice` — `apps/web/lib/api/invoices.ts` is **unchanged in this diff** (absent from
`git diff --name-only`), the hook is at `:465`, and `git grep -n useApplyAdvanceToInvoice HEAD -- apps`
returns only that definition ⇒ still zero callers. **No new "Apply advance" UI exists** (R11 correctly
not implemented).

### 5 · e2e spec 28 — TWO CONFIRMED ISSUES (B1 blocker, B2 major); the config half is clean

- **Route patterns do match.** `useCreditNotes` calls `apiClient.get("/credit-notes", { params })`
  (`lib/api/credit-notes.ts:62`), so the URL is `<API_ORIGIN>/api/v1/credit-notes?page=1&limit=20&…`;
  the unanchored `/\/api\/v1\/credit-notes(\?.*)?$/` matches it, and both the paged and the KPI-"all"
  query are served the same fixture. `useCreditNote` (`:70`) hits `/credit-notes/<id>`, matched by
  `new RegExp("/api/v1/credit-notes/e2e-cn-28-0001(\\?.*)?$")`. The cross-origin preflight is handled
  (`fulfillJson` `:40-42`), and `CORS_HEADERS`' `access-control-allow-headers` covers every header the
  client actually adds — `Authorization` and `X-Tenant-Slug` only (`apps/web/lib/api-client.ts:116,118`).
  The detail page's unconditional `useInvoices` is mocked (`:76-82`), matching the code comment.
- **Detail-page heading locator is NOT unique** → B1. **List heading likewise** → B1.
- **The count-0 assertion IS vacuous** → B2: the ISSUED fixture means it passes on the pre-fix build.
  T13's paired `getByText(INVOICE_UUID)).toHaveCount(0)` (`:107`), by contrast, is a genuine oracle —
  base renders `{cn.invoiceId}` (the UUID) at all three sites, so T13 would go red on the bug.
  Both tests do assert a load-proof heading first, as the plan requires; the heading assertions are
  just mis-scoped.
- **Tokens: exactly once each in the test titles.** `REG-B19` in the `:85` title, `REG-B18` in the
  `:110` title; the other occurrences (`:2,4,11,28`) are the file header comment, and
  `playwright.config.ts:499` mentions the affordance in a comment. No token appears in two titles.
- **`playwright.config.ts` project entry: additive and consistent.** The diff appends only a
  `credit-note-wallet` project (`:502-509`): `testMatch: /28-credit-note-wallet\.spec\.ts/`,
  `dependencies: ["setup"]`,
  `use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") }` —
  identical in substance to specs 27 and 30 (`:414-417`, `:433-436`) and formatted like 09/11/34.
- **No double execution.** All 32 projects declare an explicit single-spec `testMatch` regex; none is
  a glob, and `28-credit-note-wallet.spec.ts` is the only `28-*` file in `apps/web/e2e/`. There is no
  top-level `testMatch`, so `testDir: "./e2e"` never fans a spec into an unrelated project. CI runs
  `npx playwright test` unfiltered (`.github/workflows/ci.yml:712`), so the project will run
  post-deploy.
- **Close-out note.** The pre-PR local lane's project allow-list (`package.json:35`, `local:e2e`) does
  **not** include `credit-note-wallet` — expected, since `build-plan.md` only asks for `--list` there,
  but it means B1 would not have surfaced locally. Worth running the project once against the local
  stack after the locator fix.

### 6 · Mobile logic + test — CONFIRMED SOUND (B6 is a note, not a defect)

Resulting map, `apps/mobile/lib/credit-notes-logic.ts:21-31`:
`ISSUED → { variant: "brand", label: "Issued" }` · `APPLIED → { variant: "green", label: "Applied" }` ·
`VOID → { variant: "red", label: "Void" }` · `default → { variant: "gray", label: status }`.
No `assertNever`; the default is unreachable under the 3-value union (`status: never` there) and acts
as a runtime fallback — see B6. `creditNoteActionFlags` (`:47-52`) is now
`{ canApply: status === "ISSUED", canVoid: status === "ISSUED" }`, and the `CreditNoteActionFlags`
interface (`:33-36`) dropped `canIssue`, so any stale caller is a compile error — the screen was
updated accordingly (`[id].tsx:160` `flags.canApply || flags.canVoid`).
`__tests__/credit-notes-helpers.test.ts` keeps four meaningful blocks — the 3-row pill table (`:17-21`),
`ISSUED → apply + void` (`:28-33`), the `it.each(["APPLIED","VOID"])` terminal case (`:36-41`), and the
`isCreditOpenForApply` battery (`:75-79`); only the DRAFT rows were removed, nothing was gutted. It
imports the type — `import type { CreditNoteStatus } from "../lib/api/credit-notes";` (`:15`) — which
re-exports `@routeflow/types`, so its string-literal arrays cast `as CreditNoteStatus[]` are now checked
against the shared union: re-adding `"DRAFT"` to any of them is a compile error. **No hand-typed status
strings escape the union.**

### 7 · Operability — one copy issue (B4); counts and invalidations are clean

- **Copy still promising issuing/drafting:** only `[id]/page.tsx:63` → B4.
- **Counts:** `kpiCounts` (`page.tsx:559-567`) dropped `draft`; `total` is still `all.length`, so **no
  total is wrong or missing**. The chip `count` ladder (`:672-679`) and `showCount` (`:680`) were both
  updated in the same hunk — no chip now reads another chip's number, and the removed `Draft` chip took
  its own count with it. `stats` (`:579-616`) never referenced DRAFT.
- **TanStack Query keys:** the deleted `useIssueCreditNote` invalidated `["credit-notes"]` and
  `["credit-notes", id]` — both keys are still produced by the surviving `useCreateCreditNote` (`:106`),
  `useApplyCreditNote`, `useVoidCreditNote` and `useUpdateCreditNote`, so no cache path is orphaned. The
  deleted `useApplyAdvancePayment` invalidated `["customers", id, "advance-payments"]`,
  `["customers", id, "statement"]` and `["invoices"]` — it had zero callers on base, so nothing is lost.
  **No key in the tree references a deleted hook.**

### 8 · Scope-coverage vs `cause-ruling.md` §2

| R                                                                                              | Status                                               | Satisfied at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **R7** — every DRAFT/Issue affordance removed (web + mobile + API)                             | **SATISFIED (clients); one API-script residue → B3** | web hook `lib/api/credit-notes.ts` (deleted, was `:107-117`); `[id]/page.tsx` — `IssueConfirmModal` (was `:32-70`), `useIssueCreditNote` usage (was `:243`), `handleIssue` (was `:289-309`), header DRAFT block (was `:410-429`), sidebar DRAFT block (was `:653-666`), modal mount (was `:704-711`); list chip `page.tsx:36-39`; mobile `[id].tsx:16-19,43,157` and `lib/api/credit-notes.ts` (hook deleted); mobile `index.tsx:20-25`; `credit-notes-logic.ts:33-52`; API `credit-notes.controller.ts` (route deleted) + `credit-notes.service.ts` (`issue()` deleted). **Residue:** `qa-run.js:1295`, `e2e-verify.ts:1286`. |
| **R8** — no remaining DRAFT credit-note reference outside register/docs                        | **SATISFIED**                                        | Sweep in answer 1: every surviving `DRAFT` under `apps/web` / `apps/mobile` in the credit-note surfaces is either invoice-domain (`new.tsx:30`, `[id]/page.tsx:101-105`) or an explanatory comment.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **R9** (client side)                                                                           | **SATISFIED**                                        | Web type `apps/web/lib/api/credit-notes.ts:16`. (Server half — `credit-notes.service.ts:310-313` — outside this lens but verified present and reached by `findAllForUser`.)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **R10** — all three render sites show `invoice?.invoiceNumber ?? invoiceId`, href keeps the id | **SATISFIED**                                        | `page.tsx:852`; `[id]/page.tsx:431` (href `:427`); `[id]/page.tsx:561` (href `:558`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **R12** — duplicate `useApplyAdvancePayment` deleted, no new Apply-advance UI                  | **SATISFIED**                                        | `apps/web/lib/api/customers.ts` diff `@@ -279,25 +279,6 @@`; `apps/web/lib/api/invoices.ts` untouched, `useApplyAdvanceToInvoice:465` still zero-caller.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Anything in the client diff OUTSIDE the ruling's scope: none.** Every changed path is in
`cause-ruling.md` §4 `radiusFiles` or in `build-plan.md` P5/P6/P7
(`apps/web/e2e/28-credit-note-wallet.spec.ts` and `apps/web/playwright.config.ts` are P7). No behaviour
change slipped in: the only non-DRAFT edits are the three `invoice?.invoiceNumber ?? invoiceId` render
swaps (R10), the two type re-exports (L-072) and the two hook deletions.

**One deviation from the plan, and it is correct:** `apps/mobile/app/(operator)/credit-notes/new.tsx`
is untouched although `build-plan.md` §6 and `spec.md` R7 name it — its `DRAFT` case is the **invoice**
status pill, not a credit-note one (answer 1). Worth one line in the close-out so the plan/tree mismatch
is a recorded decision rather than an apparent omission.

## Not verified (stated, not asserted)

- I did not run `tsc`, `jest`, `eslint` or `playwright` (forbidden by the lens brief). B1 and B2 are
  derived from committed source plus the documented behaviour of Playwright strict mode and Radix
  `Dialog`, and corroborated by this suite's own precedent comment at `15-stock-count-ui.spec.ts:150-152`
  — but they are not observed failures.
- B5's lint status is unverified; I only observed that mobile expresses the same thing more compactly.
- I did not read any working-tree file under `apps/` (a probe runner is mutating that tree); every
  citation above is from `git show HEAD:` / `git diff d12203a3...HEAD` / `git grep HEAD`.
