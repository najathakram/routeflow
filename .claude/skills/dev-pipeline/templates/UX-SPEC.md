# UX Spec: <feature/task title>

> Authored by Fable 5 (with the design skills routed via
> `references/DESIGN-ROUTING.md` in the dev-pipeline skill folder) on <YYYY-MM-DD>.
> Status: DRAFT | APPROVED | IMPLEMENTED | CLOSED
> This file is the ONLY context the implementation, review, and UI-verification agents
> receive. It must stand alone: no references to "the conversation", no "as discussed".
> Produced at **S3 — UX & design system** (UI work only — skip this file entirely for
> non-UI work). Companion cache: `.claude/pipeline/design-system.md`, derived once per
> repo per the DERIVE-BEFORE-YOU-DESIGN procedure — cite it, don't repeat it here.
> Requirements served: link every section below back to `spec.md` R# IDs. A UX decision
> with no R# behind it is scope creep — cut it or add the requirement first.

## Job to be done

- **Who** (role/persona) is using this screen, and how often.
- **What job** are they trying to get done — one sentence, in words a user would use.
- **Why now** — link to `discovery.md`'s problem statement.
- **Current workaround**, if replacing one — what breaks if this ships half-built.

## Entry points & exits

- **Entry points:** `<from screen/notification/link/deep-link>` → `<trigger — click, nav
item, email link, API redirect>`. List every way a user lands here, including error
  and unauthenticated redirects.
- **Exits:** `<to screen>` on `<action or outcome — save, cancel, delete, timeout>`. List
  every way a user leaves, including back/cancel and session-expiry.

## Screen inventory

| Screen          | Route / path | Purpose (one line) | Primary user | Requirement(s) served |
| --------------- | ------------ | ------------------ | ------------ | --------------------- |
| `<Screen name>` | `<path>`     | `<purpose>`        | `<role>`     | `<R#, R#>`            |

_<Repeat one row per screen. A screen with no requirement behind it does not belong in
this spec.>_

## Per-screen anatomy

### Screen: `<name>`

- **Regions** (top to bottom / DOM order): `<header, nav, filter bar, list/table, detail
panel, footer, modal — name every region that exists>`.
- **Visual hierarchy:** what draws the eye 1st / 2nd / 3rd — name the element, not just
  "important stuff at top".
- **Primary action:** the one action this screen exists to let the user take (button
  label + placement).
- **Secondary actions:** `<list>`.
- **Destructive actions:** `<list — every one of these needs a confirmation step; say
what the confirmation asks and what it destroys>`.

_<Repeat this block once per screen in the inventory above.>_

## State set — every surface above must ship ALL of these

| State                  | Trigger / condition                                                | What's shown                                                                               | Recovery / next action                                                  |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Default                | normal load, data present                                          | `<...>`                                                                                    | —                                                                       |
| Empty                  | zero records, first use or filtered to nothing                     | `<empty-state copy + illustration/icon if any>`                                            | `<primary action to fill it, or "adjust filters">`                      |
| Loading                | initial fetch, or refetch in flight                                | `<skeleton / spinner — name which>`                                                        | —                                                                       |
| Partial                | some data loaded, some rows/fields failed                          | `<what's degraded, what's flagged>`                                                        | `<retry affected part only, not full reload>`                           |
| Error                  | request failed (4xx/5xx/timeout/parse)                             | `<message + error code if useful>`                                                         | `<retry action; who to contact if retry won't help>`                    |
| Unauthorized           | session expired, or role lacks permission                          | `<distinguish "log back in" from "you can't do this">`                                     | `<redirect to login / show a permission message, never a blank screen>` |
| Offline                | no network                                                         | `<explicit offline indicator>`                                                             | `<queued/retry-on-reconnect, or block with explanation>`                |
| Too-much-data          | result set exceeds page/render budget                              | `<pagination, virtualization, or a narrowing prompt — name which>`                         | `<how the user narrows down>`                                           |
| Stale                  | data changed on the server since this view loaded                  | `<refresh cue, "updated X ago" marker, or auto-refresh — name which>`                      | `<how the user reloads without losing in-progress input>`               |
| Concurrent edit        | another user saved the same record while this one was being edited | `<last-write-wins, version-conflict message, or lock — say which, and what the user sees>` | `<reload / merge / overwrite — and which of their changes survive>`     |
| Success / confirmation | action completed                                                   | `<toast/inline message copy, auto-dismiss timing if any>`                                  | `<where focus goes next>`                                               |

_This table is mandatory per screen in the inventory. Do not ship a screen missing a
row — every cell must describe real, buildable behavior, not a placeholder._

## Interaction & validation

- **Field-by-field validation:** `<field: rule, e.g. "email: RFC-shape + required">` —
  inline (on blur) vs on-submit; when an error clears (on next keystroke? on valid
  input? on re-submit?).
- **On failure**, per failure class:
  - Client validation failure → `<inline message under the field, focus moves to
first invalid field, submit blocked>`.
  - Network failure → `<what the user sees, is retry automatic or manual, is the
retry idempotent (see redGate/mutation notes in the build plan for anything
money/tenant-scoped)>`.
  - Server 4xx → `<surfaced how — field-level if the API returns field errors,
otherwise a top-level message>`.
  - Server 5xx / timeout → `<generic error + retry; never leak stack traces or
internal error text>`.
- **Optimistic vs pessimistic updates:** state which per action, and what happens on
  optimistic rollback if the server rejects it.
- **Double-submit:** how the primary action is disabled/debounced while in flight.

## UI copy

| Element                          | Copy                                             | Notes                          |
| -------------------------------- | ------------------------------------------------ | ------------------------------ |
| `<field label>`                  | `<exact text>`                                   | `<...>`                        |
| `<placeholder>`                  | `<exact text>`                                   | `<...>`                        |
| `<button verb>`                  | `<exact text, e.g. "Save changes" not "Submit">` | `<...>`                        |
| `<validation error>`             | `<exact text>`                                   | `<one per rule above>`         |
| `<empty-state headline>`         | `<exact text>`                                   | `<...>`                        |
| `<empty-state body>`             | `<exact text>`                                   | `<...>`                        |
| `<success/confirmation message>` | `<exact text>`                                   | `<...>`                        |
| `<destructive-confirm prompt>`   | `<exact text>`                                   | `<states what gets destroyed>` |

_Every string a user reads must be written here verbatim — an implementer must never
invent copy. If copy needs drafting from scratch, route through `intent:articulate`
(see `references/DESIGN-ROUTING.md` in the dev-pipeline skill folder) and paste the result here._

## Responsive behavior

| Breakpoint                                                           | Layout change | What's hidden / collapsed / reflowed |
| -------------------------------------------------------------------- | ------------- | ------------------------------------ |
| Mobile (`<cite the repo's actual breakpoint from design-system.md>`) | `<...>`       | `<...>`                              |
| Tablet (`<...>`)                                                     | `<...>`       | `<...>`                              |
| Desktop (`<...>`)                                                    | `<...>`       | `<...>`                              |

_Cite the repo's real breakpoint values from `design-system.md`. Do not invent
breakpoints._

## Accessibility

- **Focus order:** list the tab sequence explicitly, region by region.
- **Labels:** every control has an accessible name (`<label>`/`aria-label`) — list any
  control whose visible label differs from its accessible name and why.
- **Contrast:** `<state the ratio requirement in force for this repo, e.g. WCAG AA —
4.5:1 normal text, 3:1 large text and UI components; cite design-system.md's a11y
baseline if it states one>`.
- **Target size:** `<minimum interactive target, per the repo's a11y baseline — do not
guess a number that isn't grounded in it>`.
- **Keyboard path:** describe how the entire primary flow is completable with keyboard
  alone — no mouse-only affordance.
- **Screen-reader announcements:** what's announced (and via what — live region,
  focus move, title change) on: loading start/end, validation error, success, and any
  content that updates without a navigation.

## Motion

| Element / transition | What animates         | Duration | Easing    | Reduced-motion behavior              |
| -------------------- | --------------------- | -------- | --------- | ------------------------------------ |
| `<e.g. modal open>`  | `<opacity/transform>` | `<ms>`   | `<curve>` | `<cut to instant / cross-fade only>` |

_Cite durations and easings from `design-system.md`. A new value needs the same
line-by-line justification as a new token — record it in the compliance table below._

## Design-system compliance

| Token / component                       | Used for              | Source file                              | New?    | Justification if new                                                                                                                |
| --------------------------------------- | --------------------- | ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `<e.g. --color-primary-600>`            | `<primary button bg>` | `<design-system.md cites the real file>` | no      | —                                                                                                                                   |
| `<e.g. <Button variant="destructive">>` | `<delete confirm>`    | `<component dir file>`                   | no      | —                                                                                                                                   |
| `<new token/component, if any>`         | `<...>`               | —                                        | **yes** | `<what was checked and found missing before proposing this; who approved a new addition to the system rather than this one screen>` |

_Every token and component this spec uses must appear in this table. A row marked
"yes" without a justification is a rejected design. See the standing rules in
`references/DESIGN-ROUTING.md` in the dev-pipeline skill folder._

## Playwright verification flows

Numbered, plain-language flows that prove each screen and each state-set row above.
These are carried into §8 of [test-plan.md](./test-plan.md) — which is what the build
plan copies into `uiVerify.flows` in the `pipeline.js` args (see the skill's execution
contract). Draft them here; §8 adds the assertion and viewport for each. Write them so an
agent can drive them without re-reading this file's prose.

1. `<Given ... When ... Then ...>` — proves R#`<n>`, exercises state: `<default>`.
2. `<...>` — proves R#`<n>`, exercises state: `<empty>`.
3. `<...>` — proves R#`<n>`, exercises state: `<error>`.
4. `<...>` — proves R#`<n>`, exercises state: `<unauthorized>`.
5. _<continue until every state-set row and every primary/destructive action has at
   least one flow; note which viewport(s) — desktop/mobile/tablet — each flow runs at>_

_Verification is visual, not textual: the UI-verify phase screenshots the rendered
page and checks it against this file — it never infers correctness by reading the
component source. See `references/TESTING-PLAYBOOK.md` in the dev-pipeline skill folder for the
Playwright house rules these flows must follow._
