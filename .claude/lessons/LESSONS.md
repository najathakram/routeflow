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

### L-391 · 2026-11-16 · process · a verbatim move or rename runs the full api jest and a grep of the specs for the old path before the reads (#4321)

- **Symptom:** a verbatim lift of one service method into its own file passed a gate sized to the touched folders and both reads, then went red in CI: a census spec in another folder names the files allowed to write a field by path, and the moved code was no longer at the listed path.
- **Root cause:** "size the gate to the delta" counts the folders a diff edits, and a move edits two files while a pin elsewhere names the old one; nothing in the move's own tests reads that path.
- **Lesson:** **A move or a rename is never sized to the delta: run the whole api jest, and grep every spec and script for the old path and the old symbol before the reads are ordered. A census or allow-list that names files by path is edited in the same PR as the move.**
- **Guard:** `apps/api/src/products/variant-name-writers-census.spec.ts` (its allowed list now names the new file); the grep step is a lane habit with no script yet.

### L-393 · 2026-11-19 · deploy · the health commit equals the last merge that changed apps/api or packages, not the last merge (windows 51 to 56)

- **Symptom:** after a web-only merge, a close check compared the API health commit to the merge commit and read a stall: both API hosts still reported the earlier merge.
- **Root cause:** a web-only or docs-only merge does not rebuild the API; its status goes green in the same second it is created, so the health commit never moves.
- **Lesson:** **A close check compares the health commit to the last merge that touched `apps/api` or `packages/`, and reads the other merges by their own service statuses.**
- **Guard:** none in the repo (lead tooling); the window close script carries the rule.

### L-403 · 2026-11-23 · process · two failed fold rounds on one criterion mean the criterion gets a new spec before a third patch (#4441)

- **Symptom:** the purchase-order lot-line edit rule (a labelled line stays in whole packs on edit) took five fold rounds on #4441: whole-lot check, relabel on re-pack, exact remainder, stored pack carried on edit, product change refused. Each round fixed the case the reviewer named and the next read found a sibling path.
- **Root cause:** the criterion was patched one case at a time. No one wrote the whole table of edit paths (create, echo, re-pack, qty change, product change, receive) with the expected result of each, so every round tested only its own row.
- **Lesson:** **When a reviewer reports a second failed round on the same criterion, stop patching: write the full case table for the criterion (every writer and every path to the row, with the expected result) as a new spec, red on the current code, and fix to it in one round.**
- **Guard:** none automatic; the case table lives in `inventory.po-edit-whole-lot.spec.ts` (R-rows) and `inventory.po-receive-whole-lot.spec.ts`. Cf. [[L-377]].

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

### L-402 · 2026-11-22 · tooling · a gate that kills a long child on a time cap reports the timeout as a timeout, never as a genuine failure; the cap is overridable and sized for a loaded host (#4427)

- **Symptom:** the forced `turbo run test --force` in `campaign-check` had a fixed 15-minute cap. On a loaded host the api suite ran longer, `spawnSync` returned `ETIMEDOUT`, and the gate printed "genuine failure"; two pushes were refused on 2026-11-22, each after a 40 to 60 minute verify.
- **Root cause:** the gate read any non-success child result as a test failure. A killed child has no exit status of its own, so a slow run and a red suite looked the same.
- **Lesson:** **When a gate runs a child under a time cap, branch on the timeout first and say so (`TIMED OUT after N min`, still a refusal); keep "genuine failure" for a real non-zero exit. Size the default to the loaded host and let one env var override it (a positive integer; anything else is ignored).**
- **Guard:** `campaign-check-force-timeout.spec.ts` and `campaign-check-freshness.spec.ts` (#4427); `scripts/lib/campaign-force-run.cjs` holds the one parser.

### L-395 · 2026-11-19 · tooling · a guard that matches file names read from `+++ b/` diff headers decodes git's C-quoting (or takes names from `-z` output), and withholds any name git quoted (#4363)

- **Symptom:** the push guard printed, or failed to match, a path whose name held unusual bytes: git writes such a name in double quotes with octal escapes, and the `b/` prefix then sits inside the quotes.
- **Root cause:** the header parser took the bytes after `+++ ` as the name, so a quoted name was matched, and echoed, in its escaped form.
- **Lesson:** **Take names from NUL-separated output (`-z`) where git offers it; where only a header line exists, decode the quoting (octal bytes, backslash escapes, the prefix inside the quotes) before matching, and never print a name git quoted. A guard's output names shas and counts, not the text it matched.**
- **Guard:** `scripts/leak-check.self-test.mjs` cases for quoted and variant file names in hook and range mode (red before the round-1 fix); `parseHeaderPath` in `scripts/leak-check.mjs`.

### L-388 · 2026-11-15 · tooling · `gh run list --json conclusion` is the empty string, not null, while a run is in progress; map it to a marker explicitly and key timers by run id plus attempt (#4324)

- **Symptom:** a window's hang guard cancelled a healthy rerun of #4324: the lead's script read a tab-split row, the in-progress conclusion was `""`, and the field after it shifted.
- **Root cause:** `jq '.conclusion // "-"'` replaces only null and false, so the empty string passed through, and a whitespace-split read drops an empty field.
- **Lesson:** **Map an empty conclusion to `-` explicitly (`if . == "" then "-" else . end`), read rows as JSON rather than splitting on tabs, and key every timer by run id and attempt so a rerun gets its own clock.**
- **Guard:** none in the repo (lead tooling); the window script carries the explicit mapping.

## testing

### L-409 · 2026-11-25 · testing · a change that adds a call to an outside service greps every `*.spec.ts` and every `*.db.spec.ts` rig for its fake, and a billing or ledger PR needs a green Migration replay run at the sha before it merges (#4489, fixed by #4497, W-1338)

- **Symptom:** #4489 merged on a green Verify and broke `billing/trial-addon-checkout.db.spec.ts`: subscribe, upgrade and downgrade now list and expire the business's open Checkout Sessions first, and that rig's Stripe fake had no `checkout.sessions`. Fail-closed code turns a missing Stripe member into one coded 503, so the spec saw a refusal instead of an error naming the missing member.
- **Root cause:** the search for the service fake did not reach the SA-690 rig, which is a `*.db.spec.ts`, and "Migration replay" (`.github/workflows/db-migrations.yml`) is the only CI lane that runs DB specs, so Verify could not see it. Nothing required a Migration replay run at the merged sha for a billing PR.
- **Lesson:** **When a change makes existing code call an outside service (Stripe, mail, storage), grep every `*.spec.ts` AND every `*.db.spec.ts` for a fake of that service and give each the new members. Wrap such a fake in `strictFake` so a missing member is named at the end of the test, not read as a refusal later. A billing, ledger or other Tier 1 PR does not merge on Verify alone: the gate needs a green Migration replay run at the exact sha.**
- **Guard:** `apps/api/src/testing/strict-fake.ts` (`strictFake(target, name, misses)`, pinned by `testing/strict-fake.spec.ts`) wraps the Stripe fakes in `trial-addon-checkout.db.spec.ts`, whose `afterEach` asserts `fakeMisses` is empty. The Tier 1 gate requires a Migration replay run at the sha (a lead rule, not a repo file).

### L-396 · 2026-11-19 · testing · a change to a hook, or to a file a hook calls, runs every `*-script.spec.ts` that builds a hook fixture; a by-path review run misses them (#4363, fix round 2)

- **Symptom:** a push guard added as the first step of `.husky/pre-push` passed its own self-test and the by-path review runs, then CI Verify went red with 11 failures in two specs that drive the real hook in a temp repo.
- **Root cause:** each fixture copies only the files the hook used to call, so the new checker was missing and every push in them was refused; those specs were not in the by-path set.
- **Lesson:** **Before the read, list the specs that copy or run `.husky/*` (grep the hook name in `apps/api/src/common/*-script.spec.ts`) and run them with the hook change. A fixture that copies a hook must copy everything the hook calls, and a missing file refuses with a plain message, not a node stack.**
- **Guard:** the fixtures in `pre-push-trunk-script.spec.ts` and `skip-verify-audit-script.spec.ts` copy the checker and its lib, and each spec has a missing-checker case; `scripts/registry-root.self-test.mjs` lists the fixture. Cf. [[L-322]], [[L-323]].

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

### L-392 · 2026-11-19 · testing · a raw control byte typed into a regex literal makes a negative pin pass whatever the code holds (#4349, B1313)

- **Symptom:** twelve `not.toMatch` pins in ten spec files, and one till inventory pin, held a raw backspace byte (0x08) where a word boundary was meant, so each matched nothing and passed on any tree; three raw NUL bytes sat in a script as separators.
- **Root cause:** an editor or paste turned `\b` into the control character, the pin still read as a regex, and a negative assertion over a pattern that cannot match is always green.
- **Lesson:** **Write a boundary as the two-character escape, never a typed byte, and give every negative pin a probe that makes it match the thing it forbids (L-377). A source scan for control bytes (0x00 to 0x08, 0x0B, 0x0C, 0x0E to 0x1F, 0x7F) over every tracked text file, asserting it scanned files and with no exception list, is the standing guard.**
- **Guard:** the twelve pins were fixed in #4349 with a red then green probe each; the standing scan is owed (B1364).

### L-377 · 2026-11-12 · testing · a pin ships with a red probe the builder watched fail; a regex with a stray control byte matches nothing and passes whatever the tree holds (#4303)

- **Symptom:** the inventory pin that was meant to prove every till window is covered or excused could not fail: `CounterSaleScreen.escape-scan.test.tsx:259` holds a literal backspace byte (0x08) where `\b` was meant, so its file list was always empty. Both readers found it; the builder had not seen it fail.
- **Root cause:** the pin was written and run green once. A green pin proves nothing until it has been seen red on a tree that violates it.
- **Lesson:** **Every inventory pin or source-scan test ships with a probe the builder observed red (add the violating file, or remove the entry, and run it), and asserts that the scan found at least one file. A control byte in a pattern is read in a hex view of the line, not by eye.**
- **Guard:** none automatic yet; the corrected pin is owed in the counter lane's next PR (test-only). Cf. [[L-364]], [[L-322]]. Extended 2026-11-13 (B1324): the first overlap probe on the phone heading rise (spec 85 T9) read only settled pairs with both boxes in the window and passed on master while the bug stood; the strengthened probe reads the first frame after each scroll step and again settled, counts boxes below the window, and on master fails on the bug's own value (10 px: a 22 px hold over a 12 px gap). The replay cell also asserts its precondition (the section really is at rest) before it measures. Rule: a probe waits for nothing and measures at the moment the person sees it.

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

### L-404 · 2026-11-24 · domain · the year in every document number is the tenant's calendar year through one helper, and a repo-truth scan fails a minting file that reads the server clock (#4475, W-1199)

- **Symptom:** at 23:30 on 31 December in New York a UTC server minted 2027 for estimates, credit notes, returns, POs and bills while invoices said 2026.
- **Root cause:** the earlier fix moved the invoice year only; every other minting site read the server clock itself, and no list of the sites existed, so the fix reached the one named caller and left the other series on the old clock.
- **Lesson:** **When one number series moves to a rule, sweep every site that mints any series, route all of them through one helper that reads through the caller's own tx, and pin the class with a scan that fails a minting file that reads `getFullYear()`. A per-site fix leaves the next series on the old clock. Cf. [[L-223]].**
- **Guard:** `common/number-year.ts`; `common/no-server-clock-number-year.spec.ts` (repo-truth lane); `common/document-number-year.spec.ts` (the New York cases were red on master with 2027).

### L-405 · 2026-11-24 · domain · a cap on a credit reads the newest sale and prices it through the pool helper, never qty times unit price; a cap only lowers (#4462, W-1316)

- **Symptom:** a return of an item sold before credited today's higher price, more than the customer last paid.
- **Root cause:** the sold-before read only asked whether any invoice line existed ("ever sold?") and priced from the catalog; no read said what was paid last, and a boxed line cannot be priced as qty times unit price.
- **Lesson:** **A read added to answer "ever?" is not an answer to "what, last?": give the new rule its own read, newest invoice first, and price it through the shared helper (`lastPaidCapSubtotal`), where paid and $0 lines pool and boxed lines scale once. A cap returns null when it cannot price (no cap) and only ever lowers; the edit path refuses an override above it with the same figure the quote used.**
- **Guard:** `returns/inline-returns-quote.last-paid-cap.w1316.spec.ts` (red values taken on master), `returns/inline-returns-last-paid-cap.w1316.db.spec.ts`.

### L-406 · 2026-11-24 · domain · a refusal added to one write path is added to every write method of that entity, and a pin lists the methods; the check sits where the effect happens (#4479, W-1318)

- **Symptom:** a PO line written before the guard existed posted a stock lot and an item update against a FAMILY product at receive, although create, raise-from-bill and edit all refused it.
- **Root cause:** the helper was called by the writers that create or change lines; receive, the one that posts stock, was never listed. The first fix then checked every line before the qty <= 0 skip, so a PO holding a legacy zero-quantity FAMILY line could not receive its other lines.
- **Lesson:** **When a refusal is added to a write path, list every method of that entity that writes and pin the list in a spec that fails when one skips the helper. Put the check where the effect happens (quantity above 0 posts stock), not on the row, or a legacy zero row blocks the rest of the document.**
- **Guard:** `inventory/inventory.po-family-refuse.spec.ts`, `products/family-writers-tripwire.spec.ts`.

### L-401 · 2026-11-21 · domain · a background or send step that can fail writes a status the screen reads and tells the operator; a log line is not a report (#4381, #4372, #4399)

- **Symptom:** a recurring invoice whose auto-send email failed still wrote `SUCCESS`, so the card read "Succeeded" for an invoice nobody had been sent; a standing order that failed for any reason but one was only logged, the 06:00 run placed nothing and no one was told; a counter sale that did not email the invoice said nothing about why.
- **Root cause:** each step handled its failure with a warning log and went on to the success write, so the only record of the failure was a log nobody reads. Judging "did it work" from message text (or from the absence of a throw) hid the typed cause.
- **Lesson:** **Write the outcome after the step that can fail, from a typed code (`INVOICE_RECIPIENT_MISSING`, not message text): the status the card or run summary reads, and one operator notice per failed item per run. A step that committed its work before a later step threw is created, never failed. Declare a shared text such as a status prefix once in `@routeflow/types` and pin a single source.**
- **Guard:** `recurring-invoices.service.spec.ts` and `run-prefix-single-source.spec.ts` (#4381); `order-templates.customer-prices-unavailable.spec.ts` (#4372); `pickup-complete.complete-at-counter.spec.ts` and `invoice-reminder-email.recipient.spec.ts` (#4399).

### L-400 · 2026-11-21 · domain · a confirm the page shows is not enforcement; the server refuses without the ack field, under the lock (#4387, #4396)

- **Symptom:** the order page asked "edit anyway?" before an items save turned a sent invoice back into a draft, but any other caller of the same route (an older page, a script, a second tab with a stale read) reverted the invoice with no confirm.
- **Root cause:** the first PR put the rule only in the web: the read sent a flag and the page confirmed. The write route never asked for proof that the person had seen it, so the confirm was advice. A "changed since sent" test that compared the stored fingerprint to one stage only also listed an invoice emailed as a draft and later sent final with the same lines.
- **Lesson:** **When a screen confirms before a write has a side effect the person did not ask for, the route takes an explicit ack field and refuses without it (a coded 409 that names what would change), checked after the row lock and after the older refusals, with the exempt callers listed. The page sends the ack after the confirm and handles a 409 from a read that went stale by opening the same confirm with the server's numbers.**
- **Guard:** `orders.service.sent-revert-ack.spec.ts`, `order-edit-revert-set.ack.spec.ts`, `invoice-changed-since-sent.spec.ts` and `SentInvoiceEditConfirm.n2.test.tsx` (#4396).

### L-375 · 2026-11-12 · domain · a flag the middleware reads to route a browser is set by every path that starts a session, impersonation included (B1304)

- **Symptom:** "Sign in as admin" from a browser that also held a buyer session bounced `/dashboard` to `/login`: the guard read the browser as buyer-only.
- **Root cause:** `resolveOperatorPathGuard` trusts the `rf-op-auth` presence cookie, which a normal operator sign-in sets; `setImpersonation` stored the tokens but never set the cookie.
- **Lesson:** **Every code path that makes a browser an operator (sign-in, impersonation, any future switch) calls the one helper that sets the presence cookie, and every exit path clears it unless the browser holds operator tokens of its own. Test it through the real guard with no mocks of the helpers.**
- **Guard:** `lib/impersonation.presence.test.ts` (5 tests, real guard and helpers). Open: the automatic exits in `lib/api-client.ts` clear the tokens but not the cookie (see the register). Cf. [[L-369]].

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

### L-407 · 2026-11-24 · security · a redaction is applied where each transport stores its error, with one test per transport branch (#4473, W-1289)

- **Symptom:** staff saw a business's own mail server reply in "Email invoice", "Email reminder" and "Email statement", carrying a recipient's full address and a server IP.
- **Root cause:** every other transport stored `redactAddresses(message)`; the tenant SMTP branch had its own catch and stored the raw string, and no test read the text the staff user sees.
- **Lesson:** **Redact at the place the error is stored for the screen, not only in the log line, and give each transport branch its own test that asserts the staff-visible text. A transport added later with its own catch is a new unredacted exit unless a test names it.**
- **Guard:** `email/email.tenant-smtp-error-redact.w1289.spec.ts` (tenant fail with and without a platform transport, the statement 400, the log line).

### L-399 · 2026-11-21 · security · when a storage key is renamed, the reader drops the old key and logout clears it once; a fallback read keeps a signed-out person signed in (#4371)

- **Symptom:** a buyer who signed in with Google and then signed out was read as signed in again, and revisiting the portal showed it.
- **Root cause:** the Google callback still wrote the pre-namespacing `buyerAccessToken` key, the token reader fell back to it, and logout cleared only the namespaced keys. A second page read yet another key (`buyerToken`) that nothing writes, so its request went out with no Authorization header.
- **Lesson:** **After a storage-key migration the writer stops writing the old key, the reader stops falling back to it, and logout removes it once for browsers that still hold it. Every page reads the token through the one accessor, never by a key literal.**
- **Guard:** `apps/web/lib/buyer-auth.legacy-token.test.ts`, `page.code-only.test.tsx` (callback) and `page.merge-request.test.tsx` (settings), #4371.

### L-188 · 2026-09-17 · security · demo-booking OAuth/booking tokens in URL query strings

- **Symptom:** an OAuth/booking token traveled as a URL query parameter, the exact shape that ends up in server access logs, browser history, `Referer` headers, and analytics scripts.
- **Root cause:** a query string is the easiest place to carry a value across a redirect, but also the least private transport HTTP offers.
- **Lesson:** **Never carry an OAuth token, booking token, or any other bearer-shaped secret in a URL query string; use a fragment (`#`, never sent to the server) for a client-side handoff, or a POST body for a server-side one.**
- **Guard:** none yet; propose a lint/review checklist item flagging `token`/`code`/`secret`-named query params on any new route. Restored 2026-11-01 (it was archived on 2026-10-31 for room): this is a rule about RouteFlow's own routes, and the agent privacy rules cover what an agent does with URLs, not what the app puts in them.

## web

### L-408 · 2026-11-24 · web · a quantity box a scanner can type into holds its text until Enter, Tab or blur, then judges the whole text as one number (#4481, W-1336)

- **Symptom:** a 12-digit barcode scanned into a focused counter quantity box left a 4 or 5 digit quantity with no message.
- **Root cause:** the box committed on every keystroke and a scanner types digits as keys, so each prefix was a valid quantity and the last one accepted stayed.
- **Lesson:** **Where a scanner can type into a focused box, hold the text and commit once on a boundary through the screen's own commit path, refuse an out-of-range whole with one sentence, and clear the held ref before the commit so the blur after an Enter refocus finds nothing. Make the mode opt-in per screen; the order builder keeps per-keystroke commit. Cf. [[L-385]].**
- **Guard:** `use-held-qty.ts`; `CounterSaleScreen.qty-hold.test.tsx`, `CounterLineRow.qty-refusal.test.tsx` (a scanned code, Esc, Undo merge).

### L-398 · 2026-11-21 · web · a file input fires no change when the same file is picked again; clear its value after every pick (#4397)

- **Symptom:** an edited CSV re-picked from the same place kept the old File, and the next Preview ran on stale content.
- **Root cause:** the browser raises `change` only when the selected path differs, and the panel kept the first File in state; the first fix pass tested picking a different file.
- **Lesson:** **Set `input.value = ""` after reading the file on every pick, and test the second pick of the same file (a test that picks two different files proves nothing here).**
- **Guard:** `apps/web/components/import/ImportCsvPanel.repick.test.tsx` (#4397).

### L-397 · 2026-11-21 · web · a Next page file exports only page fields; helpers and components used elsewhere live in their own module (#4370)

- **Symptom:** `tsc` failed TS2344 on two pages (estimates and a platform-admin tenant page), and only in a tree that had a local `.next`; a clean checkout passed.
- **Root cause:** with `.next` present, tsc reads the per-page type guards Next emits, and a guard rejects any export that is not a page field. Two pages exported a date helper and a section component for other files to import.
- **Lesson:** **Move any non-page export out of a `page.tsx` (or layout, route) file into a sibling module before another file imports it, and read a type-check in a tree that has run `next build` or `next dev`, not only a clean one.**
- **Guard:** `apps/web/app/page-file-exports.static.test.ts` (fails on a page file with a non-page export; #4370).

### L-394 · 2026-11-19 · web · a scroll snap with inertia on reads its speed from the scrub's catch-up, not the hand, and throws a stopped scroll to a far beat; keep inertia off and drive the snap with real wheel input (#4367)

- **Symptom:** on the home wheel a flick that stopped inside the come-apart was thrown to the far end of the wheel about 1.5 s later (T9: 600 to 1118, then 1698).
- **Root cause:** with `inertia` on, ScrollTrigger's snap takes its velocity from the scrubbed timeline catching up to the page, which keeps moving after the hand has stopped, so it snapped to a beat in the direction of that stale speed.
- **Lesson:** **A snap on a scrubbed timeline sets `inertia: false` and lets `snapTo` settle on the nearest beat; a snap is proved with real wheel input and the snap switched on, because a test that sets `scrollTo` never feels the speed. A script writes the scroll position only after the person has stopped (a scroll-end wait), or it cancels their scroll.**
- **Guard:** `apps/web/e2e/84-site-proof-wheel.spec.ts` T9 (real wheel input, snap on; seen red at the middle commit with inertia on); the comment beside `snap` in `public/site/graphics/rf-wheel-up.js`. Cf. [[L-381]], [[L-392]] (the same PR repaired another raw-control-byte pin).

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

