# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 52 active entries / 80 KB (set in [`_meta.json`](_meta.json), enforced by
> `scripts/validate-lessons.mjs`) — compact to [`ARCHIVE.md`](ARCHIVE.md). Maintained by the
> `lessons-learned` skill. Blameless; **never client names/slugs/document numbers** — the repo
> goes public briefly for CI.

## process

### L-386 · 2026-11-15 · process · a gate names every touched src directory plus repo-truth, auth/permissions and common, runs the FULL web jest for any PR touching apps/web, and rebuilds the workspace dist first; the verdict states the totals (#4327, #4334)

- **Symptom:** two PRs reached review on a narrower api run (15 suites; one without its touched `src/buyer`). A third reached PASS x2 with web files changed and no full web jest, and CI then caught a source pin in a static test. A review tree with a stale gitignored `packages/pricing/dist` ran web and api jest against the old pricing: tsc red, jest green.
- **Root cause:** the gate was whatever the lane or reader chose to run, and nothing required the verdict to show its totals; a stale build output makes tests pass against code that is not in the tree.
- **Lesson:** **The api gate is every touched `src/<dir>` plus `test:repo-truth`, `src/auth/permissions` and `src/common`; any PR that touches `apps/web` runs the FULL web jest and web lint; rebuild `packages/pricing` (and any touched package) at every gate checkout, and read a green jest beside a red tsc in one tree as a stale build output. The verdict states the suite and test totals.**
- **Guard:** owed, NOT BUILT YET: the reviewer's verdict template carries the totals line; no repo file enforces it.

### L-390 · 2026-11-15 · process · a size-ratchet count is read on a merge of the branch with current master plus the queued members, not on the branch's own base

- **Symptom:** two PRs passed their local gates and both reads, yet each broke `size-ratchet.spec.ts` once merged with master (the orders service at 5,178 and 5,204 lines against a ratchet of 5,177).
- **Root cause:** the count was taken on the branch's own base; master had grown through other merges, and the queued window added more.
- **Lesson:** **A ratchet file's line count is meaningful only on the merge result. The lane gate reports that count from a merge-tree of the branch with current master (no worktree needed), and it is read again when the reads are ordered, with the window's other members added.**
- **Guard:** the lead's combined check measures it for window members; `size-ratchet.spec.ts` fails the merged tree.

### L-379 · 2026-11-12 · process · a hold or fix order is issued only after the reviewer's verdict and browser evidence are posted; the order carries their board comment ids (#4302)

- **Symptom:** a hold and a one-case fix order for #4302 went out from an interim reading, before the reader's FAIL (board 6819958479) and the browser evidence (6819958939, which found more than the reader's MUST) were posted. It cost a round.
- **Root cause:** the order was written from a partial read; nothing required it to name the evidence it rested on.
- **Lesson:** **An order that holds a PR or tells a lane what to fix names the board comment ids of the verdict and of the browser evidence it rests on, and is not sent until both are posted. A fix scoped from an interim read is re-scoped when the evidence lands.**
- **Guard:** owed, NOT BUILT YET: a required field in the lead's order template holding the board comment ids of the verdict and of its evidence. No file in the repo carries it today.

### L-359 · 2026-10-30 · process · a train is pushed only after the CI-equivalent verify; type-checks plus one test file is not a gate, and CI is read by its closing Failed line

- **Symptom:** a 13-member train pushed after clean merges, api and web type-checks and one test file went red in CI in three members (a web suite pinning an older unit rule, an api spec expecting another warning code, a writer-inventory spec). The first read of the log took one lane's "passed" counts for the whole api.
- **Root cause:** each member's PASS was read at its own head; master-wide pins only fail on the merged tree, and the pre-push verify was skipped. A workspace's log holds several test lanes, so one lane's counts are not its result.
- **Lesson:** **Run the CI Verify equivalent in the train tree (`FULL_VERIFY=1 npm run verify`) through the heavy slot and read it to the end before pushing a train; with a T1 member add the full DB lanes. Read CI by the closing `Failed:` line, never by one lane's counts.**
- **Guard:** the train PR body states the command and the counts. Cf. [[L-353]]. A DB spec that needs a built artifact (the api dist) ships with the CI step that builds it, and a job that shows 0 steps after a few seconds has failed, not queued. The pre-check also runs `api-error-codes-parity` and `permission-coverage`: a member's bare error-code string in a web file passed every member read and went red only on the merged tree, because that spec scans web and api alike.

### L-337 · 2026-10-22 · process · merge only through a gate that lists EVERY check run at the exact head sha, required or not

- **Symptom:** a merge window merged #3563 and #3585 while the "Replay migrations on a fresh database" check was FAILURE at the merged sha. #3563 carried three red DB specs (two variant-name specs hit the SA-823 R11 `reparentVia` guard in `ProductsService.update`; products-export gained a new last column) plus one from #3574 (a warning became an object). All spec-only; #3589 fixed them.
- **Root cause:** the merge watcher printed one check (Verify) and was read as all-green. The replay job is path-filtered, so whether it exists varies per PR, and nothing asserted it.
- **Lesson:** **Merge only through a gate that lists EVERY check run at the exact head sha, required or not, and refuses on FAILURE, CANCELLED, TIMED_OUT or pending (SKIPPED and NEUTRAL pass). The same gate asserts head == the reviewed sha, base == master and not draft. A watcher that prints one check is not a gate.**
- **Guard:** `tools/lead-kit/merge-gate.sh` in the specs repo (every check at the head sha; head/base/draft asserts). Cf. [[L-335]].

### L-335 · 2026-10-22 · process · a PR's green CI can be for a stale merge ref; after master moves, the check must run on a merge ref whose base is current master

- **Symptom:** #3586 needed update-branch twice before it could merge: its CI was green, but GitHub's merge ref had been built against an older master, so the green said nothing about the merge that would actually land.
- **Root cause:** GitHub recomputes the PR merge ref lazily; a check that ran before master moved (or after a close/reopen) tested the old base. "All green" was true of a different commit than the one the merge would create.
- **Lesson:** **Before merging, confirm the checks ran on a merge ref whose base is the CURRENT master: `pulls/N`'s `merge_commit_sha` must have current master among its parents (the run log's "Merge X into Y" names it). If not, update the branch (a merge commit, never a force push), check the PR's own patch-id is unchanged, get the reviewer's re-pin at the new head, and wait for fresh checks; a green from an older base is not a gate. Exception: a master delta disjoint from the PR in files AND package needs no rerun (the base only moved somewhere the PR cannot reach); any shared module reruns.**
- **Guard:** the lead's merge procedure (update-branch, then fresh CI) and the memory note on close/reopen testing a stale merge ref; none automatic. Cf. [[L-323]].

## tooling

### L-388 · 2026-11-15 · tooling · `gh run list --json conclusion` is the empty string, not null, while a run is in progress; map it to a marker explicitly and key timers by run id plus attempt (#4324)

- **Symptom:** a window's hang guard cancelled a healthy rerun of #4324: the lead's script read a tab-split row, the in-progress conclusion was `""`, and the field after it shifted.
- **Root cause:** `jq '.conclusion // "-"'` replaces only null and false, so the empty string passed through, and a whitespace-split read drops an empty field.
- **Lesson:** **Map an empty conclusion to `-` explicitly (`if . == "" then "-" else . end`), read rows as JSON rather than splitting on tabs, and key every timer by run id and attempt so a rerun gets its own clock.**
- **Guard:** none in the repo (lead tooling); the window script carries the explicit mapping.

### L-358 · 2026-10-30 · tooling · api check-types in a tree that did not build the workspace packages drowns in TS2307; build `packages/*` first

- **Symptom:** the api type-check on a freshly installed train tree reported 913 diagnostics (baseline 551), nearly all "Cannot find module '@routeflow/pricing'".
- **Root cause:** `@routeflow/pricing`, `returns` and `scanning` resolve their types from `dist/`; `npm ci --ignore-scripts` builds nothing, so every importer fails.
- **Lesson:** **Before reading a type-check count in a new tree, build the workspace packages that publish `dist/`. A count far above baseline with TS2307 on a package name is a missing build, not a member defect. After a `packages/*` change lands or is edited, rebuild `dist/` in every tree that tests against it: web specs import the built `dist`, so a stale one fails silently with wrong money figures, not an error (archived L-176).**
- **Guard:** the train check script runs the package builds first, then api and web check-types.

### L-329 · 2026-10-21 · tooling · an Expo web export can reuse a shared Metro cache and bake another build's EXPO_PUBLIC_* values; export with --clear and assert the bundle

- **Symptom:** a phone proof build for #3553 from a fresh worktree, with `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_BUILD_SHA` exported, came out pointing at another lane's API (`localhost:3000`) with an empty build sha.
- **Root cause:** Metro's transform cache is shared across worktrees on one machine, and a cached transform with an earlier inlined env was reused. The export itself succeeded with no warning.
- **Lesson:** **Every Expo web export used for a proof or a deploy runs `npx expo export --platform web --clear`, then greps `dist/_expo/static/js/web/*.js` for the exact API base URL and the full build sha before any capture. A substring check like "3310" is not proof: grep the whole value.**
- **Guard:** none automatic; the sign-in screen's `build <sha7>` (`lib/build-info.ts`) is the on-screen check. Cf. [[L-265]] (stale build output in a proof).

## testing

### L-387 · 2026-11-15 · testing · a test helper is not named `use*`: the web lint reads it as a hook and fails the PR (#4340)

- **Symptom:** a web PR went red in CI on `react-hooks/rules-of-hooks`: a plain helper in a test file was called from a callback and its name began with `use`.
- **Root cause:** the lint rule keys on the name, not on what the function does; the lane's gate had not run web lint.
- **Lesson:** **Name test helpers for what they return (`makeX`, `renderX`, `withX`), never `useX`, unless the function really is a hook called at a component's top level. Web lint is part of every web PR gate.**
- **Guard:** the web ESLint `react-hooks/rules-of-hooks` rule in `npm run lint`. Cf. [[L-386]].

### L-389 · 2026-11-15 · testing · a source scan's file-walk predicate is pinned by a row that names edge files, and a label type error shows only under the spec ratchet (#4344)

- **Symptom:** a return-address scan walked the API sources with `/.(spec|test).tsx?$/` as its skip filter; the unescaped dot also dropped `common/testing/db-spec.ts` and `smtp-spec.ts`, so the scan read green while skipping both. A reader found it, not the scan.
- **Root cause:** the predicate was never itself tested, and a scan that finds nothing in a skipped file looks identical to a clean file. Separately, a row label written with two quoted pieces was a type error that plain `tsc` never reports, because it skips specs.
- **Lesson:** **Give every scan's walk a row that asserts the named edge files ARE scanned (a helper called `*-spec.ts`, a `.tsx` file) and the excluded kinds are not; escape the dots in a file-name predicate. A spec type error is judged only by `npm run check-types -w apps/api` (the ratchet), and prettier rewrites quoted keys, so a row meant to test a quoted-key spelling tests nothing: label it as a label.**
- **Guard:** the walk row in `apps/api/src/billing/billing-return-paths.spec.ts` (db-spec.ts and smtp-spec.ts scanned, no `*.spec.ts(x)`, at least seven `.tsx` files).

### L-377 · 2026-11-12 · testing · a pin ships with a red probe the builder watched fail; a regex with a stray control byte matches nothing and passes whatever the tree holds (#4303)

- **Symptom:** the inventory pin that was meant to prove every till window is covered or excused could not fail: `CounterSaleScreen.escape-scan.test.tsx:259` holds a literal backspace byte (0x08) where `\b` was meant, so its file list was always empty. Both readers found it; the builder had not seen it fail.
- **Root cause:** the pin was written and run green once. A green pin proves nothing until it has been seen red on a tree that violates it.
- **Lesson:** **Every inventory pin or source-scan test ships with a probe the builder observed red (add the violating file, or remove the entry, and run it), and asserts that the scan found at least one file. A control byte in a pattern is read in a hex view of the line, not by eye.**
- **Guard:** none automatic yet; the corrected pin is owed in the counter lane's next PR (test-only). Cf. [[L-364]], [[L-322]]. Extended 2026-11-13 (B1324): the first overlap probe on the phone heading rise (spec 85 T9) read only settled pairs with both boxes in the window and passed on master while the bug stood; the strengthened probe reads the first frame after each scroll step and again settled, counts boxes below the window, and on master fails on the bug's own value (10 px: a 22 px hold over a 12 px gap). The replay cell also asserts its precondition (the section really is at rest) before it measures. Rule: a probe waits for nothing and measures at the moment the person sees it.

### L-378 · 2026-11-12 · testing · a hand-over test runs the real scan detector with a full-length code; a mocked detector and a short code cannot see a dropped first key (#4302 review)

- **Symptom:** in PR #4302 (merged as 1c22822497, head 15137041c9, with the fix) the order builder's line handle handed focus to product search, but the first key of a scan had already gone to the handle, so the lookup lost its first character (board 6819958479, confirmed in a browser run on 6819958939: 5/5 runs, no line added). The PR's test passed.
- **Root cause:** the test mocked `BarcodeScannerButton` and scanned "300", which is under the detector's 6-character gate (`sequence.length >= 6`, `BarcodeScannerButton.tsx:110`), so neither the detector nor the dropped key was exercised.
- **Lesson:** **A test of a focus hand-over during a scan runs the real detector and types a full-length code (13 digits) with the scanner's key gaps, then asserts the lookup got the whole code once. A mock of the component that reads the keys removes the thing under test.**
- **Guard:** `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.scan-from-handle.test.tsx`: the real detector, a 13-digit code from handles 1 and 2 and from the search box; removing the dispatch in `SortableLines.tsx` turns two cells red. Open: only Enter is sent, a CR+LF ending from a handle is not covered. Cf. [[L-376]].

### L-374 · 2026-11-12 · testing · a spec that counts log lines across a loop owns its clock when the code under test rate-gates by wall time (B5-5, #4274)

- **Symptom:** CI Verify failed `prisma/prisma-call-place.spec.ts` B5-5 with "Expected length: 2, Received length: 3": one call site logged twice. Local runs and the earlier CI runs passed.
- **Root cause:** `tenant-context-guard.ts` lets one capture key log again after `CAPTURE_GAP_MS` (1000 ms, gate at `:139-140`) and reads time as `opts.now ?? Date.now`, bound once at module load. The spec's 1000-read loop was one line only while it stayed inside that second; a slow runner crossed it. The same unpinned loop sat on master since `8f73cf3880` (the guard itself landed in `9c743285ed`, B1285).
- **Lesson:** **A test that counts what a time-gated component emits across a loop installs its own clock for the module under test (a `jest.mock` factory that holds `Date.now` while the module loads and restores it in `finally`), and keeps one case that advances the clock past the gap and expects the next emit. Prove the cause by jumping the clock, not by throttling the machine.**
- **Guard:** `prisma/prisma-call-place.spec.ts` B5-5 (frozen clock) and B5-5b (advance 1001 ms, the same site logs again). Cf. [[L-353]], [[L-370]].

### L-366 · 2026-10-31 · testing · a wrapper must accept only values its inner guard accepts; a safety guard is never widened to fit the wrapper

- **Symptom:** a full DB lane run with `RF_DBSPEC_HOST=127.0.0.2` failed 441 of 444 suites after a long wait, each with "Refusing to run DB-backed specs against a target that is not provably local".
- **Root cause:** `scripts/local-db-specs.mjs` accepts `localhost` or any 127.x.x.x address, but `requireLocalDatabaseUrl` (`apps/api/src/common/testing/db-spec.ts`) allows only localhost, 127.0.0.1, ::1 and postgres. The wrapper passed its own check and the inner guard then refused every suite. The host was chosen to route around a relay holding a port, which is an environment fault.
- **Lesson:** **Every value a wrapper accepts must also pass the guard behind it: share one allow-list, or pin the wrapper's accepted set against the guard. A safety guard is never edited inside a train; an environment fault (a relay holding a port) is fixed, or routed around on another host, not by widening the guard.**
- **Guard:** none yet; a spec pinning the wrapper's accepted hosts against the guard is a named follow-up. Cf. [[L-363]].

### L-364 · 2026-10-31 · testing · a static pin that scans source text must read every shape the repo writes, template literals included; fix the source shape, never the pin, inside a train

- **Symptom:** the date-input size pin (`apps/web/app/globals-date-input.static.test.ts`, #2080) went red on the assembled train: the new product-count window's date input read as unsized, although its shared class constant carries `w-full`. The member that added the input never ran that pin: it is red at that member's own head too, so this is the case in [[L-323]], not a composition surprise.
- **Root cause:** the pin collects string literals only (`ts.isStringLiteralLike`). A class constant written as a template literal with a substitution (`${TALL}` inside the string) is invisible to it, and no earlier input used that shape, so the pin's own spec never fed it one.
- **Lesson:** **A pin that reads source text must handle every shape the repo writes (template expressions included), and its own spec must feed it the repo's real shapes. When a static pin goes red on a new file inside a train, change the source to a shape the pin reads (string concatenation, same classes); never edit the pin or its spec in the train.**
- **Guard:** the by-hand train pre-check set runs the web static pins (`apps/web/app/*.static.test.ts`) before the long verify, so a red surfaces early. Cf. [[L-322]], [[L-323]].

### L-353 · 2026-10-29 · testing · a spec with literal fixture dates, over code that reads the real clock, turns master red on a calendar date with no commit

- **Symptom:** a train push went red on master's own billing spec (5 of 109 cases) although no commit had touched it; the train's members were suspected first.
- **Root cause:** the code reads `new Date()` for a 72-hour floor while the spec billed a literal future date, so the case flipped once the wall clock passed the floor. Member passes were days old and nobody had run bare master that day.
- **Lesson:** **When code under test reads the clock, pin it (`jest.useFakeTimers().setSystemTime(NOW)`) or derive every fixture date from that NOW; a literal future date is a failure with a date on it. Before assembling a train, run the gate on bare `origin/master` first, so a red that is master's own is fixed on its own and never charged to a member.**
- **Guard:** the clock pin on the payment-due specs (5f6b2290b, train W26); the train pre-check of LEAD-LOG 2026-10-29 #3799. Cf. L-290, L-335. Extended 2026-11-01 (train q): two billing specs left the clock real, and the checkout anchor refuses a start within 91 minutes of the 1st at 12:00Z, so every api Verify that reached them between 10:29Z and 12:00Z on that day failed (33 tests, 2 suites) while the code was right; a run before 10:29Z had passed. Pin the clock in each spec whose subject reads it (`apps/api/src/testing/pin-clock.ts`, #4084), and when a month-boundary window exists, expect the red on the 1st and 2nd, not only on the day a commit lands. Extended 2026-11-13 (B1327): `CounterSaleScreen.date-scan.test.tsx` called `jest.useFakeTimers()` without a system date, and fake timers start at the real now, so its "fri" scan and TODAY/BACK chips failed on one weekday. Now pinned to Wed 2026-06-17 12:00Z in the same `beforeEach`. Put `setSystemTime` next to every `useFakeTimers`; a weekday-relative case is red one day in seven. No automatic scan for a fake-timer spec with no pinned date yet.

### L-322 · 2026-10-20 · testing · a move-only extraction re-runs the static source-pin specs, and the pin reads the moved files too

- **Symptom:** a refactor that only moved code into new files passed a move-only review and its unit tests, then failed the pre-push run: specs that read a source file's text and assert on it no longer found the code.
- **Root cause:** a source-pin spec asserts on one named file; moving the code out makes the assertion fail (or, worse, pass vacuously when it pins an absence). A diff review of a pure move cannot see that.
- **Lesson:** **After a move-only extraction run every static source-pin and scan spec that names the touched files, and repoint each pin to read the original AND the new files (a shared source reader), so it keeps guarding the code wherever it lives. A move-only review does not replace the run.**
- **Guard:** none automatic; pins that walk the tree through `apps/api/src/testing/source-scan.ts` survive a move, single-file pins do not. Cf. [[L-205]].

### L-323 · 2026-10-20 · testing · a changed-since pre-push skips repo-wide static scans, so a train gate runs them in full

- **Symptom:** a branch passed the fast pre-push (`--changedSince`) and a repo-wide static scan (such as the accessible-labels scan) then failed on the train tip.
- **Root cause:** an affected-only run selects specs by the files a branch touches; a scan that walks the whole repo has no dependency edge to the changed file, so it is never selected.
- **Lesson:** **Treat the fast or affected run as a convenience, not a gate. A train or merge gate runs the repo-wide scans in full (`FULL_VERIFY=1`) on the landing tree, whatever the members ran alone.**
- **Guard:** `FULL_VERIFY=1` in the train gate; none automatic for a single branch. Cf. [[L-290]]. Extended 2026-10-21: a builder's targeted gate (touched specs only) missed three whole-source structural pins in one night (an "only N callers" billing pin, an "every DB-writing script is guarded or exempt" guard, a mobile source-regex pin), because pins live outside the touched files. Before reporting, a builder runs the WHOLE jest of every touched workspace (through the heavy slot, [[L-325]]).

### L-326 · 2026-10-20 · testing · a migration that retires a known edge updates, in the same train, every spec that pins the edge's old behavior

- **Symptom:** after a column widen retired a rounding edge (B296, a 4-dp rate), a spec that asserted the old 4-dp clamp stayed in the tree; it was green on its own branch and red only on the combined R5 tree.
- **Root cause:** the pin lived in a different branch from the migration, so neither branch's run held both the new column and the old assertion, and a diff review cannot see a spec that asserts a behavior the migration removed.
- **Lesson:** **When a migration retires a known edge (a widen, a dropped clamp, a new constraint), grep the specs for the edge's bug id and its old literal values in the same train and update each pin to the new rule; the pin goes red only on the combined tree, so run it there before the push.**
- **Guard:** none automatic; the train gate runs the full suite on the combined tree (cf. [[L-264]], [[L-323]]).

### L-327 · 2026-10-20 · testing · a more specific refusal added ahead of an existing guard is grepped against every spec that pins the old generic code

- **Symptom:** a new coded refusal (a bill with cash payments, BILL_HAS_PAYMENTS) was added ahead of the generic state guard; race and concurrency specs that pinned the old generic code then failed on the combined tree.
- **Root cause:** those specs asserted the old error code as a stand-in for "the second writer lost"; the new guard fires first on the same input, so the invariant still held but the expected code was stale.
- **Lesson:** **When a new guard or error code is inserted ahead of an existing one, grep the specs for the old code and update each; keep the invariant the spec proves (one writer wins, nothing written) and change only the expected code, never loosen the assertion to accept any error.**
- **Guard:** none automatic; the train gate runs the full suite (cf. [[L-264]]).

### L-247 · 2026-09-29 · testing · swapping a constructor dependency has construction sites tsc does not check (#2241)

- **Symptom:** #2241 replaced `EntitlementsService` with `EntitlementAuthority` in two services; 12 specs
  built those services with a `useValue` stub of the dead dependency, and only a boot or a spec run
  shows a wrong provider (the L-113 class).
- **Root cause:** a Nest constructor change is type-checked at the class, but every spec provider
  array and every importing module is a construction site that `useValue` stubs and mocks hide from
  tsc.
- **Lesson:** **When a constructor dependency is added, removed or swapped, grep every construction
  site of the class (spec provider arrays, other modules' providers, test builders) and change them in
  the same PR; then boot the real container.**
- **Guard:** the compose boot gate (`local:up`) proves the real DI graph; no automated
  construction-site scan yet.

### L-262 · 2026-10-05 · testing · a generated Prisma client is per install: a worktree that shares or hoists `node_modules` verifies against another tree's schema

- **Symptom:** a worktree that shared `node_modules` with another tree (symlinked or hoisted) ran specs and queries against the OTHER tree's generated Prisma client, so a green run said nothing about this tree's `schema/*.prisma`.
- **Root cause:** `prisma generate` writes the client into `node_modules/.prisma`, so a shared install serves whichever schema its owner last generated, and mocked specs accept any shape; trusting the green run was the mistake.
- **Lesson:** **In the tree under test run `npx prisma generate` from `apps/api` after the install, and prove any changed `select`/`include`/`where` with an executed query against a database migrated from THAT tree's `prisma/migrations` (`npm run local:migrate`, then the DB lane). A link to another tree's `node_modules` is fine for docs-only work and never for code that touches the schema.**
- **Guard:** none automatic; the install order in [[L-254]] (`npm ci --ignore-scripts`, `prisma generate`, build `packages/*`), `npm run local:drift` against the compose DB, and the executed-query rule. Cf. archived L-176. Extended 2026-10-21: a DB-backed spec that needs reference data (a published plan catalog) passed on a seeded dev database and failed in CI's fresh replay database. A DB spec seeds the reference data it needs through the shipped idempotent publishers, behind the local-DB guard, and is proved once against an empty migrated database.

### L-383 · 2026-11-15 · testing · a probe's entry condition names the branch it passes through; "nothing changed" from a skipped branch proves nothing about the branch you meant to test (W-946r)

- **Symptom:** a probe of a delivered line's quantity floor sent `qty: 0`, saw the save succeed with stock, delivered count and invoice unchanged, and read it as "the floor holds, close with a pin". A re-probe at `qty: 3` showed the opposite: the stored qty dropped below the delivered count, the line flipped to Pending, stock got no return, and the invoice billed the lower quantity (B1330).
- **Root cause:** the per-line update branch of `updateOrderItems` skips any non-positive quantity for every existing line (`if (qty <= 0) continue`), so `qty: 0` never reached a quantity write. The brief named the input, not the branch it takes.
- **Lesson:** **Before a probe's result is read as a verdict, read the code path the entry condition takes at the base and name the branch; a "no change" outcome is evidence only if that branch contains the write under test. Probe a value the generic skip lets through (a positive one), and say which branch each value reaches.**
- **Guard:** none automatic. SA-E111 records the miss; the red pin for the floor (B1330) lands with F-1, and B1336 tracks the silent `qty: 0` skip itself.

## domain

### L-375 · 2026-11-12 · domain · a flag the middleware reads to route a browser is set by every path that starts a session, impersonation included (B1304)

- **Symptom:** "Sign in as admin" from a browser that also held a buyer session bounced `/dashboard` to `/login`: the guard read the browser as buyer-only.
- **Root cause:** `resolveOperatorPathGuard` trusts the `rf-op-auth` presence cookie, which a normal operator sign-in sets; `setImpersonation` stored the tokens but never set the cookie.
- **Lesson:** **Every code path that makes a browser an operator (sign-in, impersonation, any future switch) calls the one helper that sets the presence cookie, and every exit path clears it unless the browser holds operator tokens of its own. Test it through the real guard with no mocks of the helpers.**
- **Guard:** `lib/impersonation.presence.test.ts` (5 tests, real guard and helpers). Open: the automatic exits in `lib/api-client.ts` clear the tokens but not the cookie (see the register). Cf. [[L-369]].

### L-371 · 2026-11-06 · domain · a default and a backfill reach rows that exist and rows created; a row moved into a role gets the role's defaults from the code that moves it (SA-1050 A-5)

- **Symptom:** a migration appended `BAD_DEBT` to every existing OPERATOR's deny list and set a column default for new rows, yet an admin moving a DRIVER or CUSTOMER to OPERATOR left that row at `{}`: an operator with write-offs on by default.
- **Root cause:** a column default and a one-time backfill are keyed on a row existing or being created, not on a row changing into the audience; `updateUser` changed the role and nothing else.
- **Lesson:** **When a default belongs to a role, apply it in the one service method that moves a row into the role, in the same update that changes the role, decided by the server and never the DTO. Write a red case for each source role and guards for a move out, a same-role save and a self edit; pin the API literal to the shared source of the default set.**
- **Guard:** `OPERATOR_DEFAULT_DENIED_GROUPS` (`auth/permissions/operator-default-denied.ts`) pinned to the OFF set of `GROUP_INTRODUCED` in `permission-groups-contract.spec.ts`; `users-operator-entry.db.spec.ts` A5-1 to A5-7 (the two source-role rows were red on the unfixed service; two guard rows were added after a mutant survived). Cf. [[L-301]].

### L-370 · 2026-11-06 · domain · a capture gate on a diagnostic is keyed by every field the reader groups by, under one global budget and a bounded map; a coarser key hides the second site (B1285)

- **Symptom:** the dark tenant-context guard captured one stack per second per `kind|model|op`; one hot call site (1,000 reads) took the second's capture and a second site under the same key never reached the log, though the counter stayed true. Scheduled jobs logged no job name at all.
- **Root cause:** the gate key named what the counter answers (what kind of access), not what the log answers (where from); a cron job has no request route to name itself.
- **Lesson:** **Key a rate gate by every field the log line is read by (kind, model, op, call place), put one global per-second budget over it (20) and a backstop on the map size (5,000 entries), and check the shape of the place string before it enters a key. Name each scheduled job's place where the job starts (`@LeaderCron` runs the body at `<area>.<method>`), so the log says which job.**
- **Guard:** `prisma/tenant-context-guard.spec.ts` rows B5-1 (key without `where`), B5-2 (no budget) and B5-4 (no shape check), each red by mutation; `common/call-place.ts`. Open: B1295 (the two queue processors have no row). Cf. [[L-369]].

### L-369 · 2026-11-05 · domain · a tenant-scoped accessor never degrades to the unscoped client; with no business in context a secret read and every write throw

- **Symptom:** a business's own API key sat as plaintext in a shared config row (written before the encryption existed), so it was also in every database backup; and the config service, asked for a value with no business in context, handed back the unscoped client, so a read or a write could land on another business's row.
- **Root cause:** `forTenant()` returned the unscoped client when no tenant id was set instead of refusing, and each AI call site resolved its own key, so there was no single place that asked "which business, whose key, how much spent".
- **Lesson:** **An accessor that is tenant-scoped by contract throws a coded error when the tenant is missing; it never falls back to the unscoped client. Secret reads and every write refuse; other reads may continue with one warning per key. Put every call that spends on a shared key behind one entry (business, key, budget, model, in that order), call its tenant check as the first statement of each caller, and pin the caller list with a census that fails a new site.**
- **Guard:** `system-config-callers.census.spec.ts` (NONE = 0), `system-config.tenant-required.db.spec.ts`, `secret-keys.pin.spec.ts`, `ai-call-sites.census.spec.ts`, `ai-sites.tenant-first.spec.ts`; `report-plaintext-secrets.mjs` counts legacy rows. Cf. [[L-349]] (prove every id is in the tenant), [[L-368]] (one shared predicate).

### L-368 · 2026-11-05 · domain · a guard that asks "does a document stand on this order" counts every link that ties a document to it, through one shared predicate

- **Symptom:** a guard refused to move an order while a live return stood on it, yet an inline return raised on another order let the sold-from order through; the goods were already restocked and a later cancel credited stock twice.
- **Root cause:** the guard counted `Return.orderId` only. For an inline return that is the carrying order; the order the goods were sold on is `ReturnItem.sourceOrderId`. The header link and the line link are two answers to one question.
- **Lesson:** **Write the "is there a live X on these orders" test once, as a predicate that names every link (header key and line source key, dead statuses excluded), and make every guard count through it. Before trusting a guard, list each way a document can be tied to the row and write a red case for the link the author did not think of.**
- **Guard:** `liveReturnWhere` in `returns/live-return-guard.ts`; `live-return-guard.spec.ts` RO-36, the DB rows RO-31..35 and the three-caller census `live-return-guard.structure.spec.ts`. Cf. [[L-223]] (sweep every emit site, not the named ones).

### L-340 · 2026-10-24 · domain · one declared row-lock order, a pin that classifies every lock site, and no exception map that grows (#3680, #3697)

- **Symptom:** customer merge, refund, credit-note create and credit restore deadlocked 20 of 20 times in barrier specs. A retry wrapper hid it, and the second path surfaced as a 500.
- **Root cause:** each path locked Order, Invoice, Return and CreditNote rows in its own order, and one known inversion was parked in a `KNOWN_INVERSE` exception map instead of being fixed.
- **Lesson:** **Declare the row-lock order once as a constant and have a pin classify every lock site against it, so a new site fails until it is classified. Fix an inversion and delete its exception entry; an exception map may only shrink. A retry wrapper is not a deadlock fix.**
- **Guard:** `ROW_LOCK_ORDER` plus `common/order-lock-callers.guard.spec.ts` (`KNOWN_INVERSE` is `{}`), `returns/refund-claimers.pin.spec.ts`, `restore-credit-lock-order.db.spec.ts`.

### L-332 · 2026-10-21 · domain · an existing line is shown, edited and previewed in the unit it was sold in, at its own stored pack and price

- **Symptom:** the invoice edit form opened a boxed line as one total-pieces Qty (48) beside the per-box price (21.60), and a boxed line with no product posted a bare qty that re-billed 48 times the box price. Siblings: a repacked product previewed a stored 12-per-box line's Piece at the live size and list price, and a Today's-sales row read "24" for a line sold as 2 cases.
- **Root cause:** the form, preview or row took its unit from the live product or from total pieces instead of the line's stored sold unit (boxes, pieces, pack size, unit label, price), so quantity and price sat in different units.
- **Lesson:** **Read, edit and preview an existing line in the unit it was sold in, from its stored boxes, pieces, pack, unit label and price; convert to total pieces only at the edge, and post the split for every boxed line. Never put a pieces quantity beside a per-box price, and never price a stored line from the live product.**
- **Guard:** `SoldUnitQty.tsx` with the row-688 test; `orders/[id]/stored-pack-basis.ts` (`ownPack`, row 630); `foldItemNames` in `packages/pricing/src/counter-park.ts` (receipt quantity text). Cf. [[L-300]].

### L-305 · 2026-10-12 · domain · wrapping write controls in a gate covers only the controls someone wrapped; sweep the rest by search and pin the list

- **Symptom:** after the read-only gate shipped (WriteButton/WriteLink, a refusal notice in the shared Modal slot), UX re-runs still found raw write controls, hand-rolled dialogs and a driver shell with no notice; each was a separate P2.
- **Root cause:** the gate is opt-in per control and the notice rides a component slot, so anything not built on those components is outside it; the API side had a registry plus a route-walk pin (SA-776), the web side had neither.
- **Lesson:** **When a gate or notice is delivered by wrapper components, enumerate the surfaces by search (raw buttons that post to write routes, `role="dialog"` markup outside the shared Modal) and pin the list in a spec; state plainly which surfaces are knowingly outside it.**
- **Guard:** none automatic yet; propose a static scan on the web like the API's route-walk pin. Known gaps recorded: hand-rolled dialogs; the driver banner shows only after a refused write (no driver-readable status). Cf. [[L-225]]. Extended 2026-11-13 (B1): a staff-control gate for the customer role was added as one helper, `seesStaffControls` (`apps/web/lib/default-unit-line.ts`), and applied by sweeping every entry point the bug did not cite: invoice list and detail, dashboard quick-create, command palette, returns list and detail, the orders bulk bar and inline-return dialogs. Each has a `*.customer-role.test.tsx`; no scan lists every staff-control site yet, so a new entry point is covered only if someone sweeps it.

### L-300 · 2026-10-12 · domain · an edit screen freezes its diff baseline at edit-open and re-bases only on an explicit reload

- **Symptom:** an edit screen sent every line on save after a background refetch, re-writing untouched lines and reverting another writer's change made in between.
- **Root cause:** the diff of "what changed" was computed against the live query data, so a refetch silently moved the baseline under the user's edits.
- **Lesson:** **Snapshot the server state when editing starts and diff only against that snapshot; send just the fields the user touched. A refetch while editing never re-bases the draft: offer an explicit reload, and let the server reject a stale revision.**
- **Guard:** none automatic; review checks that a save payload is built from the frozen baseline. Cf. archived L-167.

### L-301 · 2026-10-12 · domain · a revision or guard value is written in the same transaction and lock as the check that reads it

- **Symptom:** two concurrent writers both passed a revision check and both committed, because the new revision value was appended after the first transaction committed.
- **Root cause:** check and write were separate steps, not one atomic compare-and-set under the row lock.
- **Lesson:** **Read the guard value after taking the lock, compare, and write the new value in that same transaction. A guard stamped after commit is a log, not a guard.**
- **Guard:** none automatic; DB specs that race two callers against one row. Cf. [[L-239]].
- **Recurrence 2026-10-18 (B1234):** the delivered-line lock ran on the locked rows but decided whether it applied from the order status read before the lock, so a delivery landing in between skipped it. Applicability is guard state too: read it under the lock. Unit + DB stale-read cases now pin it.

### L-072 · 2026-09-03 · domain · wave E `imp-10b`

- **Symptom:** 4 hand-typed client mirrors of Prisma enums drifted from the schema (invented,
  renamed, or omitted values); one hid a real action and broke a list filter.
- **Root cause:** each mirror was an independently hand-typed string union — TS never compares
  two such unions to each other, so the drift compiled clean and stayed invisible.
- **Lesson:** **Never hand-declare a client mirror of a server (Prisma) enum — derive one
  const-array union per enum from a shared package and pin it set-equal to `Object.values()` of
  the real enum in a spec, never against a second hand-typed "expected" list.**
- **Guard:** `apps/api/src/common/enum-parity.spec.ts` — a generic table (40 enums) against
  `packages/types/api/enums.ts`, plus a regression layer pinning the drifted files and the
  mobile jest stub that can't `require` the shared package directly.

### L-125 · 2026-09-14 · domain · W1 billing anchor

- **Symptom:** a fix for billing-period drift was about to derive each tenant's cycle anchor from
  `TenantSubscription.createdAt`, the only date on the row — moving real charge dates for anyone
  whose row predates their subscription.
- **Root cause:** several paths create that row without subscribing, so its creation date is not
  the anchor; no column stores one.
- **Lesson:** **Never infer a money-bearing date from a column that merely happens to hold a
  date. Check every writer of the row before treating a field as the thing you need — if none of
  them means it, the honest fix is a column and a migration. Shipping half a fix beats shipping
  a wrong charge date.**
- **Guard:** the time-of-day half shipped alone; the drift half is filed, blocked on an
  `anchorDay` column. Sibling [[L-118]].

### L-223 · 2026-09-26 · domain · "one ledger writer" needs a sweep of every emit site, not the named ones (B863–B866)

- **Symptom:** after the named add-on call sites were routed through the new single ledger writer, `subscribe()` still booked add-ons with its own emit on the old live-catalog formula. Only the run's final review caught it.
- **Root cause:** the brief named the call sites, and the change declared "the single add-on ledger writer" without sweeping the tree, so an unnamed writer kept a second formula.
- **Lesson:** **Before declaring one writer for a ledger or event stream, grep the whole tree for every emit of those events and every `amountDelta:` site, not only the call sites the brief named. Route each one through the writer or exempt it explicitly.**
- **Guard:** #2186: `subscribe()` (`subscription-mutation.service.ts` :395-421 at review) was the writer the sweep missed and now calls `emitAddonDelta`. On master, `ADDON_ENABLED/DISABLED` is emitted only in `billing/addon-ledger.ts`. No structural pin yet; propose one beside `mrr-paying-predicate.parity.spec.ts`.

### L-384 · 2026-11-15 · domain · a rule that is about to become a per-document mode is a REQUIRED parameter that throws when omitted, and every legacy caller states the old mode by name (#4323, W-989)

- **Symptom:** an invoice-level discount must start lowering the sales-tax base for new documents only, while every stored document keeps today's formula. An optional mode would let any caller that forgot it silently total on one formula and re-derive a stored tax rate on the other.
- **Root cause:** the totals and rate-inference helpers had no notion of a mode, and a default would hide the callers that still need a decision (the cutover constant stays null until the owner flips it).
- **Lesson:** **Add the mode as a REQUIRED union on every totals and rate-inference helper, assert it at runtime (a JS caller or a mock gets an error, never a default), have each existing caller pass an exported legacy constant by name so a grep lists the sites still to thread, and derive a document's mode from its immutable creation time so a stored document keeps its formula for life.**
- **Guard:** `packages/pricing/src/discount-tax-base.spec.ts` (an omitted mode throws in `computeInvoiceTotals`, `saleTotals`, `sumInvoiceTotals` and the rate inference; PRE_TAX 8 / 88 against LEGACY 10 / 90); the compiler for every typed caller. Cf. archived L-347.

## security

### L-372 · 2026-11-06 · security · a rotation resets every stored copy of the secret, a derived hash included, and an output scan covers every exit that holds the secret in scope (#4232)

- **Symptom:** (review notes on #4232; nothing leaked) the invite rotation cleared the code and its expiry but not `inviteTokenHash`; and the "no digest in the output" scan ran on the dry run, the no-backup refusal, the stale refusal and the committed apply, not on the compare-and-swap refusal, the one path with a planned digest beside the message.
- **Root cause:** the rotation was written against today's columns: the hash column is empty and unread, and in this codebase a NULL expiry counts as live, so a later backfill would bring a rotated link back. The scan list was the paths the author thought of.
- **Lesson:** **The SET of a rotation names every column that can resolve the secret (code, hash, expiry) and a row asserts each; sequence a hash backfill after any pending rotation. An output scan lists every exit that has the secret in scope, refusals first. A plan file that holds digests is mode 0600, expires in 24 h and is rewritten as spent after the commit.**
- **Guard:** `ef87ea532f` (plan file 0600, 24 h limit, spent plan holds no digest); P-1 to P-4 in `common/portal-invite-census.db.spec.ts`. Open: B1291 (the CAS refusal scan), B1292 (the hash). Cf. [[L-188]].

### L-328 · 2026-10-21 · security · a same-origin form POST under `Referrer-Policy: no-referrer` sends `Origin: null`; an Origin-equals-Host check then refuses every login

- **Symptom:** after the control dashboard set `Referrer-Policy: no-referrer`, every login was refused with 403, although the page and the form were on the same host.
- **Root cause:** browsers send `Origin: null` on a form POST when the referrer policy is `no-referrer`. The CSRF check compared the `Origin` header with the served host, so the literal "null" never matched (`apps/control/src/http/headers.ts:13`, `originOk` before `POST /login` in `apps/control/src/http/server.ts`).
- **Lesson:** **A strict Referrer-Policy changes what `Origin` a form POST carries. An Origin-equals-Host check must either accept `Origin: null` only when `Sec-Fetch-Site: same-origin` is also present, or the page must not use `no-referrer` for its own forms. Test the real form submit in a browser, never a hand-built request with a correct Origin.**
- **Guard:** none automatic yet; prove any CSRF or header change with a browser form submit. Fixed in `apps/control` (`Referrer-Policy: same-origin`; `originOk` accepts `Origin: null` only with `Sec-Fetch-Site: same-origin`), pinned by `apps/control/test/login-origin.spec.ts`.

### L-188 · 2026-09-17 · security · demo-booking OAuth/booking tokens in URL query strings

- **Symptom:** an OAuth/booking token traveled as a URL query parameter, the exact shape that ends up in server access logs, browser history, `Referer` headers, and analytics scripts.
- **Root cause:** a query string is the easiest place to carry a value across a redirect, but also the least private transport HTTP offers.
- **Lesson:** **Never carry an OAuth token, booking token, or any other bearer-shaped secret in a URL query string; use a fragment (`#`, never sent to the server) for a client-side handoff, or a POST body for a server-side one.**
- **Guard:** none yet; propose a lint/review checklist item flagging `token`/`code`/`secret`-named query params on any new route. Restored 2026-11-01 (it was archived on 2026-10-31 for room): this is a rule about RouteFlow's own routes, and the agent privacy rules cover what an agent does with URLs, not what the app puts in them.

## web

### L-382 · 2026-11-13 · web · a reveal reached at rest is recorded as played at once; one played-list serves every reveal path (B1324)

- **Symptom:** on the marketing pages a section already on screen at load, an anchor arrival, or the return from print blanked its text and faded it back in, or replayed a timeline on the next scroll.
- **Root cause:** each reveal path (per-element reveal, settle, timelines) kept its own memory of what had played, and a trigger reached inside a ScrollTrigger refresh recorded nothing. `once: true` was tried as the record and abandoned: it removes the trigger, which shifts the trigger list under later refreshes and changes the trigger count against a fresh load.
- **Lesson:** **Keep ONE played-list for every reveal path. A trigger reached at rest (inside a refresh, from an anchor, on the print return) is pushed to it at once and leaves its content as it is; only a callback from a scroll update plays. Never use `once` as the record.**
- **Guard:** `apps/web/e2e/85-site-proof-pages.spec.ts` T1 (same trigger count as a fresh load after print) and T2 (no heading waits for a scroll), and its replay cell, which asserts the at-rest precondition before it measures. Cf. [[L-377]].

### L-381 · 2026-11-13 · web · after print, restore the scroll place on the first ScrollTrigger refresh, not at `afterprint` and not on a timer (B1324)

- **Symptom:** leaving print (preview closed, or the print media query ending) put the page back at the wrong place: the reading position was lost.
- **Root cause:** leaving print rebuilds every trigger. Each refresh records the place, scrolls to the top to measure, puts the place back, then reports. The first refresh after the rebuild recorded the place of the print layout (no pins, a shorter page), so a single restore at `afterprint` was overwritten by the refreshes that run after it.
- **Lesson:** **Save the place when print starts; for the one frame after print ends, put the saved place back on every `refresh` report, with no timer, then stop. Turn off `overflow-anchor` in print so entering it does not shift the page before the place is read.**
- **Guard:** spec 85 T1 reads `scrollY` and the trigger count before print and after returning, on 12 pages at 1440x900 and 390x844. The mechanism is commented in `public/site/js/home-up.js` and `js/site.js` (the same toggle in both; `site-motion-always.static.test.ts` pins that).

### L-380 · 2026-11-13 · web · a `gsap.matchMedia` condition whose KEY is `all` always matches, whatever its value says (B1324)

- **Symptom:** a print toggle meant to take page motion off for print never reverted: motion stayed on and pages printed blank bands. Changing the condition's value string to screen-only changed nothing.
- **Root cause:** GSAP's `matchMedia` treats a condition named `all` as match-everything and never reads its value. `site.js` declared `{ all: "all", desk: "(min-width: 900px)" }`, so the context was live in print.
- **Lesson:** **Never name a `matchMedia` condition key `all`; name it for what it means (`screen`) and give it the media query. Prove a print branch by emulating print media and reading that the context reverted, not by reading the condition text.**
- **Guard:** `site-motion-always.static.test.ts` computes the condition from the source and requires it screen-only (ledger row B1324/T1 in `site-pin-ledger.json`); spec 85 T1 asserts no `js-motion` in print.

### L-376 · 2026-11-12 · web · a text field inside a closing dialog is not a typing target; one predicate decides it for every guard that asks "is a person typing" (#4303)

- **Symptom:** at the till, a scan that started 100-150 ms after Escape in a dialog's text box lost its leading digits and looked up a suffix. A 1-3 digit suffix is a quantity: the next correct scan could ring up x31.
- **Root cause:** a Radix dialog stays mounted with `data-state="closed"` for its 150 ms exit animation and keeps focus in its text box. The refocus and the key redirect both read a focused text box as "a person is typing" and stood down, so the keys died with the unmount.
- **Lesson:** **A guard that asks whether a person is typing asks one shared predicate, and that predicate excludes a field inside a closing dialog. Add no timer, no key timing and no new focus owner for it. Test it with a harness that emulates the exit animation (jsdom has none), at start delays on both sides of the animation, and with both line endings.**
- **Guard:** `insideClosingDialog` in `lib/refocus-scanner.ts` (read by `isTextEntryElement`); `refocus-scanner.test.ts` and `CounterSaleScreen.escape-scan.test.tsx` (removing the predicate turns 18 tests red). Open: Change the price with a code that starts in lowercase (`CounterLinePriceEdit.tsx:252`). Cf. [[L-353]].

### L-373 · 2026-11-06 · web · a percentage padding resolves against the parent's width; size a centred box with min(max, 100% - gutter) and fixed padding, and make the source scan read every spelling (#4234)

- **Symptom:** on a wide screen the home founder card grew to 1,640 px and its text sat in a narrow strip, with about 360 px of padding per side; the no-JS hero had the same shape.
- **Root cause:** the side padding was a percentage half-gap, `(100% - 1200px)/2`, and a percentage padding resolves against the parent's width, not the box's own width.
- **Lesson:** **A centred box on a page grid is `width: min(<grid>, 100% - <gutter>)` with a centring margin and a fixed clamp padding, never a percentage half-gap. A static scan for the bad shape normalises whitespace, covers the equivalent spellings (`calc(50% - N)`, a custom property holding the half-gap) and walks the whole stylesheet tree.**
- **Guard:** `site-founder-card-width.static.test.ts` (card width; a scan of `css/` and `graphics/` for one spelling). Open: B1294 (the other spellings). Cf. [[L-364]].

### L-385 · 2026-11-15 · web · one exported predicate says whether a key starts a scan run; each screen decides only where the scan goes (#4320, B1310, B1314)

- **Symptom:** a scan whose code began with a lowercase letter or punctuation, typed while a button, a drag handle or the page held focus, lost its leading keys; on the order builder its ending Enter reopened the date picker; on the till a leading `g` was taken by the g-then-x shortcut.
- **Root cause:** the date picker, the line drag handle and the till each spelled "this key starts a scan" for themselves, with different case, focus and modifier rules.
- **Lesson:** **Keep the run-start rule in one module (printable character, not Space, no Ctrl, Meta or Alt, focus not in a text field or a typeahead owner) and let each surface own only its destination field; the capture hands the key over and never stops a scan key, so a keyboard line move can still cancel. A rule about key order reads no clock.**
- **Guard:** `apps/web/lib/scan-run.test.ts`, `scan-run.structure.test.ts` (the module reads no clock, no second spelling of the rule), `CreateOrderModal.scan-destination.test.tsx`, `CounterSaleScreen.sa1067.test.tsx`.

## deploy

### L-367 · 2026-10-31 · deploy · a hosted job's timeout is sized from its measured stages with headroom; a cancelled run is read by its annotation, and a local verify red mid-chain hides every later step

- **Symptom:** train Y's hosted CI run was `cancelled` after 30 minutes. Turbo's 32 tasks had finished in 25m23s and the script self-tests that run after them were cut off at the job's limit. No test was red. The two trains before it had taken about 24 and 28 minutes in the same job. A cancelled run is not green, so the first public window was spent and a second one was needed. In the same train the local verify exited 1 on one self-test in the middle of the `&&` chain, so every step after it, including the final campaign-check, had never run.
- **Root cause:** the Verify job's `timeout-minutes: 30` was set when the suite was smaller; each landing grew it, the earlier trains sat a few minutes under the limit, and the next, larger train crossed it. `cancelled` looks like a manual or concurrency cancel; only the check-run annotation ("exceeded the maximum execution time") says it was the limit. For the local chain, `&&` stops at the first non-zero exit, so a load flake in the middle silently skips the tail.
- **Lesson:** **Size a hosted job's `timeout-minutes` from the measured duration of its slowest stage chain plus about 50% headroom, and re-measure when a train grows the suite. Read a `cancelled` job by its annotations before calling it red: a timeout is a one-line CI config fix, not a code defect. Read a failed local verify by which step stopped the chain, and run every step after it by hand before accepting the verify.**
- **Guard:** Verify timeout raised 30 to 45 in `ci.yml` (train Y); no automatic check yet. Cf. [[L-357]], [[L-363]].

### L-361 · 2026-10-31 · deploy · a window script reads the watchdog deadline from the log line of the pid it started, and reads that log with `grep -a`

- **Symptom:** a window script took its "time left" from the last deadline line in the watchdog log. The log is appended by every run, so the tail could hold the previous run's deadline, already in the past; acting on it flips the repo private while a deploy is still building. A plain `grep` on the same log also printed "Binary file matches" and no deadline at all.
- **Root cause:** the log is shared by every watchdog run and holds bytes that grep treats as binary; "the newest line" was assumed to mean "my watchdog's line".
- **Lesson:** **Start the watchdog, keep its pid, and read the deadline only from the log line that names that pid; read the log with `grep -a`; if no line for the pid appears, stop and ask instead of falling back to the tail.**
- **Guard:** none automatic; the window script is owed this change. Cf. [[L-357]].

### L-360 · 2026-10-30 · deploy · a landing is deployed only when every service status on the merge commit is SUCCESS; the repo has more than api and web

- **Symptom:** a train merge showed api and web SUCCESS while the mobile service failed. A gate that named "both services" would have called the landing done.
- **Root cause:** the deploy gate counted two services, but the commit carries one status per Railway service (api, web, mobile and the root), and mobile builds from the same packages and lockfile.
- **Lesson:** **Read every status context on the merge commit (`gh api repos/<owner>/<repo>/commits/<sha>/status`). A landing is done when none is failure or pending, and a failed one is read before anything else ships.**
- **Guard:** the window script prints every context and stops on any failure; the runbook wording is owed. Extended 2026-10-31 (train Y): the script also waits until NO service is pending before it flips private (the Y script flipped on the web failure while api and mobile were still building); the Z merge script's `wait_settled` does this and its EXIT trap waits the same way.

### L-357 · 2026-10-30 · deploy · size a public window as merges plus deploys; start every CI run when the window opens

- **Symptom:** two windows closed with CI still running and landed one PR between them; waits for CI burned the 45-minute watchdog.
- **Root cause:** windows were sized to CI wait plus merges. A run that starts while the repo is public keeps running after the flip, but a run that starts on a private repo fails on billing.
- **Lesson:** **Start every CI run at window open, close on the watchdog, and spend the window on merge, deploy SUCCESS and the private read-back. Never flip on BUILDING.**
- **Guard:** none automatic; the window sheet lists CI start times next to the merge order. Cf. [[L-003]]. A watchdog left running from a window that never opened blocks a fresh start and costs the wait: read visibility first, and if it reads PRIVATE replace the idle watchdog (no public time is added); if it reads PUBLIC, never replace, stop and ask. Extended 2026-10-31: never flip private while a train's hosted CI run is in progress unless the watchdog forces it. A hosted job was cancelled about 3 minutes after the flip with every real step already passed and only the post-run step cancelled; a cancelled run is not green, so read the run's conclusion (as [[L-337]] refuses CANCELLED), and a second short window may re-run the failed job. Extended 2026-11-01 (train n): push the train branch while the repo is still private, before the watchdog starts (the pre-push fast verify takes minutes, none of them public), then open the window with the branch already on origin. A docs-only PR (only `.claude/**`, `docs/**` or `**.md`) gets no CI run in any window, because `ci.yml` `paths-ignore` skips it and a close/reopen fires nothing; its gate is the read PASS plus MERGEABLE/CLEAN, so do not promise it CI. Extended 2026-11-01 (train o): a Verify attempt that started in window 1 and was still running at the private flip hit the 45-minute limit (annotation: exceeded the maximum execution time) with nothing red; the failed-job re-run in window 2 passed in 23m44s on the same sha, while Migration replay and Control, which had finished inside window 1, stayed green. Re-run only the failed job in the next window and report the check-run annotation, not just `cancelled`. Extended 2026-11-01 (train q): flip public with `node tools/ci-runner/check-no-runner.mjs && gh repo edit ...`; the check refuses when GitHub cannot be read (a TLS timeout did once), so retry the check rather than bypass it, and open the train PR only after the repo reads PUBLIC, because a run that starts seconds before the flip dies as 2-second billing reds and needs a re-run.

### L-282 · 2026-10-08 · deploy · a feature PR never adds or changes tenants or rows in the shared e2e seed that runs against production

- **Symptom:** recorded by the 2026-10-08 operating review; the incident detail is in the lead's notes.
- **Root cause:** the e2e seed runs against production after every deploy, so a tenant a feature PR adds to it is created for real by the next post-deploy E2E.
- **Lesson:** **The production e2e seed gains a tenant or row only through its own reviewed PR, never inside a feature PR. Test data follows the approved test-tenant policy (CLAUDE.md "Test tenants & real-client data").**
- **Guard:** standing rule plus the e2e-seed review checklist; no script yet.
