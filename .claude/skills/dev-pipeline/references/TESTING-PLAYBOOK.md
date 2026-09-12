# Testing playbook — the house method

Loaded on demand by the `dev-pipeline` skill. Owns stage **S4 — Test plan** and the S7
phases `Author tests`, `Red gate`, `UI verify`, `Mutation probe`.

Companions: [`../templates/TEST-PLAN.md`](../templates/TEST-PLAN.md) (the artifact you fill
in), [`ARCHITECT-QUESTIONS.md`](ARCHITECT-QUESTIONS.md) gate **G5**, and
[`DESIGN-ROUTING.md`](DESIGN-ROUTING.md) for UI verification.

## Rule 0 — the repo outranks this file

This playbook describes a _method_, not a stack. Before proposing a single test, read what
the target repo already does and match it: runner, file layout, naming, fixture style,
assertion library, CI entry points. A test in the wrong shape is a test nobody maintains.

```bash
sed -n '/"scripts"/,/}/p' package.json      # what this repo calls "test"
ls -d e2e test tests **/__tests__ 2>/dev/null
ls *.config.* jest.config.* playwright.config.* vitest.config.* pytest.ini 2>/dev/null
grep -iA5 'test' CLAUDE.md CONTRIBUTING.md 2>/dev/null
git log --oneline -20 -- '*spec*' '*test*'  # the conventions people actually follow
```

Read the repo's _prohibitions_ too. Many repos ban a second test runner, snapshot tests, or a
particular assertion style. Introducing one is a review failure, not a contribution.

---

## 1. The loop

```
requirement → example → executable test → VERIFIED RED → implement → green → refactor
```

1. **Requirement** — a numbered `R#` from [`../templates/SPEC.md`](../templates/SPEC.md).
   Not a task; an observable behavior with a priority.
2. **Example** — a concrete Given/When/Then with real values. _Given a boxed line of 3 boxes
   at 12 units/box and $1.05/unit, When the line total is computed, Then it is $37.80._
   Vague requirements die here, which is the point: if you cannot write the example, the
   requirement is not yet a requirement — go back to S2.
3. **Executable test** — the example, mechanically. Same name, same numbers, tagged with the
   `R#` so the coverage matrix can be walked.
4. **Verified RED** — §2. The step that makes the rest of this real.
5. **Implement** — the least code that turns that test green. No speculative extras; extras
   have no test and therefore no requirement.
6. **Green** — the whole suite, not just the new test.
7. **Refactor** — with the suite as the safety net, tidy the shape. Behavior is now frozen by
   tests; only structure moves.

**Why not write the tests afterwards.** A test written after the code is written _against_
the code: it copies the implementation's own output as the expected value, mirrors its
structure, mocks whatever it happens to call, and passes on its first run — which is the only
run in which it will ever be observed doing anything. It documents what the code does, not
what the requirement demands, and it inherits every bug the code already has. The test-first
order forces the expected value to come from the spec, forces the interface to be designed
from the caller's side, and produces the one piece of evidence an after-the-fact test can
never produce: proof that this test can fail when the behavior is wrong.

---

## 2. Verified RED — the load-bearing step

> **A test that has never failed proves nothing.** It is an unexercised alarm. Nobody knows
> it is wired to anything.

Run the new tests _before_ any implementation exists, and inspect the failure — do not settle
for a non-zero exit code.

**A RED that counts** fails on the **assertion**: the test ran, reached the check, and the
observed value differed from the expected value.

```
● computes a boxed line total
  expect(received).toBe(expected)
  Expected: 37.8
  Received: 3.15          ← assertion reached. Real red.
```

**A RED that does not count** — the test never reached its assertion, so nothing about that
assertion has been proven:

| Symptom                                                       | What it actually means                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Cannot find module` / `is not defined` / `is not a function` | Wiring error. Stub the symbol so the call resolves, then re-run. |
| `SyntaxError`, transform or parse error                       | The test is broken, not the code.                                |
| Timeout with no assertion output                              | Fixture or environment failure.                                  |
| `0 tests found` / `No tests matched`                          | Nothing ran. The most common fake red.                           |
| Suite-level crash before the case                             | You measured the harness, not the behavior.                      |

**A new test that passes before the code exists is a hard stop.** There are exactly three
explanations, each with its own action:

1. **Vacuous** — it asserts nothing that can be false (`expect(result).toBeDefined()`,
   `expect(fn).not.toThrow()`, an assertion on a mock's own return value). Rewrite it.
2. **Already shipped** — the behavior exists. Good news, but then it is not a requirement of
   _this_ change: mark `R#` already-satisfied, cite the pre-existing test, drop the duplicate.
3. **Wrong target** — it exercises a different code path than the one you are about to
   change. Fix the target.

**Pipeline mechanics.** The `Red gate` phase runs `args.redGate.commands`, scoped to the new
tests — never the whole suite, since a full-suite red says nothing about _which_ test is
wired. It requires: every new test fails, each on an assertion, none pass. One
test-remediation round may fix vacuous or broken tests. Implementation does not start until
the gate is honest.

```bash
# scope the run to the new specs and read the failure text, not just the exit code
npx jest path/to/new.spec.ts --verbose
npx playwright test e2e/new-flow.spec.ts --reporter=list
```

**Sanity-check the gate itself.** A mistyped red-gate command matches zero tests and "fails"
perfectly. Confirm the runner reports the expected _number_ of failing tests.

**A stub-undefined red is the weakest honest red.** Stubbing a missing symbol makes the call
resolve, but a gate where every test fails identically with `received undefined` has proven the
wiring, not the oracles — each expected value must still be behavioral (§3), so each test fails on
_its own_ number. The pipeline allows exactly ONE remediation round: if the second attempt is still
not properly red, stop rather than weakening the tests. The `(red-gate)` blocker stands, the
mutation probe stops skipping LOW-risk targets and runs on **every** declared target (§9), and that
probe plus one hand-run probe on a sibling behaviour becomes the run's only test-quality evidence —
report it as a substitution, never as a passed red gate.

---

## 3. Anti-vacuity rules

- **Assert observable behavior**, not internals: return values, persisted state, emitted
  events, HTTP status and body, what the user sees. Not private fields, not call order, not
  "the repository method was invoked".
- **Never mock the unit under test**, nor its pure collaborators. Mock at process boundaries
  — network, clock, filesystem, payment provider. If the mock is what the assertion
  inspects, the test is a mirror.
- **One reason to fail per test.** A test that can fail four ways localizes nothing. Several
  assertions are fine when they describe one behavior.
- **The expected value needs an independent origin** — see the oracle below.
- **No conditionals in tests.** An `if` or `try` in a test means it can silently assert
  nothing.
- **No sleeps.** Wait on a condition, never a duration. A time-based wait is flake plus
  slowness plus a false green on a fast machine.
- **No `.skip`, no `.only`, no commented-out assertions.** A skipped test is a lie in the
  report.
- **Every test carries its `R#`** in the title or a tag, so the coverage matrix is walkable.
- **Test the negative.** The thing that must _not_ happen — the unauthorized caller gets 403,
  the duplicate submit creates one record, invalid input is rejected — is where bugs live.

### The oracle

The **oracle** is what makes the expected value _known_ independently of the code:

- hand-computed from the spec (money, quantities, dates — do the arithmetic yourself);
- a worked example the requester supplied;
- an invariant that must hold for all inputs (§6);
- an existing trusted implementation or a published standard;
- for a refactor, the recorded behavior of the current code (§8).

If the only way to know the expected value is to run the implementation, you have no oracle —
you have a snapshot of a bug. Say so in the test plan and fix the requirement.

---

## 4. Test levels — pick the lowest that can fail for the right reason

| Level           | Proves                                               | Cost    | Confidence          | Use when                                                           |
| --------------- | ---------------------------------------------------- | ------- | ------------------- | ------------------------------------------------------------------ |
| **Unit**        | one function or module's behavior                    | lowest  | narrow              | pure logic, branches, error paths, edge values                     |
| **Property**    | an invariant over generated inputs                   | low     | broad per invariant | money, rounding, quantities, dates, permissions                    |
| **Contract**    | the wire shape between producer and consumers        | low     | high per interface  | one API serving several clients                                    |
| **Integration** | real collaborators wired together (DB, router, auth) | medium  | high on wiring      | queries, transactions, guards, migrations, serialization           |
| **E2E**         | a user achieves the goal in the real UI              | highest | end-to-end          | the one or two flows that must never break                         |
| **Manual only** | judgment (visual taste, hardware, print)             | n/a     | n/a                 | genuinely unautomatable — record as a checklist, never as "tested" |

**Rule: prefer the lowest level that can fail for the right reason.** "Right reason" is the
constraint that stops this collapsing into "unit-test everything". A tenancy-scoping bug
cannot fail a unit test whose repository is mocked — the mock returns whatever it was told.
That belongs at integration. A rounding bug does not need a browser.

**The trade-off.** Cost rises and determinism falls as you climb: a unit test is milliseconds
and deterministic; an e2e test is seconds to minutes, needs data, an environment and a
running app, and can fail for reasons unrelated to your change. So: **many unit and property
tests, a handful of integration tests per feature, only critical-path flows at e2e.** Every
e2e test is a permanent tax on every future run — it must earn it.

**Push failures down.** If e2e is the only level that can catch a class of bug, an internal
boundary is untestable. Fix the boundary.

---

## 5. Risk-based prioritization

**Test depth follows blast radius, not code volume.** A 12-line money function outranks a
600-line settings screen.

Rank each requirement by _worst credible consequence_ × _likelihood of getting it wrong_:

| Blast radius                                                                                            | Depth demanded                                                                |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Money wrong, data destroyed, cross-tenant leak, message sent to a real customer, irreversible migration | unit + property + integration + negative/authorization tests + mutation probe |
| Auth, permissions, PII, anything a regulator asks about                                                 | unit + integration + an explicit negative test per role                       |
| Core daily workflow                                                                                     | unit + integration + one e2e happy path                                       |
| Secondary feature                                                                                       | unit + integration                                                            |
| Cosmetic or internal tooling                                                                            | unit, or a smoke check                                                        |

If the change touches money, auth, tenancy, PII, migrations, or anything irreversible,
escalate the pipeline `scale` to `major` and add property tests. See G4 in
[`ARCHITECT-QUESTIONS.md`](ARCHITECT-QUESTIONS.md).

---

## 6. Property-based testing — for invariants

Example-based tests check the cases you thought of. Property tests check the ones you did
not, by generating inputs and asserting a rule that must hold for **all** of them.

Reach for it when a rule is universal:

- money is never negative where the domain forbids it;
- rounding is stable and idempotent — `round(round(x)) === round(x)`;
- a total equals the sum of its parts, to the cent, for any set of parts;
- splitting then recombining a quantity conserves it (no unit lost to rollover);
- a permission check never _widens_ — no input makes a lesser role see more;
- encode/decode and serialize/parse round-trip to the original;
- ordering is total and stable regardless of input order.

**Library: `fast-check` for JS/TS. Check what the repo already uses first.** If a property
library is present, use it. If none is and the repo bans new dependencies, express the same
invariant as a table-driven loop over a wide hand-built matrix including the boundaries: 0,
1, negative, max, null/undefined, empty, duplicate, very large, unicode.

When a property test fails, keep the **shrunk counter-example** the runner prints and add it
as a permanent example-based regression test. That is the bug, minimized, for free.

---

## 7. Contract testing — one API, several clients

When a single API serves multiple consumers (a web app and a mobile app, an internal service
and a partner), the wire shape _is_ the contract, and it breaks silently:

- **One source of truth for the shape** — a shared DTO/type package, or a schema the server
  validates against and the clients import. Two hand-maintained copies of a response type
  will diverge.
- **Assert the shape, not only the values**: required fields present, types correct, nothing
  silently renamed or dropped. Validate a real response against the schema.
- **Test each consumer against that same schema**, so a producer change fails a test rather
  than a user's screen.
- **Additive changes only, or version.** Test back-compat explicitly: an older client's
  request still works; an unknown field does not crash the parser.
- **Error shapes are part of the contract** — status codes, error bodies, validation
  messages need tests too.

If the repo already generates clients or types from a schema, extend that mechanism instead
of writing a parallel set of assertions.

---

## 8. Golden / characterization tests — before a refactor

A refactor that changes behavior is not a refactor; it is an undocumented feature change.
Before restructuring code that lacks tests:

1. **Capture today's behavior** across a representative input set, including the ugly cases
   the code clearly handles on purpose. Record the outputs.
2. **Pin them** as assertions. These are _characterization_ tests: they assert what the code
   does, not what it should do. Say so in a comment — they are not requirements.
3. **Refactor** until green.
4. **Then** fix any behavior the characterization tests exposed as wrong — as a separate
   change, with its own requirement and its own red gate.

Caveats: a golden file nobody reads is a snapshot habit. Keep them small and readable; never
blanket-update them to make a run pass — a changed golden is reviewed line by line. If the
repo bans snapshot tests, express the same coverage as explicit assertions on the specific
fields that matter.

---

## 9. Mutation testing — the oracle for test quality

Coverage says a line was _executed_. It does not say a failure would have been _caught_.
Mutation testing answers the real question: **if I break the code, does a test go red?**

**The real tool for JS/TS is `Stryker`** (`@stryker-mutator/core`). It mutates the source —
flips a conditional, changes an operator, removes a call — and reports which mutants the
suite killed. Run it periodically on high-risk modules (money, auth, tenancy), scoped to
those paths; it is slow, so it does not belong on every push. A surviving mutant in critical
code is a bug in the test suite.

**The pipeline's lightweight substitute — the mutation probe.** Full mutation runs are too
slow for a change-sized loop, so `args.mutationProbe.targets` runs one deliberate defect per
target, **sequentially**:

1. **Back up OUTSIDE the repo, by file copy.** Copy the file into the **OS temp directory**
   (Git Bash: `"$TMPDIR"` when set, else `/tmp`; a Windows shell: `%TEMP%`) under a unique
   name — `mutprobe-<package-or-target>-<basename>`. Record a checksum of the original in the
   same breath, and report the backup's absolute path.
   ```bash
   cp src/pricing.ts "$TMPDIR/mutprobe-api-pricing.ts"    # Windows shell: %TEMP%
   sha256sum src/pricing.ts        # Windows: certutil -hashfile src/pricing.ts SHA256
   ```
   Two prohibitions, both load-bearing. **Never via git** — `git stash`, `checkout`, `restore`
   and `reset` operate on the whole working tree and would destroy the uncommitted
   implementation this very run just produced. **Never beside the file, or anywhere else
   inside the repo** — a leftover backup in the tree becomes a shipped file. The name matters
   too: `mutprobe-*` in the temp directory is exactly what the recovery path hunts for when a
   probe dies mid-run, so a backup under any other name is invisible to it.
   All probe SCRATCH obeys the same rule — a throwaway jest/runner config, a hand-probe spec, a
   one-off harness: write it in the OS temp dir or a gitignored scratch path, never as an
   untracked file inside the repo. Untracked scratch outlives the probe, and the next
   `git add -A` ships it.
2. **Inject one small, plausible defect** into the named `behavior` — the kind of mistake a
   human makes: flip `<=` to `<`, drop a rounding call, remove the tenant filter, return the
   unprorated value. Not `throw new Error('x')` — anything at all catches a crash. Not a
   syntax or type error either: the code must still build, or the test goes red for the wrong
   reason and proves nothing.
3. **First confirm the target test is GREEN on the unmutated file**, then inject and re-run. **A
   probe proves nothing unless the mutated run fails DIFFERENTLY from the unmutated one.** A test
   already failing for any reason — a harness gap, an undefined mock, a missing fixture — fails
   identically with and without the mutation, its real assertions never evaluate, and "caught" becomes
   indistinguishable from "blind". Compare the failure _message_, not just the exit code. Measured:
   a probe reported `allCaught: false` because the mocked client lacked a model the code touched, so
   both runs died on the same `TypeError` before reaching the behavioural assertion — the tests were
   never weak, the harness was. **Run it again after any change to the shared mocks or fixtures.**
   Then: **it must go RED**, on an assertion about behavior.
   ```bash
   npx jest src/pricing.spec.ts -t "computes a boxed line total"
   ```
   - **RED on an assertion** → the test is wired to that behavior. Proven.
   - **GREEN, skipped, or a collection/compile error** → not caught. A green test does not
     check this behavior at all; that is a finding — the test is decorative. Fix the test,
     then re-probe.
     ⚠️ Each probe is a **scoped** run, so where the repo wires a reporter to a gate artifact
     (§10) the probes leave that artifact holding only the probe's own tests. Finish the run
     with the FULL suite before reading any gate that consumes it — a gate read straight after
     a probe reports a red the probes themselves manufactured. **Then confirm the artifact was
     actually rewritten** (check its mtime): a cached task replay prints a green summary without
     executing the runner, so the reporter never fires and the stale file survives (§10).
4. **Restore by copying the temp backup back over the file.** Never `mv`, which destroys the
   backup before you have proven the restore, leaving no recovery source in exactly the case
   that needs one. Never any git command, for the reason in step 1.
5. **Verify the restore, then delete the backup.** Re-run the same test (it must be GREEN
   again), then prove the file is byte-identical: recompute the checksum and `cmp -s` the
   retained backup against the file. Delete the backup **only after** that compare passes.
   ```bash
   cp "$TMPDIR/mutprobe-api-pricing.ts" src/pricing.ts
   npx jest src/pricing.spec.ts -t "computes a boxed line total"
   sha256sum src/pricing.ts                       # must equal the step-1 checksum
   cmp -s "$TMPDIR/mutprobe-api-pricing.ts" src/pricing.ts \
     && rm "$TMPDIR/mutprobe-api-pricing.ts" \
     || echo "RESTORE FAILED — keep the backup, stop the line"
   ```
   Do **not** verify with `git diff`: it compares against HEAD, and the probe runs on a tree
   that already carries this run's uncommitted implementation, so a perfect restore still
   prints a diff. The checksum and the byte-compare are the only honest checks.
6. **Have a different agent check the restore — before and after.** Self-reported restoration
   is not verification: the probe is the one party that could have broken the file, so its own
   `restored: true` can never clear it. Two read-only agents bracket the probes — one records
   a digest for every target **before** any probe runs, one recomputes the same digests
   **after** every probe has finished — and the orchestrating script, not an agent, compares
   the two sets:
   - digests equal → restored;
   - digests differ → a blocker naming the file, the before → after digests, and the backup to
     restore from;
   - a digest missing or unreadable on either side, or a dead checksum agent → **UNVERIFIED,
     which is not restored.** Two unreadable files never count as matching each other, and an
     absent record never reads as success — a deliberately injected defect may still be in the
     tree.

   A probe reporting `restored: true` next to a digest mismatch is precisely the case this
   bracket exists to catch.

7. **Never run probes in parallel** with each other or with anything that reads the file —
   each probe leaves a deliberately broken file on disk for the length of its test run — and
   never leave a backup behind, with one exception: when the compare in step 5 fails, **leave
   the backup in place** so the file can still be recovered, report its absolute path, and
   report the failure.

A probe that cannot be restored cleanly is a stop-the-line event: report it loudly instead of
continuing.

**When the probe is spent.** The red gate already proves each _new_ test can fail for the
right reason; the probe proves the suite catches a _regression_. That evidence overlaps, so
the probe is spent only where it is not redundant: on HIGH-risk files (money, auth, tenancy,
migrations, PII, payments), and on every target when the red gate did not run. Each skip is
logged and recorded per target. **A skipped probe is not a passed probe** — a run where every
target was skipped carries no mutation evidence at all, and must never be reported as though
it did.

---

## 10. Playwright house rules

The owner's named tool for UI verification and UI fixing. If the repo has Playwright, follow
its existing conventions; if it does not, use the fallback at the end of this section.

**Locators.** Semantic first — `getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`.
They assert accessibility as a side effect and survive restyling. CSS and XPath selectors
couple the test to markup. Add a stable test id **only** where semantics genuinely cannot
address the element (a canvas, a chart node, an unlabeled container).

```ts
await page.getByRole("button", { name: "Save" }).click();
await expect(page.getByRole("alert")).toHaveText(/saved/i);
```

**Web-first assertions.** `await expect(locator).toBeVisible()` auto-retries until timeout.
That retry is the entire anti-flake mechanism.

- **Never `waitForTimeout`.** A sleep is a guess that is simultaneously too long and too
  short.
- **Never check-then-act on the same element:**
  ```ts
  if (await row.isVisible()) await row.click(); // ✗ the row can move in between
  await expect(row).toBeVisible();
  await row.click(); // ✓ assertion first, act after
  ```
  Assert the _stable end state_ — a row count, a total, a status chip — before interacting
  with a list that just changed. Acting on a freshly added row before the list settles is a
  classic intermittent failure.
- Assert values that prove the behavior (a total, a status, the row still there after
  reload), not merely that a control exists.

**Auth.** One login fixture producing a reused `storageState`; do not log in per spec. Keep
that state fresh — a long suite can outlive its own session, and every spec after expiry
fails on the login page, which looks like a mass product failure and is not. Detect the
login/re-auth surface and re-authenticate rather than assuming.

**Artifacts — how a UI bug gets diagnosed without a human watching:**

```ts
use: { trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure' }
```

```bash
npx playwright show-trace test-results/<run>/trace.zip
```

**Deterministic data.** Create what the test needs, scope it to a disposable
tenant/user/account, clean it up afterwards. Never assert against data another person or job
can change — a test that depends on "whatever is in the environment" fails for reasons that
have nothing to do with the change. Respect the repo's rules about which environments and
accounts may be written to.

**A new spec ships with its wiring, and survives its own fixtures.** The runner-config entry that
runs a new spec (a Playwright `projects[]` entry, a test-match glob) lands in the SAME change as
the spec file — a spec no config runs is green by omission. Name fixtures so they never
substring-collide with an accessible name the spec asserts on, and never index into a list
(`.first()`, `.nth()`) that fixtures can enter — a parallel run reorders it.

**Isolation.** Each spec independent and order-free, no shared mutable state. Parallel-safe by
construction, or explicitly serialized with a stated reason.

**A gate-consumed run artifact is SINGLE-WRITER.** When the runner config wires a reporter to a
fixed artifact path that something else reads as proof (a JSON or JUnit report feeding a CI or
campaign gate), never run that suite — or any subset of it — from a side agent or a second
session: the reporter overwrites the rows the gate is about to read, and the damage lands on
someone else's run. Even `--list` executes reporters, so enumerate with `--list --reporter=list`.

**A reporter-written artifact is only as fresh as the last run that actually EXECUTED.** Under a
build cache, a "full suite" invocation can replay cached logs, print a green summary, and never
start the runner — so the reporter never fires and a stale artifact survives the very command you
ran to refresh it. This bites hardest when the thing that changed is not an input to the cached
task's hash: pulling another work-stream's gate rows in via a rebase can never invalidate a test
cache keyed on source files. So when a gate reds on rows you did not touch, **check the artifact's
mtime before debugging anything else** — if it predates your rebase, force execution (`--force`, or
invoke the runner directly) rather than reading the failure as real.

**Modes.** Headless in CI; headed, debug and UI modes when a human is diagnosing.

```bash
npx playwright test                     # CI default
npx playwright test --headed --debug    # step through
npx playwright test --ui                # watch and inspect
npx playwright codegen <url>            # record locators, then rewrite them semantically
```

**Playwright as an implementation aid, not only a gate.** When building or fixing UI, drive
the real page and iterate against evidence instead of guessing:

- navigate the actual flow and screenshot each state, including empty, loading and error;
- read the browser console for errors the source does not reveal;
- read network requests for the failing call, its status and its payload;
- resize to each viewport in `uiVerify.viewports` and re-screenshot;
- change code, re-run the same script, compare. A tight loop with a real oracle.

That evidence loop is what the S7 `UI verify` phase automates: exercise `uiVerify.flows` at
each viewport and run the `checks` — console errors, network failures, a11y, design-system
conformance per [`DESIGN-ROUTING.md`](DESIGN-ROUTING.md). **Verify a visual result with a
screenshot of the running app, never by reading the source.**

**Fallback: the repo has no Playwright.** Do not install a test framework merely to look at a
page. Use the browser MCP tools (`mcp__Claude_Browser__*` — confirm the exact server prefix in
the available tool list; it varies by install):

| Need                                      | Tool                    |
| ----------------------------------------- | ----------------------- |
| Open the page, or go back                 | `navigate`              |
| Structure, roles, labels, element refs    | `read_page`             |
| Click, type, scroll, screenshot, zoom     | `computer`              |
| JS errors and warnings                    | `read_console_messages` |
| Failing requests, status codes, bodies    | `read_network_requests` |
| Mobile / tablet / desktop, light and dark | `resize_window`         |

Same discipline: assert an observable end state, record what you saw, reset any emulated
viewport when done. If the repo _should_ have UI regression tests, say so in the close-out
report — an MCP session is verification, not a suite.

---

## 11. CI expectations

**Every push — fast and deterministic:** typecheck, lint, unit, property, contract,
integration, plus the e2e critical path. If that is too slow to run per push, the problem is
the suite's shape, not the policy.

**Nightly or scheduled:** the full e2e matrix, cross-browser and cross-viewport, long-running
data and migration checks, mutation runs on high-risk modules, dependency audits.

### The baseline gate — prove the command before you read its failure

> **A verification command must be proven to pass on the UNMODIFIED tree before its failure
> can be read as a defect.** A command that fails on a clean tree is a _broken command_, not
> a finding about the change.

Run the whole verify set against the tree exactly as you find it, _before_ anything is
written, and record which commands already fail. Skipping this produces the most confident
kind of false blocker: a gate reports a failure, a reviewer reads it as a defect, and a fixer
edits working code until a wrong command goes green.

**Worked example.** `node --check` on a Workflow-tool script reports `Illegal return
statement`. The script body legitimately ends in a top-level `return` — the runtime wraps
that body in an async function, so the construct is legal where it actually runs and illegal
only when the file is handed to `node` as a standalone module. The identical failure occurs
on the untouched file, which is the tell: the _check_ is wrong, not the script. The correct
check wraps the body first (`export const meta` reduced to `const meta`, the whole file
wrapped in `(async () => { ... })()`), then runs `node --check` on the wrapper.

Rules that follow:

- **Fix a baseline-broken command in the plan, never in the code.** Do not invent a
  replacement command, and do not "adjust" one until it passes — that quietly deletes
  whatever it was supposed to check.
- **Keep running it every round anyway.** A change in a broken command's behavior is
  information; silence is not.
- **No baseline evidence means no exclusions.** If the baseline run never happened, or died,
  every later failure counts against the change. That is the conservative direction and the
  right one.
- **The baseline is the tree as you found it** — uncommitted work included. Say so when
  reporting, so nobody reads "baseline" as "master".

**Pipeline mechanics.** The `Baseline` phase runs the union of `verifyCommands.perRound` and
`verifyCommands.final` against the untouched tree, before any agent has written anything.
Every command that fails there is recorded in `baseline.badCommands` and produces exactly one
`major` finding keyed `(gate-command)` — whose fixer is explicitly forbidden from changing
product code, tests or config to make it pass, and whose correct outcome is often "skipped:
broken verification command — must be corrected in the build plan". Later failures of those
same commands no longer become `(gate)` blockers demanding a code fix.

**A cached green is not evidence that a test ran.** Cache-aware task runners hash their inputs
and, on a hit, **replay the previous run's log verbatim** — including its cheerful "all tests
passed" summary. A printed test summary therefore proves nothing about _this_ run.

- Trust only the runner's own report of **work actually done**: cache hit/miss counters,
  executed-task counts, job duration. A test job that "passed" in two seconds executed
  nothing.
- When it matters, invoke the test runner **directly against the spec paths**, bypassing the
  caching layer, and read its output.
- The inverse trap: a red caused by host saturation or a killed worker prints an exit code
  with **no test report at all**. That is not a failing test; that is no test. Re-run before
  debugging.
- Prefer a clean CI runner over a forced local re-run on a loaded machine.
- A job whose step count is zero did not run — never read a conclusion without confirming
  steps executed.

**Gate discipline:** required checks block merge; a flaky test is fixed or deleted, never
retried into green; a quarantined test has an owner and a date.

---

## 12. What NOT to test

- **The framework** — that the router routes, the ORM saves, the validation decorator
  validates. Test _your configuration_ of it only where a mistake is plausible and costly.
- **Third-party code.** Test your adapter and your error handling at the boundary, not the
  library's internals.
- **Getters, setters, constants, pure pass-throughs, generated code.** No behavior, no test.
- **Any assertion that restates the implementation.** If the test must change every time the
  code changes shape, that is coupling, not coverage.
- **Private functions directly.** Test them through the public surface; if that is
  impossible, the boundary is wrong.
- **Mocks asserting on themselves** — `expect(mockFn).toHaveBeenCalled()` as the _only_
  assertion proves you called your own stub.
- **Coverage percentage as a goal.** It is a smoke detector, not a score: 100% coverage of
  vacuous assertions kills zero mutants.

---

## 13. Decision table — mandatory levels by kind of change

Mandatory means the test plan contains it, or states in writing why it does not.

| Change                     | Unit                                  | Property               | Contract        | Integration                          | E2E                     | Extra gate                                                                                               |
| -------------------------- | ------------------------------------- | ---------------------- | --------------- | ------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **Pure logic / algorithm** | ✅                                    | if an invariant exists | —               | —                                    | —                       | boundary and error inputs                                                                                |
| **Money math**             | ✅                                    | ✅                     | —               | ✅ on persisted values               | —                       | hand-computed oracle; mutation probe; rounding at every write                                            |
| **API endpoint**           | ✅ handler logic                      | —                      | ✅ if >1 client | ✅                                   | only on a critical path | authorization + scoping negative tests; error shapes                                                     |
| **DB migration**           | —                                     | —                      | —               | ✅ up, and down if reversible        | —                       | run against realistic existing data; back-compat for the currently deployed code; no unscoped bulk write |
| **UI screen**              | ✅ view logic/formatters              | —                      | —               | ✅ data fetch/mutation               | ✅ primary flow         | every state (empty/loading/error/unauthorized); a11y; each viewport; screenshot evidence                 |
| **Refactor**               | existing suite stays green, unchanged | —                      | —               | —                                    | —                       | characterization tests **first** (§8); zero behavior change; the diff edits no assertions                |
| **Bug fix**                | ✅                                    | —                      | —               | at the level the bug lived           | —                       | see below                                                                                                |
| **Config / flag / infra**  | —                                     | —                      | —               | ✅ where a wrong value is detectable | —                       | who can actually grant the flag; deploy-day behavior for existing users; rollback                        |

**Bug fix — the rule, plainly: first write the test that reproduces the bug, and watch it
fail.** Reproduce it at the lowest level that exhibits it, with the reporter's actual data.
That failing test _is_ the bug report, and its red run is the proof you understood the defect
rather than one near it. Only then fix the code. If you cannot make a test fail, you have not
reproduced the bug — do not ship a fix for a defect you cannot demonstrate. Keep the test
forever; it is the regression guard, and it carries the bug's ID.

---

## 14. Reviewer checklist — is this diff's testing real?

Walk it against any diff. Any ✗ is a finding, not a nit.

- [ ] Every new or changed behavior maps to a requirement ID; every requirement maps to ≥1
      test; no test claims a requirement it does not exercise.
- [ ] The tests were written before the implementation, and there is evidence of a **verified
      RED** — an assertion failure, not an import error, not "0 tests matched".
- [ ] Every expected value has an oracle independent of the implementation, not a value
      pasted from a run.
- [ ] Assertions are on observable behavior; none inspect private state, call order, or a
      mock's own return as the sole check.
- [ ] The unit under test is not mocked; mocks sit at process boundaries only.
- [ ] Each test has one reason to fail; no `if` or `try` inside tests.
- [ ] Negative and error cases exist: unauthorized caller, invalid input, duplicate submit,
      empty and boundary values.
- [ ] Tests sit at the **lowest level that can fail for the right reason** — nothing pushed to
      e2e that a unit or integration test could catch; nothing unit-tested behind a mock that
      hides the actual risk (scoping, transactions, serialization).
- [ ] Invariants over money, quantities, dates and permissions have property tests, or a
      written reason why not.
- [ ] No sleeps, no `waitForTimeout`, no check-then-act on the same element; Playwright uses
      semantic locators and web-first assertions.
- [ ] E2E data is created by the test, scoped to a disposable account, and cleaned up.
- [ ] No `.skip` / `.only` / commented-out assertions; nothing disabled to make CI green.
- [ ] For a refactor: no assertion text changed — changed assertions mean changed behavior.
- [ ] For a bug fix: the diff contains a test that fails without the fix.
- [ ] For UI: screenshot evidence per viewport, console clean, all states covered, tokens from
      the derived design system.
- [ ] CI actually executed these tests on this run (cache miss and duration confirm it), not a
      replayed green log.
- [ ] Every verification command whose failure is being read as a defect was proven to pass on
      the unmodified tree; anything broken at baseline is fixed in the plan, not worked around
      in the code.
- [ ] The mutation probe — or Stryker on high-risk paths — shows the tests go red when the
      behavior is broken, and the file came back byte-identical **per independent before/after
      checksums**, not per the probe's own say-so. A skipped probe is recorded as skipped, not
      counted as evidence.
- [ ] Nothing added that the repo's conventions forbid: no second runner, no banned pattern,
      no new dependency slipped in through a test.
