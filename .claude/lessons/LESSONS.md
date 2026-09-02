# Lessons Learned — RouteFlow

> Generalizable rules this project has paid for. **Read this at the start of every major task,
> implementation, or bug fix** (alongside the code map) and cite entry ids when one changes your
> approach. **After every bug fix, append an entry** — Symptom / Root cause / **Lesson** / Guard —
> and bump [`_meta.json`](_meta.json); Gate 3 of [`../hooks/stop.mjs`](../hooks/stop.mjs) blocks
> fix-shaped turns that don't (a lesson-free fix bumps `_meta.json.updatedAt` to acknowledge).
> Caps: ≤ 40 active entries / ~25 KB — compact to [`ARCHIVE.md`](ARCHIVE.md). Maintained by the
> `lessons-learned` skill. Blameless; **never client names/slugs/document numbers** — the repo
> goes public briefly for CI.

## process

### L-041 · 2026-09-01 · process

- **Symptom:** 13 rows sat in `proven` — merged, deployed, post-deploy run already green — while
  every scoreboard counted them outstanding. Then the run cited as their proof turned out to have
  executed **nothing**.
- **Root cause:** two failures stacked. The proof fires off the deploy signal and lands after the
  session that merged the fix has ended, so the flip to `done` belongs to nobody. And the run
  everyone pointed at (a superseded deployment) reported conclusion **success with every real step
  `skipped`** — a green job that ran zero tests.
- **Lesson:** **When the evidence authorizing a state change arrives asynchronously, assign the
  flip — and when you read that evidence, read the STEP conclusions, never the job's.** A job is
  green when it is skipped, and a suite is green when a test is skipped; neither says your proof ran.
- **Guard:** `gh run view <id> --json jobs` — assert the specific step is `success`, not
  `skipped`; for one test, grep the log for its `✓`. Step COUNT is not execution.

### L-040 · 2026-09-01 · process

- **Symptom:** three ledgers for one campaign, three answers — machine ledger 61 rows shipped,
  hand-maintained HTML register 7 of those still open (one a Critical), prose summary 48.
- **Root cause:** only the machine ledger is written by tooling and read by a gate. The mirror is
  updated by hand at batch close-out — one batch did it, the next did not, and nothing compares
  the two.
- **Lesson:** **A status mirror that no gate checks is not a second source, it is a slower copy —
  derive every count from the machine ledger instead of quoting a summary.** The drift has a
  direction: it runs toward MORE open work, and nobody audits a number saying there is more left
  to do, so the error survives every review.
- **Guard:** none — `campaign-check` reads the ledger, the mirror has no equivalent. Count from
  `.claude/campaign/status/*.jsonl` (last state per row id) before repeating any figure. Same
  family as [[L-034]].

### L-035 · 2026-09-01 · process · #TBD

- **Symptom:** B120's POD archive was designed onto a generic `AuditLog` row; review found
  `RouteRunStop.podHistory` already existed, unused, with a schema comment naming the exact entry
  shape and the words "F10 wires the write".
- **Root cause:** an earlier enablement batch pre-added the column FOR this batch, and the design
  was drawn from the register's suggested fix without grepping the schema for what was already
  provisioned.
- **Lesson:** **Before designing where something is stored, grep the schema for a column addressed
  to your batch — the schema comment IS the spec.** Enablement batches leave columns waiting; a
  field with no readers is a contract, not dead weight.
- **Guard:** none — judgment. The mismatch also showed up as a blocker (the shared test mock had
  no `auditLog` model), so "the harness fights you" is a hint you are off the intended path.

### L-026 · 2026-09-01 · process

- **Symptom:** an approved fix spec instructed editing a root manifest field "because it pins three
  of the five modules". It pinned none of them; following the instruction would have ADDED three
  pins the scope never asked for.
- **Root cause:** the spec was written from an audit summary rather than from the manifests. Two
  further claims in the same five-line item were also wrong — one module was pinned _ahead_ of the
  framework's bundled version (the fix was a downgrade, not a catch-up), and a command it presented
  as a one-liner only accepts an interactive prompt.
- **Lesson:** **A spec's factual claims about a file are a hypothesis, not evidence — read the file
  before editing it, and report the correction rather than quietly conforming or quietly diverging.**
- **Guard:** none — judgment. A spec item naming a specific file + field is a cue to open that file
  first.

### L-027 · 2026-09-01 · process

- **Symptom:** with several sessions running in git worktrees, a repo-file gate was about to be
  satisfied by writing into a _different_ session's working tree — surfacing later as a mystery diff
  in someone else's PR.
- **Root cause:** worktrees are nested inside the main checkout, and hooks resolve their paths
  against that main checkout, not the worktree the session is working in. Whatever branch the shared
  checkout happens to be parked on is the file the gate points at.
- **Lesson:** **Never satisfy a gate by writing into whatever tree the hook happens to run from —
  defer the write to your own worktree and say plainly why. Keep the shared checkout on the
  integration branch; it is the only sane resting state for a tree that hooks resolve against.**
- **Guard:** none — judgment. A gate demanding a repo file while you work in a worktree is the cue
  to check which tree that path actually lands in.

### L-004 · 2026-08-24 · process

- **Symptom:** autonomous sessions stalled retrying merges and visibility flips.
- **Root cause:** the auto-mode permission classifier blocks `gh pr merge`, visibility flips,
  and prod-DB commands while the owner is away. It also reacts to the **session's recent shape**,
  not just the command: after a run of branch deletions it refused a read-only `git branch -r`,
  so the safe/unsafe boundary is not stable within a session.
- **Lesson:** **One clean attempt at a blocked command, then reorganize the work: open
  hook-verified PRs plus a written owner runbook — never retry or route around a block.** When a
  read-only command is refused, reach the same fact through another tool (`gh api …`), which the
  denial explicitly permits — that is redirection, not circumvention.
- **Guard:** none — judgment.

### L-008 · 2026-07 · process

- **Symptom:** production login broke after a commit titled as API-only security work.
- **Root cause:** a web-middleware change rode along in a commit scoped and reviewed as API-only.
- **Lesson:** **Never edit a layer outside the batch's stated scope — surface it and ask; a
  commit title must name every layer it touches.**
- **Guard:** none — judgment.

## tooling

### L-039 · 2026-09-01 · tooling

- **Symptom:** a green PR went red after a routine rebase, on a check unrelated to its contents —
  and its author could not fix it: the failing number is a policy threshold only the owner may set.
- **Root cause:** the gate shipped while the repo sat **71 bytes** under the cap it enforces.
  Correct gate, zero margin — so the next branch to append to the capped file inherits a failure it
  did not cause, and appending is exactly what the rules REQUIRE after a fix.
- **Lesson:** **Land a gate only with headroom, and only when its threshold is a number you are
  authorized to set.** At zero margin a gate is a tripwire for the next unrelated PR, not a guard;
  if the threshold is an owner's call, land the ruling with it or the gate blocks the project on a
  decision nobody scheduled.
- **Guard:** `validate-lessons` prints `binding:` and the remaining headroom every run — treat
  `~0 more` as unlanded work. Second-order cost: the run died at the gate, so everything its
  success path owned went undone and the repo was left **public** — a private flip that lives
  after a green CI is not a `finally`.

### L-038 · 2026-09-01 · tooling

- **Symptom:** a five-pin change arrived as a 592-line lockfile diff — 185 entries of
  `{"devOptional":true}` → `{"dev":true}` with zero version changes — alarming any reviewer
  reading it cold.
- **Root cause:** a bot-authored dependency PR is generated by a foreign package-manager client
  and merged as-is, so the next PR to touch the lockfile regenerates it with the repo's pinned
  `packageManager` client and normalizes all of it back. The churn is paid by an innocent later
  PR, not the one that caused it.
- **Lesson:** **Regenerate a bot-authored lockfile with the repo's pinned package-manager client
  BEFORE merging that PR — otherwise its foreign shapes ambush the next author, whose only
  alternatives are a huge diff or hand-editing a lockfile no client would produce.**
- **Guard:** none — `validate-lock` passes either way, since the shapes are equivalent. Verify a
  lockfile rebase by version-change count (`0`), never by diff size.

### L-034 · 2026-09-01 · tooling · #TBD

- **Symptom:** `campaign-check` red on another batch's rows after a rebase, and a mutation probe
  that reported nothing. Both were reading an artifact no run had refreshed.
- **Root cause:** the campaign artifact is written by a jest REPORTER, so it only refreshes when
  jest actually EXECUTES. Repo-root ledger files are not hashed inputs (`globalDependencies` is
  the lockfile plus package manifests; the test task's `inputs` are `$TURBO_DEFAULT$`), so a
  rebase cannot bust the cache — turbo replays a green summary and the stale artifact survives.
  Scoped runs (`jest -t REG-B##`, one per mutation probe) narrow it to just those tests, and a
  cache-replayed "full suite" afterwards does not overwrite that.
- **Lesson:** **A generated artifact is evidence only when you can name the tool and the run that
  produced it.** Extends [[L-009]]: a cache replay does not merely fail to prove the tests ran —
  it silently PRESERVES whatever the last scoped run wrote. Same shape as regenerating a lockfile
  with the wrong npm major: the diff reads as content drift when it is tooling drift.
- **Guard:** force execution (`turbo run test --force` or direct `npx jest`), then assert the
  artifact's mtime post-dates the change, before reading any gate that consumes it. Freshness is
  verified, never inferred from a green summary.

### L-032 · 2026-09-01 · tooling

- **Symptom:** forcing a transitive past a parent's exact pin failed twice, each time silently.
  First: adding the root `overrides` pin and regenerating with `--package-lock-only` left the
  hoisted entry on the OLD version — a no-op fix for a no-op fix. Then: deleting just that one lock
  entry and regenerating DID move it, and **broke every file upload in the process**, with no error
  anywhere — requests returned 201 and the file was simply absent.
- **Root cause:** two distinct properties of npm, both invisible in a green build. (1) An override
  applies only when npm **resolves** an edge; `--package-lock-only` keeps pre-existing subtrees that
  predate the pin. (2) Deleting a package's lock entry without its `node_modules/<pkg>/node_modules/*`
  children orphans them: the nested `type-is` survived, its nested `media-typer@0.3.0` did not, so
  `type-is` silently fell through to an incompatible root-hoisted `media-typer@1.1.0`, stopped
  recognising `multipart/form-data`, and multer skipped every request without complaint.
- **Lesson:** **Adding an override is not applying it, and pruning a lock entry prunes a subtree.
  Remove the WHOLE `node_modules/<pkg>(/…)*` family, run a real `npm install` (never
  `--package-lock-only`, which builds an ideal tree it never has to make work), then assert three
  things separately: the hoisted version moved, `validate-lock` reports `skew 0 new`, and the
  library still does its job.**
- **Guard:** `multer-field-limits.security.spec.ts` — it resolves multer from
  `@nestjs/platform-express`'s own directory and asserts >= 2.3.0, and it exercises a real
  multipart request end-to-end, which is what actually caught the orphan. `validate-lock` names the
  skew directly (`media-typer: found 1.1.0, wanted 0.3.0`), so it is a gate failure, not a mystery.

### L-028 · 2026-09-01 · tooling

- **Symptom:** a grouped dependency bump advertised a security update for a file-upload library. The
  PR title, changelog and lockfile diff all showed the new version — and every upload path kept
  running the old one, advisories intact.
- **Root cause:** a framework package declared that library at an **exact** version, so the hoisted
  copy stayed pinned there; the bump installed the new version only nested under one workspace,
  which nothing imports from. A version appearing in the lockfile says it was installed, never that
  it is what resolves at a call site.
- **Lesson:** **A dependency bump is proven by what RESOLVES at the call sites, not by the lockfile
  diff — for any security bump, check whether a parent's exact pin holds the hoisted copy, or the
  merge closes the ticket without closing the hole.**
- **Guard:** none yet — inspect the hoisted entry (and any parent's exact pin) before believing a
  security bump. The check that settles it is the **resolution**, which holds whatever the install
  state is:
  `node -e "console.log(require.resolve('<lib>',{paths:[require('path').dirname(require.resolve('<parent>/package.json'))]}))"`.
  ⚠️ A version string read out of `node_modules` is **not** independent confirmation: a tree that
  predates the bump's install reads the old version for the trivial reason that nothing installed
  the new one. Both this entry's author and its first reader made exactly that substitution within
  hours of filing it — **having written a rule makes you quicker, not slower, to accept a reading
  that confirms it.** Note the fix for this class is a root `overrides` pin, which [[L-012]]
  otherwise forbids: `overrides` is the only mechanism that beats a parent's exact pin on a
  **runtime** transitive, so state the exception in the PR or the next reader reverts it as a
  violation.

### L-010 · 2026-08-29 · tooling

- **Symptom:** one workspace's tests "failed" under verify while the same code passed everywhere
  else.
- **Root cause:** worker exhaustion under host load — the task exited 1 with **no test report at
  all**; nothing ever ran.
- **Lesson:** **A bare non-zero task exit with no test report is environmental — re-run that
  workspace directly before debugging; CI on clean runners is the authoritative gate.**
- **Guard:** none — judgment (triage: direct `npx jest`, then filtered turbo).

### L-011 · 2026-08-25 · tooling

- **Symptom:** phantom `X does not exist in type` errors on correct code; pre-push blocked.
- **Root cause:** the generated Prisma client was stale after pulling a schema change — and
  `npx prisma generate` writes to the **shared root** `node_modules`, so parallel worktrees
  clobber each other's client.
- **Lesson:** **Regenerate the Prisma client after any pull/checkout/rebase across a schema
  change, and expect all worktrees to share one generated client.**
- **Guard:** none — judgment.

### L-013 · 2026-08-17 · tooling

- **Symptom:** three of four CI jobs red on a dependency error the change never introduced.
- **Root cause:** the failure was at the _install_ step (registry flake), not the job's own
  command; separately, 0-step ~3 s "failures" while private are Actions billing, not the suite.
- **Lesson:** **Read which step failed before hunting a code fix — an install-step or 0-step red
  proves nothing about the change; rerun first.**
- **Guard:** none — judgment.

## testing

### L-036 · 2026-09-01 · testing · #TBD

- **Symptom:** a transition deny-list whose every (from,to) pair was verified correct — by unit
  assertions AND by adversarial refuters — was defeated by two individually-legal PATCHes:
  `COMPLETED → IN_PROGRESS` (a documented allowance) then `IN_PROGRESS → SCHEDULED` (never
  denied) re-scheduled a completed run, the exact state the matrix's contract forbids.
- **Root cause:** the matrix is EDGE-wise, and so was every oracle pointed at it. Verifying each
  edge in isolation is structurally incapable of finding a composite path; no amount of care
  inside the matrix would have caught it.
- **Lesson:** **When the artefact under test is a state machine, the oracle must walk PATHS, not
  edges.** Ask which multi-step sequences compose into a forbidden state, and guard on durable
  evidence outside the transition (here `completedAt`, which the endpoint only ever sets) rather
  than on the current status.
- **Guard:** `REG-B72 (T22)` walks the two-step path and pins that a never-completed run still
  schedules normally; disabling the guard turns it red.

### L-025 · 2026-09-01 · testing

- **Symptom:** native Google Sign-In had been dead the whole time — the callback destructured a
  `default` export `expo-secure-store` does not have, so token storage threw on every device.
- **Root cause:** the throw sits inside a `!isWeb` branch. Every automated surface runs the web
  build, which takes the `localStorage` branch, so nothing ever executed the failing line. This is
  narrower than L-019: no native _module_ misbehaved — ordinary JS was shielded by a platform
  conditional.
- **Lesson:** **A `Platform`/`isWeb` branch is untested code unless something runs that platform.
  When you touch one side of such a branch, either exercise the other side or state plainly that
  it is unverified.**
- **Guard:** none — judgment. Grep `isWeb`/`Platform.OS` in any file a fix touches.

## deploy

### L-016 · 2026-08-29 · deploy · #475

- **Symptom:** (caught pre-merge) four endpoints would have 403'd for every tenant on deploy day.
- **Root cause:** a server-side `@RequireAddon` gate keyed on an addon that no shipped UI or SKU
  activation could grant.
- **Lesson:** **An entitlement gate with no way to GRANT it is a self-inflicted outage — for
  every new gate: which UI grants it, does activation write THAT key, what happens to existing
  users on deploy day?**
- **Guard:** gate checklist in feature-plan P4; legacy-key → SKU bridge.

## domain

### L-037 · 2026-09-01 · domain · #TBD

- **Symptom:** the fix for a reopen that wrongly credited stock still left the reopen billing the
  delivery it had just undone — `OrderItem.deliveredQty` survived the reversal, and the
  delivered-basis invoice reconcile bills exactly that field.
- **Root cause:** the reversal was corrected for the field the bug report named and no other. The
  forward path wrote `deliveredQty` unconditionally (whether or not money changed hands) while the
  reversal reset only `status`.
- **Lesson:** **A reversal must enumerate every field the forward operation wrote, not just the
  one the bug report named** — and state, per write, whether it is undone by REVERSAL or covered
  by REFUSAL (blocking the operation while that state stands). Those are different strategies and
  the mix must be deliberate. ⚠️ Note the coupling: the new refusal guard is what made the
  reversal gap REACHABLE, so a fix can open the path to a latent bug.
- **Guard:** `REG-B55 (T21)`; the write-by-write enumeration is recorded in F11's fix card so the
  next batch on this path starts from it rather than rebuilding it.

### L-029 · 2026-09-01 · domain · #588

- **Symptom:** cancelling an order destroyed value three ways at once — it voided the invoice for
  goods already delivered, never returned the creation-time stock decrement, and its sibling
  `deleteOrder` skipped the regulated-ledger reversal both other invoice-destruction paths
  performed. All three had shipped green.
- **Root cause:** the conservation rules were built for the **edit** path and the **teardown**
  paths were simply never enrolled in them. Every signal each fix needed already sat in the same
  file — the delivered-qty clamp, the reversal call — and was not consulted. Nothing failed
  loudly, because a conservation law has no natural test: stock is only wrong much later, and
  nowhere near the cancel that caused it.
- **Lesson:** **When a codebase establishes an invariant on one path, enumerate every OTHER path
  that reaches the same state and enroll it explicitly — an invariant with a known exception is a
  bug with a scheduled date.** Search by the STATE being mutated (who else deletes an invoice, who
  else writes `order.status`), never by the feature name: the violating paths are the ones that
  never mention it.
- **Guard:** `orders.lifecycle-conservation.spec.ts` + its pins spec, 9 mutation probes. The same
  search immediately found two more instances, recorded not fixed: `routes.service.ts` has **five**
  `order.status` writers and only one runs the invoicing side effects (→ F11), and the customer
  purge is a **fourth** `reverseInvoiceEntries`-skipped hard delete — at four instances the answer
  is a shared guard, not a fourth point-fix. See [[L-008]] for why they stayed out of scope.

### L-030 · 2026-09-01 · domain · #588

- **Symptom:** the fix for the above introduced a NEW conservation bug. A DRAFT cancel correctly
  credited no stock (a draft never decremented) but still marked its line items CANCELLED, and
  `reopenOrder` re-decremented every marked line — so a draft's cancel→reopen round trip
  understated stock by the full order quantity.
- **Root cause:** the marker recording "this cancel gave stock back" was written unconditionally
  while the give-back itself was conditional. Two halves of one decision, written as two
  independent statements that happened to agree in the common case.
- **Lesson:** **When one write is the RECORD of another write having happened, bind both to a
  single named condition — not to two conditions that agree today.** A reader (and a reviewer) can
  check one boolean; they cannot check that two predicates are equivalent in every state.
- **Guard:** `REG-B64 (T7)` asserts a DRAFT cancel neither credits stock nor marks its lines;
  mutation probe 3 (make the mark unconditional) turns it red.

### L-031 · 2026-09-01 · domain

- **Symptom:** a bug report (written from a review lens's own finding) named `deleteCustomer` as
  destroying invoices without reversing their regulated-ledger entries. Reading it on master, that
  site cannot destroy an invoice at all — its hard-delete path is only reached when the pre-flight
  counted ZERO invoices. Meanwhile two sibling paths in the same file, named nowhere in the report,
  destroy invoices freely: one blocks only PAID/SENT (so it deletes DRAFTs), the other has no
  invoice guard whatsoever.
- **Root cause:** the finding was recorded by pattern-match — "invoice.deleteMany with no ledger
  call nearby" — without evaluating the guard that decides whether the block is reachable. The
  pattern was real; the location was wrong, and the two worse instances were missed because they
  did not match the grep as cleanly.
- **Lesson:** **A reported location is a hypothesis, not a finding. Before fixing, re-derive which
  call sites can actually REACH the bad state, and sweep the whole file for siblings — the
  reachable ones are often not the reported one.** Fixing the reported site alone would have
  shipped a green test over an untouched leak.
- **Guard:** `customers.purge-ledger.spec.ts` covers all three sites and pins the reversal-before-
  delete ordering. Second-order fact worth keeping: **a DRAFT invoice already carries ledger rows**
  (`createSplitInvoices` writes them in the transaction that creates the DRAFT), so "we only delete
  drafts" never justifies skipping the reversal. Same family as [[L-029]].

### L-021 · 2026-08-12 · domain · #335

- **Symptom:** receiving a vendor bill 500'd (P2025) on real data despite green unit tests.
- **Root cause:** nested-created child rows carry NULL `tenantId` (nested writes bypass the
  tenant proxy's create-injection), so tenant-scoped child updates can never match them.
- **Lesson:** **In tenant-scoped services, write child rows THROUGH the parent's update — and
  audit any direct per-child write for the NULL-tenantId class.**
- **Guard:** single-helper pattern (`lineInventoryDelta`); class flagged for review.

## security

### L-044 · 2026-09-02 · security

- **Symptom:** four fixes in one batch were "protected" by things that had never once done
  anything — a log-only APP_GUARD that read `req.user` before any route guard populated it (never
  fired), and a green unit test asserting a DRIVER _may_ write a price override (it asserted the
  bug).
- **Root cause:** a guard that always returns `true` and a test that always passes are
  indistinguishable from working ones; nobody had asked what would turn either red.
- **Lesson:** **Green is a claim, not evidence. Before inverting a requirement, grep the suites
  for a test that asserts the OLD behaviour (it passes on the bug — invert it, don't route around
  it); before trusting a side-effect-only guard or interceptor, name the input that makes it act
  and prove that input exists at that point in the pipeline (APP_GUARDs run before route guards,
  so `req.user` is never set there).**
- **Guard:** `REG-B132` (the inverted test) and `REG-B165` (`impersonation.guard.spec.ts` header
  case with `req.user` undefined); mutation probes in the F14 PR body.

### L-033 · 2026-09-01 · security

- **Symptom:** the version bump that "fixed" a High-severity DoS advisory left the vulnerability
  fully exploitable on every endpoint, even once the upgrade genuinely landed.
- **Root cause:** the upstream fix was a new **opt-in** option (`fieldArrayIndexLimit`), gated on
  `hasOwnProperty` and defaulting to `Infinity`. Nothing changed for a caller who upgraded and
  passed the same options as before. Two further layers had to be crossed before it worked at all:
  the framework's own closed `limits` type had no such key (a fresh object literal would not
  compile), and the framework's error mapper had never heard of the new error code, so the guard
  firing produced a 500 and a monitoring capture per request instead of a 400.
- **Lesson:** **Upgrading past a CVE is not mitigating it. Read the upstream fix and ask whether it
  is a new DEFAULT or a new OPTION — and if it is an option, trace it the whole way: does it
  typecheck, does the framework forward it, and what does the caller actually receive when it
  fires?**
- **Guard:** `multer-field-limits.security.spec.ts` asserts the rejection is a 400 end-to-end, and
  proves the guard is load-bearing by showing the same request succeeds without it.

### L-024 · 2026-09-01 · security

- **Symptom:** the obvious plan — restrict the one Maps key to the Android app — would have taken
  down server geocoding, address autocomplete and every browser map at once.
- **Root cause:** one key served three call origins (Android app, Railway server, browser), and a
  cloud API key accepts exactly **one** application-restriction type. The key had to stay
  unrestricted because the API deliberately re-serves it to browsers at runtime.
- **Lesson:** **One credential per call origin. Before restricting any shared key, enumerate who
  calls it and from where — a key with both a server and a browser origin can carry no application
  restriction at all until the callers are split.**
- **Guard:** three-key model recorded in memory `project_maps_key_architecture_2026-09-01`;
  `docs/plans/maps-key-split-note.md` is STALE and must not be followed verbatim.
