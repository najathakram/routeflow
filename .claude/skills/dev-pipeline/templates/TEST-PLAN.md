# Test plan: <task title>

> **Stage S4 — "how we'll know".** Authored by Fable 5 on `<YYYY-MM-DD>`.
> Status: `DRAFT | APPROVED | IMPLEMENTED | CLOSED`
> **Written BEFORE the build plan and before any implementation code exists.** If you
> already know what the code looks like, you are copying it — go back to the requirement.
> This file is the ONLY context the test-authoring, red-gate, UI-verification and review
> agents receive. It must stand alone: no "the conversation", no "as discussed".
> Requirement IDs `R#` come from [spec.md](./spec.md) — or, on small work, from the build
> plan's own Preamble; either way this plan is still written, and is never absorbed into it.
> Work packages in [build-plan.md](./build-plan.md) reference the `T#` ids defined here.
> UI expectations come from [ux-spec.md](./ux-spec.md) when this change touches UI.
> Method reference: `references/TESTING-PLAYBOOK.md` in the dev-pipeline skill folder.

**Gate to pass before S5:** every `R#` maps to ≥1 `T#`; every `T#` names an `R#`; every
`T#` has an oracle; every `T#` has a stated reason it fails today.

**Ground rule — nothing named here may be invented.** Every file path, directory, shell
command and package-manifest script in this file — the spec paths in §2, the red-gate
command in §6, the fixtures and helpers in §7, the target files in §9 — is checked against
the repo by the pipeline's Baseline phase *before* any test is written. One that does not
exist comes back as a **major** finding on this artifact; a helper or symbol attributed to a
file that does not export it comes back as **minor**. The only exception is a test file this
plan will CREATE — mark it as new where you list it, or the check cannot tell a new file
from a wrong one. Read the repo (`ls`, the package manifest's `scripts`, the runner config)
instead of guessing.

---

## 1. Strategy for this change

*Two to six sentences. What kind of change is this (new surface / behavior change /
refactor / bug fix / migration), and what therefore proves it works?*

<strategy>

| Level | Used here? | Why / why not |
|---|---|---|
| unit | <yes/no> | <pure logic that can fail for the right reason at this level> |
| property | <yes/no> | <invariants; required if money, quantities, dates or permissions are touched> |
| contract | <yes/no> | <needed when one API serves several clients — the wire shape is the thing under test> |
| integration | <yes/no> | <real route/adapter/store wiring a unit test would have to mock away> |
| e2e | <yes/no> | <the one or two user journeys worth the cost> |
| manual | <yes/no> | <what genuinely cannot be automated, and who runs it> |

**Rule applied:** prefer the lowest level that can fail for the right reason.

**Deliberately NOT tested, and why** *(framework behavior, third-party code, trivial
accessors, anything whose test would restate the implementation, anything below the risk
line)*:

- <thing> — <reason>

**Risk driving depth** *(blast radius decides depth, not code volume — money wrong, data
lost, cross-boundary leak, a message sent to a real person, an irreversible migration)*:

<risk statement>

**Characterization tests needed first?** *(refactors only: capture today's behavior before
changing it, so the refactor has something to be measured against)* — <yes, list them / no>

---

## 2. Test table

*One row per test. Keep cells to a line; expand a hard case in §2.1. "Fails today
because" is mandatory — if nothing can fail, the requirement is not yet testable, so
rewrite the requirement, not the test.*

| ID | proves | level | Given / When / Then | Oracle — why the expected value is KNOWN | File | Fails today because |
|---|---|---|---|---|---|---|
| T1 | R<n> | <unit> | **G** <state> · **W** <action> · **T** <observable outcome> | <derived by hand from the spec / worked example from the requester / table of legal values / independent formula — NOT read off the implementation you are about to write> | `<exact repo-relative path>` | <symbol does not exist / route 404s / value is X instead of Y> |
| T2 | R<n> | <e2e> | **G** … · **W** … · **T** … | <…> | `<path>` | <…> |
| T3 | R<n>, R<m> | <property> | **G** … · **W** … · **T** … | <…> | `<path>` | <…> |

### 2.1 Expanded cases

*Only for tests whose setup or oracle does not fit a row.*

**T<n> — <name>**
- **Given:** <precise fixture state>
- **When:** <the single action>
- **Then:** <the observable assertion, with the exact expected value>
- **Oracle:** <where that expected value comes from, in words a reviewer can re-derive>
- **Fails today because:** <…>

---

## 3. Coverage matrix

*Cross-check in both directions. The `spec-compliance` review lens walks this table and
calls out dishonesty — a requirement silently untested, or a test claiming a requirement
it does not exercise.*

| R# | Requirement (short) | Priority | Covered by | Deepest level of cover |
|---|---|---|---|---|
| R1 | <…> | <must/should> | T1, T4 | integration |
| R2 | <…> | <…> | T2 | unit |

**Reverse check — every T# names an R#:**

| T# | proves | Would it still pass with the feature removed? (must be "no") |
|---|---|---|
| T1 | R1 | no — <what breaks> |

**Deliberately untested requirements** *(one line each; "none" is a valid answer, silence
is not)*:

- `R<n>` — <why it is not tested, the compensating control (review lens, manual check,
  monitoring), and who accepted that>

---

## 4. Negative tests — what must NOT happen

*Every feature has a shadow. State the thing that must be refused, ignored, or left
untouched, and the test that proves it.*

| ID | Must NOT happen | Level | Assertion | File |
|---|---|---|---|---|
| T<n> | <an unauthorized role reaches the endpoint> | <integration> | <rejected, and no row written> | `<path>` |
| T<n> | <a query crosses the tenant/owner boundary> | <integration> | <another owner's rows absent from the response> | `<path>` |
| T<n> | <invalid input is accepted> | <unit> | <validation error; original state unchanged> | `<path>` |
| T<n> | <a bulk write runs unscoped> | <integration> | <only scoped rows change; a sibling row survives untouched> | `<path>` |
| T<n> | <double submit creates two records> | <integration> | <second call is a no-op / returns the same id> | `<path>` |

---

## 5. Property-based invariants

*Required when this change touches money, quantities, dates, or permissions. Keep the
section and write "none touched" if that is the truth.*

Touched: `<money / quantities / dates / permissions / none>`

| ID | Invariant (must hold for ALL generated inputs) | Generator / input domain | File |
|---|---|---|---|
| T<n> | <total equals the sum of its parts after rounding> | <0–50 lines, amounts 0–10^6, 0–2 decimals> | `<path>` |
| T<n> | <rounding is stable: round(round(x)) == round(x)> | <…> | `<path>` |
| T<n> | <a balance or quantity never goes negative through any legal sequence> | <…> | `<path>` |
| T<n> | <permissions never widen: resulting rights ⊆ granted rights> | <…> | `<path>` |

**Library:** *(check what the repo already uses before adding anything; `fast-check` is the
standard choice for JS/TS)* — `<library already present / fast-check / none — hand-rolled table of cases>`

---

## 6. Red gate

*The proof these tests are meaningful. Every test above must fail on an **assertion** — not
on a syntax, import, type, or config error — and none may pass.*

```bash
# Runs ONLY the tests added by this plan — scoped by path or name pattern, never the whole suite.
<exact command>
```

| T# | Expected failure message (approximate) | Failure kind |
|---|---|---|
| T1 | `<expected 42, received undefined>` | assertion |
| T2 | `<expected element to be visible>` | assertion |

Rules for the gate:

- A failure that is not an assertion means the test is broken, not the feature missing.
  Fix the test — one remediation round — then re-run.
- A test for a symbol or module this change CREATES would fail on an import error, which
  this gate rejects. Guard the import (dynamic import in try/catch, first assertion =
  "export exists") or stub the symbol — the TESTING-PLAYBOOK's wiring-error rule — so its
  absence surfaces as an assertion.
- A test that passes before implementation is vacuous. Delete or strengthen it; never
  carry it forward.
- Record the actual red output before implementation starts. It is the only thing that
  makes the eventual green mean something.
- A stub makes the failure an *assertion*; it does not make it *behavioral*. Every row in the
  table above must name the test's own expected value — a whole gate of identical
  `received undefined` proves the wiring and nothing about the oracles.

---

## 7. Test data and fixtures

| Need | How the test creates it | Scope / isolation | Cleanup |
|---|---|---|---|
| <a user with role X> | <factory / seed helper / API call — name the exact one in this repo> | <disposable account, throwaway workspace, unique suffix per run> | <torn down / transaction rollback / disposable namespace> |
| <a record in state Y> | <…> | <…> | <…> |

- Never assert against data anyone or anything else can change.
- Never reuse a shared long-lived record as a fixture; a parallel run will race it.
- Auth/session state: `<the one shared login or storage-state fixture — name it>`. A long
  suite can outlive its own session; refresh it, do not assume it.
- Any step that writes to a real environment targets only the repo's approved test
  accounts — read the repo's own data policy before writing this row.

---

## 8. UI flows to drive (Playwright)

*Plain language, in the order a user performs them, each with the assertion that decides
pass/fail. For UI work, start from the flows already drafted in
[ux-spec.md](./ux-spec.md)'s verification-flows section and add the assertion and viewport
for each — this table is the canonical list, not that one. These lines are copied verbatim
into `uiVerify.flows` in
[build-plan.md](./build-plan.md). If the repo has no Playwright, the same flows are driven
with the browser MCP tools (`mcp__Claude_Browser__*`) — the flows do not change, only the
driver.*

| # | Flow (plain language) | Assertion | Viewport |
|---|---|---|---|
| 1 | <sign in, open X, do Y> | <the new value is visible on the row; a confirmation names the record> | desktop |
| 2 | <submit the form with a required field missing> | <inline error names the field; nothing was saved> | desktop |
| 3 | <the same flow on a narrow screen> | <no horizontal scroll; the primary action stays reachable> | mobile |

- **Page URL:** `<url>` · **Start command (if any):** `<command — whatever the agent starts, it must also stop>`
- **Checks alongside:** `console-errors`, `network-failures`, `a11y`, `design-system`
  *(drop any that do not apply; keep `design-system` whenever a UX spec or derived design
  system exists)*
- Locate by role/label; add a stable test id only where semantics genuinely cannot address
  the element. Assert with auto-retrying web-first assertions — never a fixed wait, never a
  visibility check followed by an action on the same element.
- The visual result is verified by screenshot, not asserted from the source.

---

## 9. Mutation probe targets

*The oracle for test quality: break the code on purpose and prove a test screams. One
target per meaningful behavior; run sequentially; back up the file and restore it
afterwards — never `git checkout`. `Stryker` is the real tool for JS/TS if the repo wants
full mutation testing; this is the pipeline's lightweight substitute.*

*Only the **Behavior to protect** column is handed to the probe agent (it becomes
`behavior` in the build plan's `mutationProbe.targets[]`). The **Defect to inject** column
is planning prose — evidence that the behavior is breakable; the probe agent chooses and
injects its own defect at run time.*

| # | File | Behavior to protect (→ `behavior`) | Defect to inject (a real behavior change, not a syntax break) | Test that MUST go red |
|---|---|---|---|---|
| 1 | `<path>` | <the boundary rule this file must keep> | <invert a boundary: `>=` → `>`> | T<n> |
| 2 | `<path>` | <every read is scoped to the owner/tenant> | <drop the scoping clause from the query> | T<n> |
| 3 | `<path>` | <every monetary write is rounded to cents> | <remove the rounding step> | T<n> |
| 4 | `<path>` | <only an authorized caller reaches the resource> | <return the unchecked path instead of the authorized one> | T<n> |

If the named test still passes with the defect in place, that test is decoration.
Strengthen it before the change ships.

---

## 10. Flake risks

| Risk | Where | How it is removed (removed, not retried) |
|---|---|---|
| <time-based waiting> | <spec/file> | <auto-retrying assertion on the observable end state> |
| <shared or mutable fixture data> | <…> | <per-run unique record, torn down> |
| <ordering dependence between tests> | <…> | <each test builds its own state; no carry-over> |
| <clock / timezone / date boundary> | <…> | <inject a fixed clock; assert in a stated timezone> |
| <network or third-party call> | <…> | <stub at the boundary; the live call is a separate, tagged test> |
| <animation or transition timing> | <…> | <assert the settled state, never mid-transition> |

---

## 11. Regression watch

- **Runs on every push:** <which of these tests> — <why they are cheap enough>
- **Runs nightly or on demand:** <which> — <why they are off the push path>
- **How this regresses unnoticed in six months, and the check that catches it:** <…>
- A green replay from a build cache is not evidence a test ran. Trust only the runner's own
  report of work actually performed.
