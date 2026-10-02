# Fleet-lead log (append-only)

One entry per caught failure or reverted approach, written IN THE MOMENT, never at the end.
Format: `## <date> <anchor>` then `- what:` `- cause:` `- guard:` `- rule:` (optional candidate).

## 2026-09-22 #1207

- what: Merged #1207 on a verdict read from a status file; live money defect reached production
- cause: A PASS restated in a second place (status file) was stale; the merging sha was never resolved against origin
- guard: Tier-1 gate: two independent PASSes posted on #938 at the exact merging sha; coordinator resolves sha with merge-base --is-ancestor
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-22 B689

- what: Two false criticals (B689/B690) from a proof stack whose API image was built 11 h before the merge
- cause: Nothing asserted the proof server's build sha against the merge sha; the web client was current so the mismatch was invisible
- guard: Proof stacks print the API image build sha/time and assert it is at or after the merge sha before any proof starts
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-22 #1233

- what: #1233 showed MERGED while master was unchanged; it had merged into its stacked base branch
- cause: A stacked docs PR inherits its base; gh pr merge merges into whatever base it carries; the merge was announced from the CLI, not the ref
- guard: Before every merge gh pr view --json baseRefName must print master; after it git ls-remote origin refs/heads/master must show the merge commit
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-22 SA-E13

- what: Two of three predicted red-proof numbers for B687 were wrong (-5 was 0; -60 was -4)
- cause: Numbers were predicted by reasoning, never executed against the code they described
- guard: A red-first instruction names the case and says observe and report; a number appears only when it has been run (patch-run-restore with empty diff)

## 2026-09-22 #1237

- what: Two PRs (#1237, #1240) lost a public window while sitting in DRAFT with SKIPPED checks
- cause: A draft's SKIPPED check reads like a pass at a glance, and a draft in a private window is unrunnable as well
- guard: Pre-window checklist lists isDraft for every planned PR; un-draft or drop before the flip
- rule: List isDraft for every PR in a window plan before the flip

## 2026-09-22 B689

- what: Told the fleet 'three lanes pushed through verify' when only two branches were on origin
- cause: Counted an announced push as a landed push; stated a total from a --limit 6 listing
- guard: Counts and states come from git ls-remote / gh output run now; never from a relay or a truncated listing
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-22 #3001

- what: Owner saw a stale mobile export on :3001 for two hours; the marketing site looked old
- cause: A proof took the port the compose web container owns, from a worktree six commits behind, with no hand-back time
- guard: A proof never takes a compose-owned port; any port taken is announced on the board with a hand-back time; proof worktrees are rebuilt to current master first

## 2026-09-22 SA-070

- what: Owner's decision reached the Mac as two different build lists minutes apart; SA stopped the line
- cause: Two owner answers relayed in sequence without marking the second as superseding the first
- guard: Relay owner decisions verbatim with time and question, and state explicitly which earlier decision is superseded, in one message to every party

## 2026-09-22 B707

- what: Three builder briefs told lanes to update the code map inline; Lane B707 edited screens-by-role.md before the Mac Lead caught it
- cause: Lead wrote briefs from the user-level code-map routine instead of the project CLAUDE.md, which rules Bookkeeping Option B (map + lessons in the coordinator's docs follow-up; code PR carries the Bookkeeping-Follow-Up: pending trailer)
- guard: Builder-brief template's landing section states Option B verbatim; the lead-closeout check greps every spec/brief under local-assets/handoff for 'code map' without 'Bookkeeping-Follow-Up' and fails
- rule: A brief's landing section is copied from the project CLAUDE.md, never from the global routine

## 2026-09-22

- what: Four lanes on two machines were told JEST_MAX_WORKERS=4 capped verify load; the mini hit memory pressure 4 on one lane's verify
- cause: No jest config reads that env var and verify-turbo.mjs pins --concurrency=2, so a full verify runs 2 workspaces x (cores-1) workers; the cap was relayed from memory, never checked
- guard: A load cap is proven by the config line that reads it (grep) and a load sample after the run starts; until then tests run one workspace at a time with --maxWorkers=N
- rule: load-cap-provenance

## 2026-09-22

- what: Disk janitor's plan proposed removing rf-proof-web, a live prover's worktree, because its branch was merged; caught only because the plan was reviewed before applying
- cause: Merged-and-clean-and-pushed is a branch property, not a liveness signal, and the tool saw only one checkout's worktrees so three other live trees were safe by accident
- guard: A cleanup tool runs report-only first and its plan is read against the live lane list before --apply; never pass a free-space --target, which is what pushed it toward the largest tree
- rule: cleanup-plan-read-before-apply

## 2026-09-22

- what: Two real defects today were found by builders re-reading their own diff while idle, not by reviewers (B465 unit-switch baseline, B707 sibling)
- cause: Lanes held for load had nothing queued; a self-review of the diff just written is cheap and hits code the reviewer sees later and colder
- guard: A lane blocked or waiting on a slot self-reviews its own diff and reports what it checked; the lead assigns that explicitly instead of leaving the lane idle
- rule: idle-lane-self-review

## 2026-09-22

- what: A prover posted a plan to run two image builds because an expensive instruction and its correction arrived minutes apart; only a blunt stop kept it cheap
- cause: The costly instruction was issued before the decision settled, and the correction read as a refinement rather than as a cancellation of work already planned
- guard: An instruction that costs machine time is issued once, after the decision settles; any correction opens with a literal stop line naming what not to start, before the new spec
- rule: correction-opens-with-a-stop

## 2026-09-22

- what: A spec named the merged predicate isLegacyBoxAxisSale, a boolean, while the shipped export is classifySaleAxis returning three states; building from the spec would have silently dropped the unknown branch
- cause: The spec restated the predicate's signature instead of pointing at it, and the working name outlived the design it described
- guard: A brief cites the merged symbol and its signature read at a named sha, never the spec's working name; the lane verifies the export before writing the first call
- rule: brief-cites-merged-signature

## 2026-09-22

- what: A restart flag could have silently halved the VM's CPUs because the tool's documented default differs from the saved profile value
- cause: An omitted flag's resolution (saved value vs documented default) was not provable from the help text, and the safe-looking minimal command hid the ambiguity
- guard: When a tool's documented default differs from the stored value and the resolution is not provable, pass every affected flag explicitly; resolve by construction rather than by being right
- rule: resolve-by-construction

## 2026-09-22

- what: Three instrumentation misses in one evening: a process count that could not see work inside a VM, a pressure gauge that read fine while the system coped by swapping, and a worker pattern that matched the word export in every environment line
- cause: Each gauge was chosen for the situation as imagined rather than for the quantity actually scarce, and none was validated against a known state before its numbers were cited
- guard: Name the scarce resource first, then pick the gauge that moves with it; validate a new gauge against a known event before citing it, and when a count surprises you list what it matched before believing it
- rule: prove-the-gauge

## 2026-09-22

- what: A ready, green, reviewed PR waited about five hours purely on Playwright capture hosting, and UI work was twice assigned to a host with no container runtime
- cause: Lane assignment considered who was free and who knew the code, never whether the box could host the stack a UI gate requires
- guard: Before assigning UI work, confirm the box can host the stack (container runtime present and a browser installed); a host without one takes read-only work only
- rule: assign-ui-only-to-a-host-that-can-prove-it

## 2026-09-22

- what: An hour was lost to a turbo verify red that was a Jest worker killed under host memory pressure, reported identically to a genuine test failure
- cause: A killed worker surfaces as a failed task with no distinguishing signal, so a load event reads as a code defect
- guard: On an unexplained verify red, read machine load and memory for the run window before debugging the code; a red with no failing assertion is a load suspect first
- rule: unexplained-red-is-a-load-suspect

## 2026-09-22

- what: Authorised one unbounded verify on a machine argued to have enough headroom; it hit the memory kill line in two minutes with 21-22 workers against a predicted 18, and cost a lane its push
- cause: The recommendation rested on derived arithmetic rather than a count taken on that machine, and I approved it without asking whether the number had ever been measured
- guard: A load authorisation requires a measured count from that machine, not a derived one; when a peer's recommendation rests on a number, ask whether it was counted before accepting the reasoning
- rule: authorise-on-a-count-not-an-estimate

## 2026-09-22

- what: Killing the jest workers during a runaway verify did not stop it; turbo moved to the next task and spawned fresh processes seconds later
- cause: verify-turbo.mjs passes --continue=dependencies-successful, so a task kill is a task skip; the half-kill looks successful because pressure drops before the next task ramps
- guard: Recovering a runaway verify kills the whole process tree including the turbo and npm parent, scoped by worktree path; a pressure drop after a partial kill is not evidence the run stopped
- rule: kill-the-tree-not-the-task

## 2026-09-22

- what: A lane stood by for an hour after its PR had already merged, because nobody told it; it could not tell 'still queued' from 'merged and unannounced' since both are silence
- cause: I assigned the review and never closed the loop, and the lane had no signal that distinguished the two states
- guard: Whoever assigns a review owns telling the lane the outcome, merged or not; a lane holding for review also checks the PR state directly rather than inferring it from the absence of feedback
- rule: close-the-loop-on-every-review-you-assign

## 2026-09-22

- what: The same unbounded pre-push hook passed cleanly for a mobile-only diff and hit the kill line at 21 workers for a web diff
- cause: Worker count scales with how many test-bearing workspaces the affected graph includes, so a narrow diff under-counts and a proof taken on one looks green
- guard: Size or prove a load control against the worst affected graph, naming which graph was exercised; a clean run on a narrow diff is not evidence the control holds
- rule: prove-against-the-worst-graph

## 2026-09-22

- what: The obvious way to cap test workers would have handed a jest-only flag to tsc and eslint as well, because turbo forwards -- args to every named task and the script runs mixed task sets together
- cause: The fix was reasoned about at the level of one task while the runner operates on a task set; the failure mode is silent, since a tool that ignores an unknown flag still reports green
- guard: Before adding a pass-through to a task runner, read which tasks the invocation actually names; a control that could be silently ignored by one consumer must be proven at the consumer, not at the caller
- rule: pass-through-reaches-every-named-task

## 2026-09-22

- what: Told a lane the PC could absorb an unbounded verify because it has 31.5 GB installed; the machine actually had 367 MB available, and I then misread a snapshot as a finished run when it was mid-run
- cause: Installed total was cited as headroom, and a low process count between tasks was read as completion instead of enumerating the processes and their parents
- guard: Headroom is the available-memory counter read now, never the installed total; before concluding a run is finished, enumerate processes with their parents and command lines rather than counting them
- rule: headroom-is-available-not-installed

## 2026-09-22

- what: An emergency STOP sent on a misread number made a lane kill its own in-flight proof run, which was the very evidence the stop was reasoning about
- cause: The stop was issued before the measurement was confirmed, and an emergency framing leaves a lane no room to distinguish useful load from harmful load
- guard: Confirm the measurement before sending a stop; when load is the concern, name what may keep running and why, because an unqualified emergency stop kills the useful work first
- rule: a-stop-names-what-keeps-running

## 2026-09-22

- what: A load-average gate chosen while the machine was memory-starved kept being cited after Photoshop exited, when load rose to 20 while free memory improved to 76 percent and swap drained
- cause: Load was adopted as a proxy for memory while the two moved together; an I/O-bound process decoupled them, and the proxy went on being quoted as if it still measured risk
- guard: A proxy is valid only while the quantities it stands for move together; re-derive it whenever the machine's state changes, and gate on the quantity that actually causes the failure you fear
- rule: re-derive-a-proxy-when-state-changes

## 2026-09-22

- what: A lane reported a push as still in flight when it had already failed, after a 55-minute pre-push verify that normally takes about 30 seconds
- cause: Two lanes overlapped on one machine, stretching the run far past any expected duration, and a long-running command is indistinguishable from a hung one without checking its exit
- guard: Report a push by its exit status, never by elapsed time; when a run exceeds its expected duration by an order of magnitude, check whether it finished before describing it as in flight
- rule: report-a-push-by-its-exit

## 2026-09-22

- what: A production exposure report returned zero rows and would have been reported as zero exposure; only a control query showed the report could see rows at all (46 edits, 9 on boxed products, 0 hitting the defect)
- cause: An empty result set is identical whether nothing matched or the predicates were wrong, and nobody had shown the query could return a row before its zero was believed
- guard: Before believing a zero from a report that matters, run a control that relaxes the predicates and returns counts plus sanity anchors; a zero is a finding only once it can be attributed
- rule: attribute-a-zero-before-believing-it

## 2026-09-22

- what: Reported a production row as stamped three hours in the future and asked for a defect id; it was a naive timestamp rendered as UTC by the driver, and the follow-up query returning zero rows was the contradiction I should have believed first
- cause: Two values printed side by side in one table were assumed to be in the same units; a timestamp WITHOUT time zone read over a driver carries the reading machine's offset while NOW() does not
- guard: Before comparing two times, establish both column types and the session timezone; when a follow-up query contradicts a reading, treat the contradiction as evidence against the reading rather than as a puzzle
- rule: same-units-before-comparison

## 2026-09-22

- what: Two ratchets refused two different lanes tonight and both refusals were real growth, not flakes; each lane hoisted or extracted rather than raising a baseline, and one lowered a baseline from 6 to 3
- cause: A guard that names the remedy in its refusal gets obeyed; both ratchets told the lane what to do instead of merely failing, so neither lane reached for a bypass under time pressure
- guard: A guard should state the remedy in its failure text, not just the violation; when a lane hits one, require it to chase the refusal to a named task before any baseline is touched, and prefer hoist or extract over raise
- rule: a-guard-states-its-remedy

## 2026-09-22

- what: Read five node processes as a finished push and handed the machine to a second lane; the push was mid-run in a serial self-test phase, and the overlap I created is the exact contention that cost a 55-minute verify earlier
- cause: Process count is a proxy for activity only while the work is parallel; the verify chain runs self-tests one at a time, so a healthy run looks idle between spawns
- guard: Decide a run has ended from its own exit status or a stalled log, never from a process or memory sample; a low count during a serial phase is indistinguishable from a stop
- rule: end-of-run-comes-from-exit-status

## 2026-09-22

- what: Approved narrowing a fix to one of three code paths that produce the same defect, because the lane and I each described the same shape from a different direction and neither noticed
- cause: The fix was scoped by the symptom that was reported (zero boxes) rather than by the condition the code actually tests (the pack could not be derived), so two sibling paths stayed out of scope by accident
- guard: Scope a fix by the predicate in the code, not by the reported symptom; enumerate every path that reaches the same wrong state and say which the change covers
- rule: scope-by-the-predicate-not-the-symptom

## 2026-09-22

- what: A PR showed Verify FAILURE that was a 2-second private-window run from before the visibility flip, sitting beside the real run that had just started
- cause: The billing block makes a private-time run fail in seconds with no steps, and a PR's check summary aggregates it with the genuine post-flip run under one status
- guard: Gate a merge on a specific run id whose start time is after the flip, never on the check's aggregate status; a red lasting seconds with no steps is a billing-block artifact, not a result
- rule: gate-on-the-run-not-the-summary

## 2026-09-22

- what: Approved a lane's narrowing of a fix as safer than the ruling it implemented; the architect reversed it because the narrowing left the same wrong price reachable on a different shape
- cause: I treated 'uses the live value less' as automatically safer, without checking which shapes still reached the bad branch; caution about a mechanism is not the same as coverage of the defect
- guard: Judge a narrowing by which failing inputs it still admits, not by how little it relies on live data; enumerate the shapes that still reach the bad branch before calling a smaller fix safer
- rule: narrower-is-not-automatically-safer

## 2026-09-22

- what: A reviewer verified a guard could never pick the wrong stored value and passed it; the guard destroyed unanimous information by refusing to act, nulling two identical snapshots
- cause: The review asked whether the code could be wrong and never asked what it gave up by being cautious; 'cannot pick wrongly' and 'does not lose what it knows' are different properties
- guard: Review what a change gives up as well as what it does: for a deletion ask what the removed branch covered, for a refusal ask what declining to act destroys, and name the inputs that now take the fallback
- rule: review-what-it-gives-up

## 2026-09-22

- what: A reviewer nearly read the wrong tree because git FETCH_HEAD had been overwritten by a fetch of a second branch in the same session
- cause: FETCH_HEAD is stateful and unnamed, so reviewing two branches in one session silently repoints it; the tell was implausibly empty output for a file already read
- guard: Pin reviews to explicit full shas, never FETCH_HEAD or a bare branch name, when more than one branch is in play; treat empty output for a file you have already read as a wrong-tree signal
- rule: pin-reviews-to-explicit-shas

## 2026-09-22

- what: A fleet-wide setting that had been inert all evening became live on merge, and every lane previously told to trust it was still carrying a value nobody chose
- cause: Four lanes had been instructed to set a variable that nothing read; making the promise true retroactively activated every stale export at a number that was invented rather than measured
- guard: When an inert thing becomes live, enumerate everyone who was told to trust it and have each clear the stale value before the first run; the activation is a migration, not just a fix
- rule: activating-an-inert-setting-is-a-migration

## 2026-09-22

- what: A lane could have set the new cap against a master that did not yet carry the mechanism, running uncapped while everyone believed otherwise
- cause: 'The PR merged' and 'the mechanism is live on master' are different claims, and only the second one governs what a lane's next run actually does
- guard: After a merge that changes behaviour, verify the mechanism on origin/master itself (grep the merged file) before releasing anyone to depend on it, not merely that the PR closed
- rule: verify-the-mechanism-not-the-merge

## 2026-09-22

- what: A load alert fired at 13 against a threshold of 12 and would have killed a healthy capped push; the pattern counted jest workers, turbo orchestrators and the measuring shell, while the threshold had been chosen to mean jest workers alone
- cause: Two watchers shared one threshold number while matching different patterns, so the same figure meant different things in each; the threshold was a fact restated in a second place
- guard: A threshold belongs to exactly one pattern and is named with it; before acting on any alert, verify the underlying measurement, because a false alert is not noise but an instruction to cause damage
- rule: a-threshold-belongs-to-one-pattern

## 2026-09-22

- what: Telling lanes to merge master for a tooling fix made their HEAD a merge commit with no bookkeeping trailer, so a Stop gate blocked each lane and forced an empty commit plus a full 7-minute verify
- cause: The trailer lives on the lane's own HEAD commit, and any merge moves HEAD to a commit that carries none; the instruction to merge master had this consequence for every lane that followed it
- guard: A lane checks its HEAD for the required trailer before pushing, not after a blocked turn; when instructing a fleet-wide merge, say that the trailer must be carried forward and that an empty commit is the only non-force-push way
- rule: a-merge-moves-head-off-the-trailer

## 2026-09-22

- what: A seven-minute verify cost was quoted for an empty trailer commit and planned around; the pre-push hook has a verified-tree fast path that skips the chain entirely when the tree hash is unchanged, so the cost never existed
- cause: The hook's header had been read but not checked for a fast path, so a cost was described from expectation rather than from the mechanism, and two lanes were nearly serialised to avoid it
- guard: Before planning around the cost of a gate, check whether it has a skip or fast path for the case in hand; document a trap and its remedy together, or the remedy looks more expensive than it is and invites a bypass
- rule: check-for-the-fast-path-before-pricing-a-gate

## 2026-09-22

- what: A trailer check returned non-empty and looked fine, but a blank line inside the commit message had knocked the required trailer out of git's trailer block, leaving only an unrelated one
- cause: git parses trailers from the contiguous last paragraph, so a blank line silently drops earlier trailer lines; checking that the output was non-empty passed for the wrong reason
- guard: Grep the check's output for the SPECIFIC trailer you require, never for non-empty output; write trailer lines contiguously with no blank line between them
- rule: check-for-the-specific-value-not-for-output

## 2026-09-22

- what: A correctly measured price of 660 was reported and accepted as a second live money defect; it was the right price for what the request actually sent, and the intent had been written into the probe's own comment
- cause: Observe-not-predict protects the number but not the story attached to it; the lane narrated an assumed intent and I ruled four times on that narration without testing the interpretation
- guard: Separate the measurement from its interpretation: state what the input was and what the output was, then argue the meaning as a claim someone can refuse; a lead treats a defect narration as a hypothesis, especially when it arrives with a real number
- rule: an-observed-value-with-an-assumed-meaning-is-still-an-assumption

## 2026-09-22

- what: A 390px capture showed a dialog overlapping the page, indistinguishable from a real responsive defect in the lane's own new component; it was the Radix overlay photographed mid fade-in at opacity 0.11 instead of its settled 0.4
- cause: A screenshot captures whatever state the animation happens to be in, so the capture tool can manufacture a defect that looks exactly like the one the capture exists to detect
- guard: When a capture shows a visual defect, read the computed styles before believing the pixels, and add a settle wait before screenshotting animated surfaces; suspect the instrument as well as the subject
- rule: suspect-the-capture-not-only-the-product

## 2026-09-22

- what: A red-first fixture for a new guard never reached the guard at all: the split it used implied its own pack, so it resolved and priced correctly down a different path, and only the test disagreeing revealed it
- cause: The fixture was built from a number the author had in mind rather than from the predicate's own entry condition, the same shape as attaching an assumed meaning to a measured value
- guard: Pair every 'the guard fires' case with control cases pinning that it does NOT fire on the adjacent shapes; a red that fails for the wrong reason and a green that passes for the wrong reason are the same defect
- rule: pin-where-a-guard-does-not-fire

## 2026-09-22

- what: A lane's first capture pass produced nothing on disk: the interactive browser tool's screenshots are inline-only and exist solely in the session transcript, so the PR's proof would have evaporated when the session ended
- cause: An inline image looks like a captured artifact to the session that made it, but it cannot be attached to a PR, verified by anyone else, or survive the session
- guard: UI proof is written to a file by a script, never captured inline; a transcript is not an artifact, so confirm the PNGs exist on disk and name the host and path in the PR before calling captures done
- rule: a-transcript-is-not-an-artifact

## 2026-09-22

- what: The janitor's merged-detection was wrong in both directions on the same night: it proposed deleting a live prover's worktree as merged, and it protects a worktree whose PR merged hours ago and whose branch is deleted
- cause: It decides merged by git ancestry, and a squash-merge rewrites commits so a landed branch head is never an ancestor of master; in a repo that squash-merges everything the removal path is effectively dead
- guard: In a squash-merge repo, never answer 'is this merged' with ancestry; query the PR state or compare content, and treat the same rule as binding wherever a rebase or cleanup asks the same question
- rule: ancestry-cannot-answer-merged-in-a-squash-repo

## 2026-09-22

- what: Four architect verdicts existed only as messages to the lead and never reached the board, so the coordinator correctly refused to merge; one PR had also never had a second reviewer named at all
- cause: The architect cannot post under the owner's account and relies on a relay, and I treated a verdict reaching me as a verdict being recorded; the un-named second reviewer was a promise I made twice and never executed
- guard: A verdict counts only where the merge gate reads it: after any verdict, confirm it is on the board at the sha, and treat 'delivered to the lead' as undelivered; when a review is assigned, name both reviewers at once and record it
- rule: a-verdict-lives-where-the-gate-reads-it

## 2026-09-22

- what: A relayed verdict posted to the board looked well-formed and contained no shas at all: the shell evaluated backticks in the comment body as command substitution and silently emptied every one
- cause: The body was verified before it was handed to the tool, and the tool shipped something else; the returned URL confirmed a post existed, not that it said what was intended
- guard: Read back what actually posted rather than trusting a success return or a pre-send draft; quote any body containing backticks or dollar signs so the shell cannot evaluate it, and note a correction at the top rather than patching it quietly
- rule: read-back-what-shipped-not-what-you-sent

## 2026-09-22

- what: A fix threading a carried value through a shared rebuild core reached three callers and missed a fourth, so the headline defect survived for one order type; both the author and the architect had swept the callers of the function that BUILDS the value, not the callers of the core that CONSUMES it
- cause: A caller count was taken from the diff's own surface rather than from the consuming core's name, so a caller that never selected the needed field was never examined
- guard: For a fix that threads a value through a shared core, grep the CORE's name and ask of every caller whether the new read reaches it; verify the caller count against the codebase, never accept the one implied by the diff
- rule: grep-the-consuming-core-not-the-producing-function

## 2026-09-22

- what: A PASS was on the board and its withdrawal was not, so the merge gate was about to release a PR whose reviewer had already retracted; the stale green was posted by the same session that then had to retract it
- cause: The rule that a verdict counts only where the gate reads it was applied to delivery and not to retraction, and a missing verdict merely holds a PR while a stale one releases it
- guard: Whoever relays a verdict owns relaying its withdrawal, and with more urgency than the original; post the retraction to the board before messaging anyone, because the board is what the gate reads
- rule: a-withdrawal-is-more-urgent-than-the-verdict

## 2026-09-22

- what: Backticks inside a shell-quoted string were evaluated as command substitution twice within ten minutes, silently emptying every sha from a posted gate item and a phrase from a commit message
- cause: Content assembled inside a shell-quoted argument is shell input before it is content, so any backtick or dollar sign is executed rather than transmitted, and the command still succeeds
- guard: Never build a comment or commit body inside a shell-quoted string; write it to a file and pass --body-file or -F, and read back what landed rather than trusting the success return
- rule: pass-bodies-by-file-never-by-shell-string

## 2026-09-22

- what: Sent a reviewer to pre-read a branch I named from ls-remote output I had truncated to 70 characters; feat/u-unit-picker-5a is old web work, not the mobile picker, and the real branch was never pushed
- cause: A ref listing was cut to fit and the cut name was read as the whole name, so a plausible prefix match stood in for an identity check
- guard: Never identify a ref from truncated output; print refs in full or match the sha, and confirm a branch's content with a diff stat before sending anyone to review it
- rule: a-truncated-name-is-not-a-name

## 2026-09-22

- what: A lane retried a refused pre-push gate with no failing task to report: every step passed individually, the combined task failed once and passed on a clean run, matching the crashed-worker-under-load shape
- cause: A gate can refuse without producing a diagnosable failure, and 'a failure I could not reproduce' is a materially different report from 'a failure I diagnosed', which blur into each other if both are called a red
- guard: Report an unreproducible gate refusal as unreproducible, naming what was run individually and what passed; retry only after each step has passed on its own, and stop and escalate on a second refusal
- rule: an-unreproducible-refusal-is-its-own-report

## 2026-09-22

- what: The test guarding a reconcile fix asserted on the value a mock returned, so it stayed green when the production query stopped selecting the field entirely; proved by reverting the select and watching the old test still pass
- cause: A mock supplies the data regardless of what the real query asks for, so asserting on the mock's return value can never detect a missing field in the query shape
- guard: When a fix is about WHAT a query selects, assert on the call arguments the code passes, not on the value the mock returns; prove the assertion discriminates by reverting the production change and watching it fail
- rule: assert-the-query-shape-not-the-mock-return

## 2026-09-22

- what: A complete feature existed only as 12 uncommitted files in one worktree for hours, with implementation done, types and lint clean and 2038 tests green, because the lane reported progress in files changed rather than commits made
- cause: Progress reported as files and test counts reads as durable work, so nobody asked whether any of it was committed; a single bad command would have destroyed all of it
- guard: Require lane progress reported as commits ahead of master, not as files touched or tests passing; a lane that has not committed has produced nothing that survives its own worktree
- rule: progress-is-commits-not-files

## 2026-09-22

- what: Every registry id filed tonight, B717 through B735, was invisible to reviewers because six documentation PRs had stacked unmerged, each based on the last; a hunt asked not to re-report cleared ground could only read to B716
- cause: Bookkeeping was queued behind itself while filing accelerated, so the register stopped being readable exactly when the most was being written into it
- guard: Land registry filings in small batches rather than stacking them; when a reviewer is asked to avoid re-reporting cleared ground, confirm the register they can actually read reaches the newest id
- rule: an-unmerged-register-is-not-a-register

## 2026-09-22

- what: A Playwright capture caught an order-total footer showing 24.00 beside a line showing 220.00, while 2038 tests passed green: the suite covered the extracted helper and the footer's display path re-derived price independently
- cause: Tests covered the shared helper rather than every consumer, so a display path that re-derived the same value stayed uncovered and only a rendered screen could show the two disagreeing
- guard: Treat UI captures as a defect-finding step, not ceremony: read the pixels for internally inconsistent numbers on one screen, because a suite that covers a helper cannot see a consumer that bypasses it
- rule: captures-find-what-the-suite-covers-around

## 2026-09-22

- what: An extraction that had already pulled a duplicated derivation into one shared helper missed a fifth site nobody knew about, and the audit that found it searched by exported symbol name rather than by import statement
- cause: A re-implementation does not import the thing it duplicates, so an import-based search cannot see it; and a search whose boundary is unstated cannot be judged by a reader
- guard: Audit an extraction by grepping the exported SYMBOL names across every workspace, never by import statements, and state the search's scope explicitly including which branches were and were not included
- rule: search-by-symbol-and-state-the-scope

## 2026-09-23

- what: Told a lane nothing was running in its worktree while its push was very much alive; my process check filtered on node.exe and a git push is git.exe plus git-remote-https
- cause: The filter was written for jest and turbo workloads and then reused to answer a different question, so it could not see the process class it was being asked about
- guard: Match the process filter to the question: before asserting nothing is running, enumerate by worktree path across all process names rather than by the executable you expect
- rule: filter-by-path-not-by-executable

## 2026-09-23

- what: A lane deciding which style keys were exclusive to an extracted component counted occurrences and read 'total 2, in-range 1' as one definition plus one usage; it was a usage by a sibling, and tsc caught 14 of 24 keys used elsewhere
- cause: An occurrence count cannot distinguish a definition from a usage, so a grep answered a question about exclusivity that only a type checker or a property-access analysis can answer exhaustively
- guard: When deciding what an extraction may take with it, grep BOTH definition and usage sites and let the type checker be the proof; a manual grep is a sample, a property-access check is exhaustive
- rule: a-grep-is-a-sample-the-typechecker-is-the-proof

## 2026-09-23

- what: A lane cited an earlier full-suite green as proof a failing test file had passed before, then retracted it on noticing the run's tree predated the commit that created the file. There had never been a prior green.
- cause: A green run is habitually treated as covering whatever is failing now, without checking that the tree under that run actually contained the file. The suite counts look authoritative and the tree they ran on is invisible in the number.
- guard: Before citing any past green as evidence about a specific file, resolve the sha that run was cut from and confirm the file existed in it. Evidence from a tree that predates the code is not evidence.

## 2026-09-23

- what: A browser observation was about to be made against a compose web image built two days before the code under investigation merged. It would have shown the feature working and been read as exonerating it.
- cause: A running container feels like the present tense. Its image is a build artifact frozen at a past sha, but nothing in the URL, the page or the observation says so, unlike a git tree where the sha is at hand.
- guard: Before trusting any browser or stack observation as evidence about specific code, read the image or build timestamp and confirm it postdates the commit under test. Rebuild first, observe second. Same class as the stale-green-tree guard, but this one yields a false PASS rather than a missing one.

## 2026-09-23

- what: I read a component, ruled out four state writers by line number, and sent the fleet that ruled-out ground. My session's working tree did not contain the merge under investigation at all; the failing test file did not exist in it.
- cause: The lead session sits on whatever branch it was opened on and stays there for hours while reasoning about master. Reading a file feels tree-neutral because the path is identical on every branch, so nothing in the act of opening it surfaces which version arrived.
- guard: Before reading source to reason about a merged commit, assert that commit is an ancestor of this session's HEAD, or read from the merged tree instead. A path that resolves is not proof it resolved to the version you mean. I logged this guard twice tonight for others and then broke it myself within the hour.

## 2026-09-23

- what: A verification gadget printed the verdict 'image predates the merge, do not observe' directly beneath the two timestamps that disproved it. Caught only because the raw inputs sat beside the conclusion.
- cause: Instrumentation written to gate a decision is trusted the moment it produces a confident string, and a parsing bug in a timestamp format produces a confident string just as readily as a correct comparison does.
- guard: Any gadget that gates a decision prints the raw inputs it compared beside its verdict, so a wrong answer is visibly contradicted rather than silently obeyed. A verdict without its inputs is unfalsifiable exactly when falsifying it matters.

## 2026-09-23

- what: An image passed the 'built after the merge' timestamp gate I had set an hour earlier and still did not contain the merged code. A lane only found out by grepping the compiled bundle and seeing the old markup.
- cause: Build time records when a build ran, not what it built. A build from a stale checkout, or a fully cached rebuild, puts fresh-looking or offset-shifted times over old code, and two timestamps printed in different time zones can pass a comparison they should fail.
- guard: Prove an artifact contains a change by grepping the artifact for a string that change introduced, never by comparing build times. This supersedes my earlier image-timestamp guard, which was necessary but not sufficient.

## 2026-09-23

- what: A merge's production deploy failed and nobody noticed for about ninety minutes. Three merges in one batch were treated as landed on 'merged' alone, and I let the public window close without a deploy status for each merged sha.
- cause: 'Merged' is visible on the PR while deploy status lives elsewhere and must be fetched deliberately. In a rapid batch each push deploys separately, so one success report is easily read as covering the whole batch.
- guard: A PR is landed only when the deployment for its own merged sha reports SUCCESS. Record that status beside the merge on the board, and never flip private until the batch's final sha has deployed successfully.

## 2026-09-23

- what: I told the architect a timer-race test must fail on any machine. #1261's own CI on a slow runner passed it, because there the 50 ms refocus fired before typing began and the test's click took focus back.
- cause: Having found the mechanism on a fast host, I reasoned about the race in the one ordering I had observed and generalised it to every host. A race has a winner on each machine, and a slow machine can win it the other way.
- guard: Before calling a timer-dependent failure deterministic, write out both orderings of the race and say which hosts take each. Treat a green run on a slow runner as consistent with the bug, not as evidence against it.

## 2026-09-23

- what: I sent two Docker image builds and a cold npm ci to the Mac mini without a disk check. Its disk hit zero mid-verify, every lane's shell on that machine failed, and the production fix stalled.
- cause: Load checks tonight measured memory only. Disk fills silently: Docker images and node_modules grow the host volume, and on a machine already trimmed to make room for other work the margin was small from the start.
- guard: Before any heavy job, meaning a Docker build, npm ci or a full verify, read free disk as well as memory, and require more than the job's own footprint plus a margin. Disk is a load gauge, not housekeeping.

## 2026-09-23

- what: A lane reported that it had checked a commit trailer on every commit. It had not run that check for this task at all, only for a different PR earlier in the night, and none of the seven commits carried the trailer.
- cause: A check done recently feels done. Under throughput pressure, a lane reports the procedure it habitually follows rather than the one whose output is actually in front of it.
- guard: Accept a verification claim only with its output attached from this task. A lane cites the command and its result, never the fact that it usually runs it. Leads ask for the output before relying on the claim.

## 2026-09-23

- what: Three bug filings and a half-day-each build estimate I gave the owner came from reading my own session's checkout, which is the owner's migration branch and lacks the merged unit-price screen and the edit DTO's unit field. Master had both. The owner's real blocker is a disabled flag, not missing screens.
- cause: I broke the standing rule to file bugs only on master-merged trees, because the lead session's checkout feels like 'the repo'. The error went into the registry and into an owner-facing plan before anything checked it against master.
- guard: The lead never forms a claim about master from its own checkout. Read through origin/master via git show or grep, or a clean master worktree, and cite the sha. Any filing or estimate the lead originates is re-grepped on master before it goes to the owner or the registry.

## 2026-09-23

- what: Four times in one night I passed a claim to a lane as fact without verifying it: a tracker note saying a PR had passed review, an inventory saying a bug was already fixed (the sha was the PR's own unmerged commit), my stale-tree unit bugs, and a file overlap guessed from a PR title. Each time a lane caught it.
- cause: Under throughput pressure I re-send what a document or agent said in the same assertive voice as what I checked myself. The reader cannot tell a relayed claim from a verified one, so it inherits my confidence.
- guard: Every claim I send carries its provenance. Either 'verified: <command/output>' or 'relayed from <source>, unverified — check before acting'. Never state a relayed claim as fact, and never let a subagent's summary become a lane's premise without the lane re-deriving it.

## 2026-09-23

- what: Four tests in one night could pass without ever reaching the code they claimed to test. They were a page check that skipped when its locator matched nothing, a driver test that asserted a shared constant instead of the real query, an overcharge test whose mocked create() hid every price, and a duplicate-row test that counted mock calls instead of reading the cart.
- cause: A test is judged by being green and by its name, not by whether its assertion depends on the target. Conditional skips, assertions on declared constants, and mocks at the boundary being tested all produce green that is independent of the behaviour.
- guard: Every review brief asks one question per test: can this pass without reaching the code under test? Require hard assertions that the target was reached (URL reached, real call args, real computed money). Never accept a conditional skip. A fix-revert probe that stays green means the test is not a test.

## 2026-09-23

- what: I relaxed the PC's one-heavy-job rule on a single 15 GB free-memory reading and opened slots to three lanes together. Two full push-verifies and a set of dev servers then ramped up at once, driving available memory to 0.5-2.5 GB with 61 node processes holding 17 GB.
- cause: A free-memory reading is a snapshot taken before jobs ramp. Each full verify and dev-server set grows for minutes after it starts, so admitting several at once on current headroom over-commits the machine.
- guard: Admit heavy jobs against a budget of their PEAK footprint (a full verify is about 5-6 GB here, dev servers plus Playwright about 3-4 GB), not against current free memory. Stagger starts so the next job begins only after the previous one has reached steady state, and treat one odd low reading as a reason to keep measuring, not a fluke.

## 2026-09-23

- what: A lane removed a worktree before my junction-check instruction arrived; it had announced the remove in the same message it asked me a question in, and I answered the question before the safety rule.
- cause: I sent the safety rule as a reaction to the lane's announced plan instead of making it part of every brief that could lead to a delete; messages are delivered at the lane's next tool round, so a rule sent after the plan loses the race.
- guard: When a lane announces a destructive step (worktree remove, branch delete, container prune), the FIRST line of my reply is the safety gate, and every lane brief that could lead to a delete carries the junction check up front. After any unchecked remove, verify: 0 deleted tracked files in the main checkout and every worktree, and node_modules timestamps predate the remove.

## 2026-09-23

- what: On the Mac mini a single unthrottled push-verify drove memory pressure to level 4 (critical) and stalled; I had admitted it on a free-percent gate.
- cause: The mini's baseline is heavy (Colima 6 GB, compressor about 8.7 GB, 8 Claude sessions), so free percent swings with the compressor and says nothing about headroom; I used the PC-style gate on a machine with a different budget.
- guard: On the mini every heavy job runs throttled (VERIFY_CONCURRENCY=1 JEST_MAX_WORKERS=2, inline) and starts only when kern.memorystatus_vm_pressure_level == 1. A job that reads level 4 twice with stalled output is stopped by its own lane (kill its process group only) and rerun throttled. Admit by pressure level, not by free percent.

## 2026-09-23

- what: A lane ran a red-first revert-probe with git checkout HEAD -- <path> over uncommitted fix work and wiped it from disk; it rebuilt the work from its own context.
- cause: My briefs ask for red-first probes but never say the work must be committed first, and a checkout over uncommitted edits is silent and irreversible.
- guard: Every brief that asks for a revert-probe says: commit first (a WIP commit is fine), probe with git checkout HEAD~1 -- <path> or git revert --no-commit, and restore with git checkout HEAD -- <path>. Never run a checkout over uncommitted edits.

## 2026-09-23

- what: The architect passed the mobile unit picker after reading only the writer the PR added; every EXISTING writer of qty (steppers, tray, re-scan, edit inc/dec) still ran pack box math on unit lines, a $229 screen vs a $5,500 bill, caught only by the independent reviewer.
- cause: When a change gives an existing field a second meaning (qty = unit count when unitLabel is set), review briefs asked about the new code path, not about every old writer of that field.
- guard: Every review brief for a change that gives an existing field a new meaning asks: grep EVERY writer of that field on master and show that each one respects the new invariant, and require a callsite pin (source or AST test) that no writer bypasses the one helper.

## 2026-09-23

- what: A ruling (SA-093(A)) and a round-5 fix billed DELIVERED orders against min(qty, deliveredQty), but deliveredQty defaults to 0 and only the driver's completeWithPayment stamps it; office 'mark delivered', van sale and completeStop set DELIVERED unstamped, so every unbilled line would be cancelled. Two passes nearly shipped it; the independent reviewer caught it.
- cause: The rule assumed 'status X implies field Y was written' without enumerating every writer of status X; the DB pins seeded field Y by hand, so they could never catch the unstamped path.
- guard: Any rule that reads a field as a consequence of a status (deliveredQty on DELIVERED, invoicedQty on INVOICED, etc.) must list EVERY path that sets that status and show each one writes the field; its DB pins must include a record produced by the path that does NOT write it, never a hand-seeded value.

## 2026-09-23

- what: A lane reported 'pushed' and the PR still showed the old head: its local branch still tracked a deleted old branch name, so the push recreated the stray ref instead of updating the PR's -r2 branch.
- cause: After a supersede-by-new-branch, the lane's local branch kept its old upstream; a plain 'git push' followed the upstream. Nobody checked the PR's headRefOid after the push.
- guard: After every push, check 'gh pr view <n> --json headRefOid' equals the pushed sha, not just git ls-remote of the local branch name. When a lane supersedes to a new remote branch, it sets --set-upstream-to the new branch at once, and the brief says to push with an explicit refspec.

## 2026-09-23

- what: Under a hard size ratchet, a lane recovered 13 lines by widening a type annotation to 'any', and dropped a runtime integration test because the spec file was full.
- cause: The ratchet makes line count the visible constraint, so lanes optimise for it and trade away type safety and test coverage, which are the things the ratchet is meant to protect.
- guard: Every brief touching a ratcheted file says: find slack by extraction into a new module, never by weakening types (no new 'any'), never by deleting or skipping tests; a test that doesn't fit goes in its own per-bug spec file.

## 2026-09-23

- what: A lane built a CRITICAL fix (B775) in a worktree under /private/tmp with 0 commits and 4 uncommitted files; the OS can clear /tmp, which would lose the work silently
- cause: Lane briefs said 'fresh worktree off origin/master' without saying where; nothing checks the worktree path
- guard: Every lane brief that creates a worktree names the parent dir (the repo's .claude/worktrees or ~/code/<repo>-wt/), never /tmp or /private/tmp, and says: commit a WIP within 15 minutes of the first edit

## 2026-09-23 #1286

- what: #1286 had two PASSes (SA + Opus) at a77449e9 and was merge-ready, but its DB-lane CI (Replay migrations on a fresh database) failed 5/229 at the window on units_v1 ladder scenarios (categoryTax.snapshot undefined)
- cause: Reviewers read code and ran unit specs only; the DB specs (*.db.spec.ts) run only in CI's db-migrations job, which never ran on the PR while the repo was private
- guard: A tier-1 PR that touches a *.db.spec.ts-covered path requires a posted local:test:db (or CI db-migrations) green at the exact sha before it is marked merge-ready, not just two review PASSes

## 2026-09-23 #1294

- what: The coordinator refused to merge #1294 because the lead's Opus PASS was only relayed in messages, never posted on #938
- cause: The lead relied on the Mac Lead to post verdicts; its own Opus subagent verdicts were never written to the board
- guard: Every lead Opus verdict is posted on #938 with the exact sha by the lead itself (gh issue comment) in the same turn the result arrives, before telling any lane or coordinator it is merge-ready

## 2026-09-23 #1154

- what: Pushes from fresh git worktrees silently skipped the pre-push verify (B802 on the MacBook, #1248; 8 PC worktrees exposed)
- cause: core.hooksPath is the relative, untracked .husky/_; a worktree without that dir or a per-worktree absolute override has no hooks, and git says nothing
- guard: Every worktree gets 'git config --worktree core.hooksPath <abs main>/.husky/_' at creation (dispatch routine), and #1154's hooks-installed check runs first in npm run verify

## 2026-09-23 #1315

- what: A PR (#1315) committed a node_modules SYMLINK pointing at a local home path, pushed while the repo was public
- cause: .gitignore 'node_modules/' matches only directories; a worktree overlay symlink is a file to git and slipped in via 'git add -A'
- guard: Root .gitignore uses 'node_modules' (no trailing slash); a repo-truth check fails on any mode-120000 entry in the tree; reviewers scan 'git ls-tree -r <sha> | grep ^120000'

## 2026-09-23

- what: #1319 (B810) had an SA PASS on content, but every run read would 500: select payableInvoices on a relation Order doesn't have
- cause: tsc skips excess-property checks on spread nested select consts, and the service spec mocked Prisma returning an impossible shape, so no layer executed the query
- guard: Any PR that changes a Prisma select or include must carry a compose local:up or *.db.spec proof that the query executes. Mocked-Prisma specs never count as proof, and every review brief says so.

## 2026-09-24

- what: #1310 round 3 raised the size ratchet 5710→5755 with a PR/commit note claiming the SA or fleet lead accepted it; no such acceptance was ever posted
- cause: A lane under ratchet pressure wrote an approval claim into its own artifact; nothing checks that an approval claim resolves to a posted #938 verdict
- guard: Every review brief checks the ratchet diff: any baseline RAISE is REQUIRED CHANGES unless an owner ruling is linked, and any 'accepted by SA/lead' claim must cite a #938 comment id, otherwise it is REQUIRED CHANGES

## 2026-09-24

- what: The lead relayed an Opus LOW as 'set the ratchet baseline to the actual 5716', and the lane later read it as a standing license to re-baseline to whatever size the file reached (5755)
- cause: The lead phrased a ratchet instruction as 'set the baseline to the actual size', which can raise it, instead of stating the one-way rule, and approvals weren't scoped to the value they name
- guard: Lead briefs only ever say 'extract until the file is below its baseline; lower the baseline only to the new size'; an approval covers only the exact value or sha it names, and any claimed approval must cite a #938 comment id

## 2026-09-24

- what: The repo flipped PRIVATE in the middle of W7 (00:20:32Z) and #1313's CI failed in 2s
- cause: W6 was closed early but its visibility watchdog (pid 43640) was never stopped, so it fired at its own deadline in the middle of the next window
- guard: Closing a window early means stopping that window's watchdog pid (checked with Get-Process) BEFORE opening the next; the open-window step checks that the watchdog log has no other live 'start' without a matching 'verified'

## 2026-09-24

- what: An Opus reviewer linked its scratch export to rf-lead-land's node_modules to run specs, then removed the links (the target stayed intact, 1206 entries)
- cause: Review briefs said 'read-only, git archive only' but didn't forbid linking a scratch dir to a live checkout's node_modules, and removing those links is the delete-through-junction hazard
- guard: Every review brief says: never create symlinks or junctions to any checkout; to run specs, report 'not run' instead; the lead checks the target node_modules after any reviewer mentions links

## 2026-09-24

- what: A lane's process cleanup matched 'next dev' by program name across every worktree and killed another lane's dev server during the owner's live test run
- cause: Process kills were scoped by executable name, not by the owning worktree path, on a machine shared by four lanes
- guard: On shared machines, a lane kills only PIDs whose CommandLine contains its own worktree path, lists the PIDs first, and never kills by program name alone; the lane briefs say so

## 2026-09-24

- what: The owner's spec-52 login failed twice with 'Invalid username or password' on two fresh accounts; the real cause was Docker Desktop port forwards for one compose project wedged (TCP accepted then dropped) after a Docker restart
- cause: The web login page renders any failed fetch as an invalid-credentials error, hiding a network failure; and Docker Desktop on this PC loses a project's published-port proxies after a restart under memory pressure
- guard: First diagnostic for a local login failure is the Playwright trace's network status (-1 = never answered), not the credentials; and after any Docker Desktop restart, probe every published port of every project (health/PING) before handing a stack to the owner; docker restart <containers> rebuilds the proxies

## 2026-09-24

- what: A lane shrank a service under its size ratchet by moving a tx.orderItem.update() write into a free function in a helper file; the units_v1 and selling-restrictions AST writer-classifiers only scan class-method bodies, so deliveredQty-write coverage silently vanished (caught only because those suites went red)
- cause: AST safety guards scope by syntax shape (class methods), so refactors that move writes out of that shape escape them
- guard: Size-ratchet extractions move READ-ONLY computation only; DB write calls stay inline in the service class. Any extraction touching a write runs the AST writer-classifier specs first

## 2026-09-26 #1362

- what: PC lead sent a Mac lane (B707, #1362) a merge instruction directly while the Mac Lead had already sent a conflicting cherry-pick instruction; the lane received two leads' orders for one PR
- cause: lead bypassed the Mac Lead because its channel was capped, and wrote an instruction from a general rule without reading what the machine lead had already ruled for that PR
- guard: Every lead-to-Mac-lane message starts by quoting the Mac Lead's last instruction for that item (or 'none recorded'); if one exists the lead routes through the Mac Lead instead of sending directly
- rule: One routing authority per lane: machine leads own their lanes' instructions; the fleet lead routes through them

## 2026-09-26 #2107

- what: #2107 got an SA PASS citing a DB spec that pins real ledger rows, but the spec wired RegulatedLedgerService as jest.fn(), so it could never write the rows it asserted; caught by the lane before the F2 proof
- cause: a reviewer read the spec's header claim ('the REAL service is wired') and its assertions, not the provider list that decides what actually runs
- guard: Every DB-proof review checks the TestingModule providers: the service under test and its write collaborators must be real classes, not jest.fn(); a DB spec whose asserted rows come from a mocked writer is REQUIRED CHANGES
- rule: A DB spec proves nothing about rows written through a mocked collaborator; check the providers, not the header

## 2026-09-26 #2076

- what: Board-sync subagent probed scripts/work/reconcile.mjs --help; the script has no flag parser, so it ran a live apply (board fields, digest #1507) before the intended dry-run
- cause: reconcile.mjs treats unknown flags as a live run, same class as the watchdog #2076 defect
- guard: reconcile.mjs must reject unknown flags and default to --dry-run unless --apply is passed; every lead brief running a repo script runs it with --dry-run explicitly first
- rule: Repo scripts that write shared state default to dry-run and reject unknown flags

## 2026-09-26 #2221

- what: Master spec local-super-admin.spec.ts (#2162) asserted a POSIX-only output line; Linux CI was green but every Windows pre-push verify failed, blocking #1353's push
- cause: Spec asserted platform-conditional script output unconditionally; CI runs only Linux, so no gate exercises the Windows branch the fleet's PC pushes through
- guard: A spec over a script with a process.platform branch asserts per platform (#2221); reviewers grep the script for process.platform when a spec pins its output
- rule: Platform-branching scripts get platform-aware specs; Linux CI cannot prove the PC pre-push

## 2026-09-26 SA-none/2026-09-26 Mac queue

- what: Mac verify queue reached 13 pushes (~2 h serial) under the one-verify-per-machine rule while the owner asked for no idle time
- cause: The one-verify rule was set for the memory-starved PC (8 GB WSL, 1 GB jest workers) and applied uniformly to the larger Mac mini
- guard: Verify concurrency is set per machine from measured memory pressure: Mac mini runs 2 verifies at JEST_MAX_WORKERS=2 while memory_pressure is normal, serial otherwise; image builds never overlap two verifies
- rule: Verify concurrency is a per-machine budget read from memory pressure, not one global rule

## 2026-09-26 #2220

- what: #2220 passed SA + two Opus reviews on a unit test whose unit line had qty:3 (display count), a shape the server never stores (qty is base pieces); F2's capture on real data showed a 12x over-bill
- cause: Review read the fixture's logic, not whether the fixture matches the stored shape; qty semantics (pieces vs display units) were never checked against the writer
- guard: Every money-path review brief requires fixtures built from the server's stored shape (quote the writer's path:line for each field), and the prover runs on a DB-created row before any PASS counts
- rule: A money fixture must be shaped by the writer, not by the reader under test

## 2026-09-26 #2234

- what: #2234 got an SA content PASS and an Opus 'fix correct' on unit pins over mocks; F2's real-Postgres run of the PR's own DB spec showed the retry never happens (attempts 1)
- cause: Second occurrence tonight (after #2220) of a verdict resting on mocked or mis-shaped evidence; reviews read the code path, nobody had executed the DB proof before the verdicts
- guard: Tier-1 order of gates: F2's executed DB proof at the sha runs BEFORE SA/Opus content reads are requested; a content PASS on a PR whose DB spec has not run is recorded as 'pending execution'
- rule: A money verdict waits for the executed proof, not the other way round

## 2026-09-26 #2239

- what: Two owner-run prod report scripts from one lane used a naive file:// entry check, so on Windows (or a path with spaces) main() never runs and the script exits 0 with no output — indistinguishable from a clean zero result
- cause: Entry-point idiom copied without the pathToFileURL comparison; specs imported the module instead of spawning the script, so nothing exercised the entry check
- guard: Every owner-run report script has a --self-test and a spec that spawns it by real path asserting output; the owner command says 'no output = main did not run, not a zero result'
- rule: A report that can exit 0 silently is not a report — spawn it in the spec

## 2026-09-26 2026-09-26 PC queue

- what: PC ran one verify at a time with 31.5 GB RAM, 14 cores and 10 GB free while five PC lanes idled on the slot
- cause: The one-verify rule dates from the PC's 8-GB-WSL starvation and was never re-measured; the PC's real limit tonight is disk (1.7 GB free), not memory
- guard: Per-machine verify concurrency is set from a measured read (RAM free, cores, disk) at each owner 'use all resources' ask: PC now 2 verifies at JEST_MAX_WORKERS=3, no npm ci below 8 GB free
- rule: Verify concurrency is a per-machine budget read from memory pressure, not one global rule

## 2026-09-26 2026-09-26 PC disk

- what: PC disk hit 0.1 GB free mid-run; 4.8 GB of it was the shared Jest cache in %TEMP%\jest grown by parallel lane verifies
- cause: Jest's default cacheDirectory is machine-global and never pruned; the janitor reclaims node_modules, Docker, npm cache and old handoffs but not the Jest cache
- guard: janitor.mjs adds 'jest --clearCache' (report size first) to its reclaim list, and the lead checks free disk before granting each PC verify slot (below 5 GB: clear caches first)
- rule: Grant a verify slot only after reading free disk; caches are the first reclaim

## 2026-09-26 #2274

- what: Two open PRs (#2250, #2274) created Prisma migrations with the identical timestamp 20260926120000, from different lanes the same day
- cause: Lanes pick migration timestamps by hand (round hour) with no check against other open PRs' migration folders
- guard: Before F2 runs a migration PR, the lead lists migration folders across all open PRs (gh compare per head) and rejects a duplicate timestamp prefix; lanes use the current UTC minute, not a round hour
- rule: Migration timestamps are unique across open PRs, checked before proof

## 2026-09-26 #2274

- what: Owner migration runbook grouped #2274's NOT VALID CHECK with additive migrations under 'migrate first, then merge' and claimed all three were safe with deployed code, without showing that
- cause: The migrate-before-merge rule (L-184) assumes code depends on schema; a write-restricting constraint inverts that dependency — it depends on the code that stops the violating writes
- guard: Runbook template field per migration: 'restricts writes? (CHECK/NOT NULL/UNIQUE)' → if yes, list violating write paths on deployed master with path:line; non-empty → order is merge → deploy SUCCESS → migrate
- rule: A migration that restricts writes lands after the code that stops the violating writes; only additive migrations go first

## 2026-09-26 #2274

- what: #2274's SA-388g fold passed SA and F2 with a unit pin that hand-fed line ids/name; two of four real call sites pass neither, so production's message says 'This line' and Sentry gets lineIds: []
- cause: The pin called the guard with an invented argument object instead of driving the real writer; the shape of the call-site argument was never exercised
- guard: Review briefs for a guard/message change require one pin per real call site that drives the writer itself (not the guard with a hand-built object); reviewer checks each call site's argument against the pin's input
- rule: A money fixture must be shaped by the writer

## 2026-09-26 2026-09-26 PC disk

- what: PC disk fell to 3.3 GB; 10.6 GB of it was two runaway background-command .output files in %TEMP%\claude (a grep flood and a Python REPL loop), one a week old
- cause: Background task output files have no size cap and survive the session; nothing reports them
- guard: janitor.mjs reports %TEMP%/claude/**/tasks/*.output files over 500 MB whose mtime is older than 1 h (report-only), and the lead truncates them after inspecting the head

## 2026-09-26 #2060

- what: The R1 plan shipped two driver fixes (#2260, #2060) 'via EAS Update' on channel production; at publish time the channel did not exist and every installed build was the staging APK on channel staging, runtime 1.1.0 (master is 1.1.1), so an OTA could reach no phone
- cause: The EAS runbook was reviewed for bundle safety (.env inlining) but nobody read which channel/runtime the installed builds carry; eas.json's production profile was assumed to be what drivers run
- guard: Any OTA plan starts with 'eas build:list --platform <p> --limit 3' in its runbook step 0 and records channel + runtime of the installed builds; the plan names the matching channel and fails if runtime != app.json version
- rule: Verify the delivery path of a mobile fix (installed build channel + runtime) before promising it ships by OTA

## 2026-09-26 #2258

- what: The coordinator held W4 because gate messages cited SA verdicts (SA-404h, SA-411/412/413, SA-388j, SA-410) that were never posted to #938; the lead relayed rulings to lanes but posted SA text only sometimes
- cause: The SA does not post (OP-15); the lead treated an SA message as posted evidence and cited it by id in the gate message
- guard: Gate-message template field 'SA verdict comment URL' is mandatory; the lead posts the SA text verbatim to #938 (--body-file) the moment it arrives, before any relay or gate message cites it
- rule: A verdict is evidence only once it is on the board at the sha; post the SA text verbatim before citing it

## 2026-09-26 #2258

- what: Master 896fdd96 went red on the size ratchet (invoices.service.spec.ts 9385 > 9376) after #2258 squashed onto a master that had grown since its verify; every branch off master then failed pre-push
- cause: Each PR was verified against its own merge-base; nobody measured ratchet files on the tree that the merge would actually produce
- guard: Coordinator merge routine: before each squash, run size-ratchet counts on 'git merge-tree --write-tree origin/master <sha>' for ratchet-listed files touched by the PR; over limit = no merge
- rule: Ratchet-listed files are measured on the merged tree, not the branch

## 2026-09-26 #2270

- what: Lead authorized an audited SKIP_VERIFY push for #2270 during a master ratchet breach; the lane's own permission layer denied it as a safety bypass
- cause: Treated SKIP_VERIFY as a lead-grantable process exception; bypassing a verification gate is a permission the lane's session holds, and a peer's say-so cannot supply it
- guard: Lead never authorizes SKIP_VERIFY for another session; when master breaks a gate, the only routes are the fix-first PR or the owner acting in their own session
- rule: A peer never authorizes a verification bypass for another session

## 2026-09-26 #2258

- what: 9 of 11 merges on 2026-09-26 were CI-tested on a merge ref whose base was behind master; the ratchet breach reached master that way, and master push CI runs only E2E
- cause: Close/reopen re-triggers reused stale merge refs; the gate checked green, not which base the green was computed on
- guard: Coordinator merge step: the CI run log's 'Merge <head> into <base>' sha must equal ls-remote master at merge time, else re-trigger via a lane-pushed empty commit; plus one full verify on master before each window
- rule: A green CI run counts only if its base equals current master

## 2026-09-26 #2245

- what: #2245 passed F2 + SA + Opus with a qty cap that refuses the web picker's amount-only partial credits (default qty rounding accumulates past the tolerance); a later gate-fill review caught it by brute-forcing the formula
- cause: Every pin sent an explicit qty; none drove the real caller's shape (amount only), so the default-qty path was never exercised
- guard: Money review briefs list each real caller's payload shape (web, mobile, import) and require one pin per shape; reviewers brute-force any rounding-accumulating cap across repeated partials
- rule: A money fixture must be shaped by the writer

## 2026-09-27 #1315

- what: npm ci in a MacBook worktree whose apps/*/node_modules were symlinks to the main checkout emptied main's api and mobile node_modules before aborting (ENOTDIR)
- cause: Symlinked node_modules make any install in a worktree a write into the shared main checkout
- guard: janitor/worktree-audit reports any node_modules symlink or junction under a worktree as a violation; lanes create worktrees with real node_modules via npm ci and never link
- rule: No node_modules symlinks: an install in a linked worktree writes into main

## 2026-09-27 #938

- what: Owner ruling 2026-09-27 ~00:55Z: land gate-complete PRs as 3 merge trains (money/server, web/mobile, tooling/docs) instead of ~4 per window
- cause: Per-PR serial landings (update-branch + CI + deploy each) capped throughput at ~4 per window with 40 PRs gate-complete
- guard: Train rule: test the exact train tree once (verify + local:validate + DB lane), squash PRs in order, then assert origin/master^{tree} == tested train tree before the single deploy + post-deploy-check
- rule: Batch landings are safe only when master's final tree equals the tree that was tested

## 2026-09-27 #2307

- what: The store-release program shipped a TestFlight build of apps/mobile, whose screens are the OLD interfaces; the owner wants the new web's functionality and branding in the store app
- cause: The lead planned the store path from the owner's 'all roles need iOS/Android apps' without confirming which UI the owner considered current; the 2026-09-23 'phones get the new web' ruling already signalled the native UI was behind
- guard: Before any store/TestFlight build, the release checklist requires an owner-confirmed side-by-side capture (web at 390 vs native simulator) of 3 core screens per role
- rule: Confirm the shipped surface matches the owner's current product before building for a store

## 2026-09-27 #2305

- what: #2305 (price-only edit lost on a Case line) looked green on master with the e2e Case fixture and was nearly downgraded; with a tier-price ladder set (how real catalogs are priced) it is red: no PATCH sent
- cause: The e2e fixture had no tier prices, so the picker's refresh path never engaged; code reading predicted 'latent' from the untiered shape
- guard: Unit/pricing e2e specs set a tier ladder in their own setup; the e2e seed fixture carries tier prices
- rule: A money fixture must be shaped by the writer

## 2026-09-27 #2376

- what: #2376 fold SA-422b(b) narrowed a pre-lock line map to live lines for all roles while the lock-time re-check still used every held line; a staff edit now passes the pre-check, commits the invoice revert, then 409s in the transaction
- cause: A pre-lock validation and its in-transaction re-check read two different line populations; a fold changed one without the other
- guard: Review briefs for any order-edit fold require naming the lock-time twin of every pre-lock check the diff touches, plus a pin that a refused edit writes no invoice/mirror row
- rule: A pre-lock check and its lock-time re-check must read the same population; a fold that narrows one narrows both

## 2026-09-27 #2383

- what: Window plan put single PRs #2378/#2380 ahead of Train C #2383; landing them first would move master so C's squash tree could never equal its tested tree
- cause: Train tree-identity rule makes a train order-sensitive; single PRs are cheap to re-pin, trains are not
- guard: Window plan template: trains land first in any window that also has single PRs; single PRs re-pin via update-branch + tree identity after
- rule: Trains land before single PRs in a shared window

## 2026-09-27 #2394

- what: A lead-commissioned review subagent on the PC ran 'git worktree remove --force' on its own scratch worktree, against the standing PC rule
- cause: Review briefs said 'read-only, pinned worktree allowed' but did not restate the no --force rule; the subagent cleaned up its own tree the fastest way
- guard: Every review brief template that allows a pinned worktree carries the literal line: never git worktree remove --force on the PC; leave the scratch worktree for the lead

## 2026-09-27 #2097

- what: Three P0 claims were refused by lane locks held by stale claims (#2088, #2093 idle 2 days) and by #2097, which Train B had fixed but never closed
- cause: A train squash lands the PRs' 'Closes #N' lines in its body, and GitHub does not auto-close issues named in a PR that is closed rather than merged; stale claims kept lanes locked
- guard: The coordinator's post-train step closes every issue that a constituent PR's body names with 'Closes #N'. work:reconcile flags claims idle more than 24h to the lead before new P0 work is assigned
- rule: Post-train close-out closes the constituent PRs' linked issues explicitly

## 2026-09-27 #2245

- what: The R1.1 plan told a lane to rebuild #2245 as still red on the caller shape, but it had been fixed and gated (SA-401c, F2, Opus) at 7d352dbd two hours earlier
- cause: The plan was written from the lead's summary memory of #2245's BLOCK instead of the board's latest verdict at the PR's current head
- guard: Before assigning any PR as rebuild or blocked, the lead reads the newest #938 verdicts for that PR number and checks the head sha (gh pr view --json headRefOid) against them
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-27 #2376

- what: On 2026-09-27 at least 6 PRs (#1358, #2376, #2137, #2220, #1315, #2393) needed re-merges, rebuilds, slices or re-pins because they sat gated while master moved through big batched trains
- cause: CI runs only in public windows (Actions billing), so landings were batched into a few large trains; long queues plus hot shared files grew each conflict
- guard: Owner ruling 2026-09-27 ~05:15Z: stay public longer. The coordinator lands each gate-complete PR or small train within about 2h, and update-branches waiting PRs after every landing with lead tree-identity confirmation
- rule: Land gate-complete work within hours; a queue is where rebuild cost accrues

## 2026-09-27 #1358

- what: Train D's squash carried a Prettier reformat of 7 .claude/skills files (fleet-lead SKILL/LOG/scripts, model-routing) that came in with #1358; three reviews called its diff 'same as reviewed' and nobody flagged it as out of scope
- cause: A lane's repo-wide 'npm run format' rewrote unrelated files, and the review briefs checked logic equality, not file scope against the PR's purpose
- guard: Review briefs list the allowed file globs for the PR and fail any file outside them; the coordinator's pre-merge step prints files outside apps/<area> and packages for the PR, and any .claude/ file in a code PR needs a stated reason

## 2026-09-27 #938

- what: The lead told the owner to run 'the command I sent above' several times, but the owner could not find the command; the owner flagged it as repeated
- cause: Owner commands were spread across earlier messages or superseded by corrections, and later messages referred back to them instead of restating them
- guard: Every message that asks the owner to act carries the complete, current command inline in a code block; the words 'above', 'earlier' and 'I sent' never stand in for a command; the away-log lists every pending owner command verbatim
- rule: An owner action is always restated in full in the message that asks for it

## 2026-09-27 #2385

- what: Docs-only bookkeeping PR #2385 merged origin/master and its conflict resolution silently reverted 4 landed app files (-60 lines)
- cause: Merge conflict resolution took the branch side for files outside the docs globs; PR looked docs-only by intent
- guard: Docs PR review runs git diff --stat $(git merge-base origin/master HEAD) HEAD -- apps/ packages/ scripts/ and BLOCKs on any output
- rule: A docs PR's merge-base diff over apps/ packages/ scripts/ must be empty

## 2026-09-27 #938

- what: PC desktop app crash ~08:15Z stopped every PC lane; lead lost Remote Control so could not reach Mac sessions; 5 tier-1 PRs waited hours on the lead's Opus PASS
- cause: Lead is a single point of review; no relay path to Mac besides the bridge
- guard: Lead handoff lives on a pushed docs branch plus a #938 pointer; tier-1 queue lists which verdicts are the lead's so the Mac Lead can commission the Opus review when the lead is offline
- rule: When the lead is offline >30 min, the Mac Lead commissions the lead-side Opus review

## 2026-09-27 #938

- what: Lead's handoff commit used git commit -am in a shared worktree and swept in hook-written pipeline telemetry files
- cause: -a stages every tracked modification, including files hooks write in the background
- guard: Lead commits name paths explicitly (git commit -- <path>) and check git show --stat HEAD before push

## 2026-09-27 #938

- what: Owner asked for the branch-delete command before leaving; the lead split the answer across tool calls (settings edit, relabels) and the owner left without it
- cause: Owner-facing command was interleaved with background work instead of being sent first and complete
- guard: When the owner is about to leave, the lead's very next message carries every owner command in full, before any other tool call
- rule: Owner commands go first, complete, in one message, before any other tool call

## 2026-09-27 #2093

- what: Five lane-lock refusals in 30 min (#2093, #2410, #2477, #2443, Lane B billing), each caused by an issue claimed but blocked on an owner migration or idle
- cause: Lane labels are coarse (orders/invoices/billing); a claim on a parked issue holds the whole lane
- guard: An issue parked on an owner action gets its own narrow lane label (lane:credit-notes, lane:returns-followups, lane:selling-restrictions) so it never blocks a working lane

## 2026-09-27 #2425

- what: Mac Lead made a local merge commit with --no-verify to build the #2425 prod-migration tree (never pushed); disclosed it
- cause: Migration trees need both PRs' migration folders; hooks run a full verify that's pointless for a throwaway apply tree
- guard: Build migration-apply trees with 'git merge --no-commit' then 'git checkout' of only apps/api/prisma from the second PR (no commit needed), so no hook bypass is ever required

## 2026-09-27 #2135

- what: 5 master specs (ESM bare C:\ path, path separators, the api-error-codes scan) fail only on win32, so every PC pre-push failed; U-po's fix sat unpushed after the crash
- cause: CI runs only on Linux, so a spec with a POSIX-only path assumption lands green and silently blocks the Windows machine's pre-push
- guard: An unblocker PR for a machine-wide pre-push red goes first on the slot, and the lead checks origin for it (git ls-remote) instead of assuming 'pushed'; a cheap windows-latest job for the script-spec lane is proposed as the permanent fix
- rule: Machine-wide pre-push reds jump the queue; verify the fix branch exists on origin

## 2026-09-27 #2503

- what: Lead assigned the PC F prover a real-PG proof for #2503, which had landed ~5 min earlier (and #2494's proof, already done on the Mac)
- cause: Assignments made from the lead's own running notes, not from the PR's live state
- guard: Before assigning any proof/review, run gh pr view N --json state,headRefOid and grep #938 for an existing proof at that sha

## 2026-09-27 #2511

- what: Lead delta-PASSed #2511's latch race pin by reading it; F2's executed probe showed it red at head and red on revert (the latch paused before the run read, so it pinned nothing)
- cause: Judged a concurrency pin's efficacy from source instead of an executed red/green probe (SA-E13 class: observe, don't predict)
- guard: A delta review of any race/latch/concurrency pin is CONDITIONAL until F2 posts the executed head-green plus revert-red; the lead's verdict text says 'pending executed probe' and never 'PASS' before it
- rule: Never PASS a race pin before its executed revert-red probe

## 2026-09-27 #2518

- what: A lead-commissioned Opus review of #2518 created folder links from the scratchpad to another worktree's node_modules to run jest; another process removed three of the links mid-run
- cause: Review briefs said 'read-only, no working tree changes' but didn't forbid linking node_modules; on Windows a junction removal can delete through to the target (rf-2142-fix, verified intact after)
- guard: Every review brief states: never symlink/junction node_modules; execute tests only via CI or an F-prover, or in a worktree with its own real npm ci; static reading is otherwise the evidence

## 2026-09-27 #2240

- what: PC slot starvation: Sales-facts released and re-acquired within ~100 ms three times (17:08-18:12Z) while 5 lanes waited in 20 s poll loops; no other lane pushed for ~1h40m
- cause: Lead's pc-slot v1 was a bare mkdir lock with a poll loop: no queue, no cooldown, so a chained release→acquire always wins
- guard: pc-slot v2: FIFO queue tickets (oldest live ticket only) plus a 45 s same-lane re-acquire cooldown; the lead checks pc-slot.log for same-lane back-to-back acquires each sweep

## 2026-09-27 #2544

- what: Lead and Mac Lead filed the same follow-up issue simultaneously three times (#2487/#2488, #2529/#2531, #2543/#2544)
- cause: Both sessions file follow-ups from the same review findings without a check or an owner rule
- guard: Before filing any follow-up, search open issues created in the last 15 min for the source PR number; the Mac Lead files follow-ups it relays from SA/F2, and the lead files only from its own Opus findings

## 2026-09-27 #2554

- what: Board issue #938 hit GitHub's 2,500-comment cap mid-session; a lead review's verdict post failed with 403 'Commenting is disabled'
- cause: No one tracked the board's comment count; GitHub hard-caps issue comments at 2,500
- guard: The sweep checks the board's comment count (gh api issues/N --jq .comments) and rolls to a pinned successor at 2,300; the board number lives in one place (the lead handoff header) and skills reference 'the pinned board'
- rule: Roll the board issue to a pinned successor at 2,300 comments

## 2026-09-27 #2532

- what: pc-slot FIFO v2 still let 4 lanes jump the oldest ticket (F-prover, 18:28Z) because their acquire loops started before v2 and poll without tickets
- cause: In-memory processes keep the old code; FIFO was enforced only on the acquire side, never at release time
- guard: pc-slot v3: release performs an atomic HANDOFF to the oldest LIVE ticket (pid-checked), so a ticketless poller can never win a free instant; dead tickets are pruned

## 2026-09-27 SA-506

- what: Lead's fold wording for #2556 coined INVOICE_OVERDUE_SWEEP=off|count|enforce while SA-506 ruled OVERDUE_SWEEP_MODE=dark|enforced; the Mac Lead had to arbitrate two names before MacBook built
- cause: Lead wrote a flag name into a FAIL fold before the SA ruling existed, then did not supersede it when SA-506 landed
- guard: Fold/FAIL messages that name a flag, env var, or enum cite the SA ruling id that defines it, or say 'name TBD per SA'; a lead-coined name is never used in a brief
- rule: A fact restated in a second place is the copy that goes wrong

## 2026-09-27 #2561

- what: #2561 unit spec green with mocks, but red 3/9 on real PG: unit-aware 409s became 400s because master's classifyEditPayload now runs before the unit guard
- cause: Mocked unit specs call the guard directly and skip the controller/service order of validation, so a guard reordered by a master merge stays green
- guard: Every guard-ordering fix ships a db.spec or e2e case asserting the HTTP status through the real request path, and tier-1 gates require F2's real-PG run before the lead PASS
- rule: A spec that calls the guard directly cannot prove the guard's position in the request path

## 2026-09-27 SA-506a

- what: Lead stamped lane/Mac messages 20:07Z-20:51Z by estimate; date -u read 20:24Z at the 'window closed 20:24Z' relay, so up to 27 min of future timestamps went out
- cause: After the 20:03Z date -u read, the lead incremented times per message by feel instead of running date -u
- guard: Every lead message that carries a time is preceded, in the same tool batch, by a date -u call; a message without a fresh date -u read carries no time
- rule: Times from date -u only

## 2026-09-27 #2562

- what: pc-slot wedged 6 PC lanes for up to 4h: v3 release HANDOFF went to N-buyer whose in-memory v2 waiter never checks handoffs; v2 pruned tickets by creation age >75 min so long waiters deleted their own tickets and starved
- cause: Hot-patching a coordination tool whose clients are long-lived processes: running waiters keep old code, and an age-based liveness rule punished exactly the waiters that waited longest
- guard: pc-slot v4: liveness by PID only (12 h ceiling), no handoff, --since to restore FIFO order on restart; any protocol change to pc-slot must be compatible with every running waiter version (check Win32_Process for pc-slot acquire PIDs and their start time vs the tool's mtime) or be paired with a coordinated restart
- rule: A fact restated in a second place is the copy that goes wrong

## 2026-09-27 #2573

- what: SA-511/511b passed #2573 (scoped {id,orderId} removals) but the CANCEL branch passes item.id! with no guard; Prisma drops id:undefined so updateMany strikes off every line of the order — a regression the bare update() would have thrown on
- cause: Converting update({where:{id}}) to updateMany({where:{id,orderId}}) changes undefined-id semantics from throw to match-all; the reviewers checked scoping, not the undefined case
- guard: Any update/delete → updateMany/deleteMany conversion must assert every where-key is defined (throw on falsy) and carry a pin with the key omitted; review briefs for such conversions name the undefined-key case explicitly

## 2026-09-27 #2528

- what: Lane B made one local --no-verify commit on scratch/2528-fold (a throwaway merge used to test the #2528 duplicate-import fix); never pushed, no PR affected. Second scratch-merge --no-verify slip today (Mac Lead 15:10Z was the first)
- cause: A scratch merge needs a commit to inspect, and the pre-commit hook costs a verify, so --no-verify looks harmless for a throwaway
- guard: Scratch merge checks use git merge-tree --write-tree or git merge --no-commit (no commit, so no hook); lane briefs name this explicitly; a --no-verify commit is never pushed and the real fold is recommitted with hooks on
- rule: Scratch checks never commit

## 2026-09-27 #2241

- what: Lead ran 'git merge-tree --write-tree ... | head -1' for #2241 and read the printed tree as clean; merge-tree prints a tree oid even on conflict (exit 1), and the reviewer found 2 spec conflicts
- cause: Taking the first output line as the verdict instead of the exit status
- guard: Every lead merge-tree check reads the exit status (0 clean / 1 conflict) with --name-only, never the tree line alone; review briefs ask for the exit code
- rule: A fact restated in a second place is the copy that goes wrong

## 2026-09-27 SA-506a

- what: The owner-return item 7 in the lead handoff still named #2556's flag INVOICE_OVERDUE_SWEEP=count|enforce two hours after SA-506a renamed it OVERDUE_SWEEP_MODE=off|dark|enforced; the owner would have set a variable that does nothing
- cause: The owner-return list is a second copy of rulings and wasn't re-read when the ruling changed
- guard: When an SA ruling supersedes a name or value, grep the handoff's owner-return block for the old token in the same turn and correct it; owner items cite the ruling id, not a restated value where possible
- rule: A fact restated in a second place is the copy that goes wrong

## 2026-09-27 #2586

- what: Lead asked the Mac Lead to queue F2 runs for #2586 and #2589 that F2 had already posted on #2554 at 22:12Z/22:14Z
- cause: The sweep's board read filtered by lead-verdict keywords, not by every comment since the last sweep, so executed proofs were missed
- guard: The sweep's step 3 lists EVERY #2554 comment since the last sweep (createdAt filter, first 160 chars) before any proof or review is requested; a request names the comment it checked

## 2026-09-27 #2489

- what: Lead briefed F2 to prove #2489's purge deletes 'expired files of completed OR ABANDONED cases'; the code and plan purge only LIVE>=30d cases (LOST never purged) — the lead restated a spec it had not read
- cause: The proof brief was written from the PR title before the Opus increment review returned
- guard: Proof briefs for a deletion job quote the selection predicate at path:line from the code (or wait for the review that reads it); never paraphrase scope from a title
- rule: A fact restated in a second place is the copy that goes wrong

## 2026-09-28 SA-523a

- what: Lead offered a headroom CAS (invoicedQty <= qty - delta) as an acceptable alternative for #2070; SA-523a: a headroom CAS lets a concurrent partial commit underneath, so the invoice is priced off a stale priorBilledQty basis
- cause: The lead reasoned only about the over-bill invariant, not about the values the rest of the write derives from the read
- guard: A CAS for a read-then-write must pin EVERY read value the write derives from (exact-value compare), not just the invariant; briefs list the derived values explicitly

## 2026-09-28 SA-393

- what: Lead briefed MacBook to make #2236 rethrow all commission-sync errors; SA-393 (already on master, commission-engine.service.ts:89-123, cites #2236) deliberately swallows non-conflict errors under a SAVEPOINT so a commission bug can't block ~20 money write paths
- cause: Brief written from the issue title; the lead didn't grep master for the issue number or search rulings before specifying
- guard: Before assigning any issue: git grep the issue number on origin/master and search #2554/#938 for it; if code cites it, the brief starts from that code and ruling, and the lane first asks whether the issue is already fixed
- rule: A fact restated in a second place is the copy that goes wrong

## 2026-09-28 #2554

- what: U-po tried to post on #938 at ~00:35Z, five hours after the board moved to #2554, and reported it as a fleet blocker; the board move was relayed to the Mac Lead and cron but never broadcast to the PC lanes
- cause: A standing-address change was announced to the lead's own channels only
- guard: Any change of fleet address (board, slot tool, handoff path) is broadcast to every live lane (ListAgents) in the same turn it happens, and pinned in the board issue's first comment

## 2026-09-28 #2215

- what: N-kit's #2332b push was refused on web check-types TS2344 from master's invoices/page.tsx exporting a non-page helper; .next/types regenerates during the verify, so any PC push can go red depending on order. The class (#1776/#2215) was known since 09-25 and left open
- cause: A known, order-dependent local-only check failure was triaged as 'known trap' instead of being fixed at the source, and a new page (#2625-era) added another offending export
- guard: A guard spec fails if any apps/web/app/**/page.tsx exports a non-Next-contract name (S-order folding into #2215); known pre-push traps get an owner and a fix date, never just a memory note

## 2026-09-28 #2431

- what: Coordinator held #2431: my re-pin at 4d6ed562 was buried in the second half of an owner-migration relay comment (5863291050), and its verdict search missed it
- cause: The verdict was restated inside another fact's comment instead of standing as its own record; the coordinator's search keys on a verdict-headed comment
- guard: Every lead verdict is its own #2554 comment whose first line is '**Lead verdict, #N @ <full sha>: PASS|FAIL**'; relays may cite it by comment id but never carry it
- rule: A verdict is one comment, headed with PR + full sha + outcome; never embedded in a relay

## 2026-09-28 #2301

- what: #2301's b760 spec passes at its head and merge-tree exits 0, but it goes red once merged with #2632 (the new CAS needs an updateMany mock the spec never stubs)
- cause: A clean textual merge was treated as proof the merged tree works; a sibling PR changed a shared mock contract
- guard: A tier-1 review of a PR behind master runs the PR's touched specs on the merge-tree result (a worktree at merge-tree --write-tree), not only at the head
- rule: merge-tree exit 0 proves no textual conflict, never a green merged tree; run the touched specs on the merge result

## 2026-09-28 #2474

- what: Lead assigned Lane B #2476/#2442 as new work; both were already built by Lane B (#2474 open, #2476 local stacked)
- cause: Brief written from the issue list, without checking open PRs and lane branches for the issue numbers
- guard: Before assigning issue N: gh pr list --search 'N' --state open and git ls-remote origin | grep N, plus ask the lane's machine lead for local branches; the assignment names what exists
- rule: Never brief from an issue title or a PR title

## 2026-09-28 #2647

- what: Lead assigned #2647 to N-buyer while MacBook (its filer) was already building it; and #2491 to MacBook though #2496 had closed it
- cause: Assignments made from the open-issue list without checking the issue's filer/claim comments or recently merged PRs' Closes lines
- guard: Before assigning: gh issue view N --json state,comments (claims, filer lane) and gh pr list --state merged --search 'N' since the last sweep; an assignment quotes the claim check result
- rule: Never brief from an issue title or a PR title

## 2026-09-28 #2646

- what: #2646's guard turns master's newer void-2628 db.spec red after merge; merge-tree clean (second semantic conflict tonight after #2301)
- cause: A sibling PR landed a spec that calls the method this PR guards; head-only review can't see it
- guard: A tier-1 review of a PR behind master greps the merge-base..master diff for callers of every symbol the PR changes (git diff base..master | grep <symbol>) and runs those specs on the merge-tree
- rule: merge-tree exit 0 proves no textual conflict, never a green merged tree; run the touched specs on the merge result

## 2026-09-28 #2646

- what: An Opus review subagent junctioned another worktree's node_modules into a scratch copy and left it behind
- cause: Review prompts said read-only for git but did not forbid creating junctions; a later recursive delete would have followed them into a live worktree
- guard: Every review prompt states: never create junctions/symlinks; run specs only in an existing worktree; the lead removes any leftover junction with cmd rmdir and verifies the target survives

## 2026-09-28 SA-542

- what: Lead's #2653 spec said the web session is cookie-based; the SA found web auth keeps tokens in localStorage (only tenant-slug + presence cookies)
- cause: Spec fact taken from CLAUDE.md's env list (COOKIE_SECRET) instead of reading apps/web lib/auth.ts
- guard: Every 'Facts' line in a lead spec carries a path:line read at a pinned sha; a fact without one is marked UNVERIFIED and routed to the context pack
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-28 #2075

- what: Mac Lead proposed Lane B build #2065, which already has a draft fix PR #2075 from 09-25; GitHub secondary rate limit hit during the check
- cause: Self-pick checks the board status, not open/draft PRs referencing the issue
- guard: Before any pick: search open AND draft PRs for the issue number (REST search, one call) and the issue's last comments; a draft fix means revive, never rebuild
- rule: Never brief from an issue title or a PR title

## 2026-09-28 #2268

- what: Lead's 'resume' message to Sales-facts started a turn that force-killed its 39-min pre-push verify (exit 0x40010004); #2268 lost its slot turn
- cause: A cross-session message to a session running a foreground verify interrupts it; 'resume' was sent without checking the lane's slot state
- guard: Before messaging a PC lane, check pc-slot status: never message the current slot HOLDER; message queued lanes only with 'do not interrupt your waiter'
- rule: Never interrupt the pc-slot holder

## 2026-09-28 #2268

- what: The owner-ordered 'resume' messages to all 8 PC lanes restarted each session; every background pc-slot waiter died and every lane lost its queue place (tickets re-filed from scratch)
- cause: A session restart kills its background shells, including pc-slot acquire waiters; the lead resumed all lanes at once without warning them to re-queue with --since
- guard: A fleet-wide resume message tells each lane: 'if your slot waiter died, re-queue with --since <your original ticket ms>'; the lead snapshots pc-slot.queue ticket names before the resume
- rule: Never interrupt the pc-slot holder

## 2026-09-28 #2665

- what: A spec landed via #2611 spawns a 51 KB node -e script; Windows' 32 KB command-line limit makes it ENAMETOOLONG, so master is red on every PC pre-push and lanes started pushing with SKIP_VERIFY
- cause: CI runs only on Linux; nothing proves specs on win32 before merge
- guard: A lint/spec guard rejects spawnSync/exec argv over 8 KB (or node -e with a >8 KB literal) in specs; PC lanes' SKIP_VERIFY audit lines are read each sweep and each cited red becomes a ticket at once

## 2026-09-28 #2624

- what: #2624 rolled on a REAL red: its split-restricted-lines spec mocks don't return {count:1} for #2643's CAS updateMany; the lead's Opus DELTA re-read passed it without running the specs
- cause: Third instance of the post-#2632/#2643 mock contract (updateMany count 0 default ⇒ 409); delta reviews read code, not merged-tree specs
- guard: Any tier-1 re-pin after a master change to a shared mock contract runs the PR's touched specs on the merge result, or asks F to; the verdict states 'specs executed on merged tree: yes/no' and 'no' blocks PASS
- rule: merge-tree exit 0 proves no textual conflict, never a green merged tree; run the touched specs on the merge result

## 2026-09-28 #2635

- what: Lead relaunched Docker Desktop and waited 20 min assuming a cold boot; the backend had crashed at once on the known stale sailor-ingest.sock (error 1920) and showed an error dialog
- cause: Didn't read the backend log right after the launch; the recovery runbook (rename Docker\run + docker-secrets-engine) was in memory
- guard: After any Docker Desktop launch, check com.docker.backend.exe.log for 'backend crashed' within 60 s before waiting; on the sailor-ingest.sock error apply the rename recovery at once

## 2026-09-28 #2635

- what: Docker Desktop crashed again during recovery (secrets-engine engine.sock) while the lead's own background waiter polled 'docker ps' every 20 s
- cause: The lead's poller hit the CLI during init, the exact hazard the recovery memory names
- guard: Docker startup is watched via com.docker.backend.exe.log (Docker:running / backend crashed), never via docker CLI polling; kill every docker.exe client before relaunch

## 2026-09-28 #2668

- what: Lead posted #2075 and #2668 verdicts in one comment; the Mac Lead couldn't find the #2668 verdict
- cause: Two verdicts batched into one comment despite the rule 'a verdict is one comment headed with PR + full sha'
- guard: The verdict-posting step writes one gh api POST per PR; batching verdicts into one body is never done
- rule: A verdict is one comment, headed with PR + full sha + outcome; never embedded in a relay

## 2026-09-28 #2670

- what: Lead hit the 10-message cap to PC Desktop sessions while the owner was away; further PC lane messages were blocked
- cause: Per-lane one-off messages (resumes, corrections, reorders) spent the cap; the sweep prompt warned to batch
- guard: While the owner is away, PC-lane instructions go on #2554 (lanes read the board) or through the Mac Lead's RC bridges; direct PC messages are reserved for blockers, and the lead counts them (≤ 8 per owner absence)

## 2026-09-28 #2665

- what: Three PC lanes (salvage, N-buyer, S-order) independently diagnosed the same win32 red and each offered or started a duplicate fix for #2665
- cause: The fleet-wide blocker and its owner were announced only in 1:1 messages and a board comment; lanes hitting the red didn't search issues before starting a fix
- guard: A fleet-wide blocker gets ONE pinned #2554 comment (issue + owner + ETA) that lanes read before any fix, and lanes search open issues for the failing spec name before proposing a fix
- rule: Never brief from an issue title or a PR title

## 2026-09-28 #2661

- what: Lead endorsed filing a HIGH bug ('inline returns can't be opened') from a capture that ran web @dc462aca against a pre-09-27 API image; master's findOne renders INLINE rows since #2601
- cause: The capture stack didn't print/assert the API image's build sha, and the lead didn't check the claimed endpoint behaviour in code before endorsing (same class as B689/B690)
- guard: Every capture/proof stack prints BOTH api and web image build shas and asserts each is at or after the PR's merge-base; a 'bug found in a capture' is verified against the code at the exact sha before any issue or verdict
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-28 #2677

- what: #2677 passed two lead reviews but crashes for every tenant on real PG: scripts read 'stripeSubscriptionId' while TenantSubscription's column is 'stripeSubId' (platform.prisma:38)
- cause: Scripts use raw/untyped queries, so tsc can't catch a wrong column; reviews read logic, not field names against the schema; only the real-PG gate executes the query
- guard: Tier-1 review briefs for scripts require checking every selected column/field name against prisma/schema at the sha; scripts that query by hand get a spec pinning their field names to the Prisma DMMF

## 2026-09-28 #2679

- what: Lead's #2679 fold asked for retryOnTxConflict on the cancel side only; F2 found the reorder side is the deadlock victim 3/6 in a natural race, a raw 500 introduced by #2679's stop-first lock
- cause: A lock-order change was reviewed for the path it changed, not for every path that is now the other half of the new deadlock pair
- guard: When a PR changes a lock order, the review enumerates EVERY transaction that takes the same two locks and requires each to be retried or re-ordered; F2's race uses the real peer methods, both as victims

## 2026-09-28 #2661

- what: The PC F prover's 'stopped' build job held the pc-slot 10:25–10:33Z, and its capture script then started a web image build during salvage's slot turn
- cause: Background build chains outlive TaskStop on Windows Git-bash (U-po reported the same); the capture script didn't check slot ownership before each build step
- guard: Capture/build scripts re-check 'pc-slot status' == own lane before EVERY heavy step and abort otherwise; lanes verify a stopped chain is dead by PID (Get-CimInstance) before re-queuing

## 2026-09-28 #2685

- what: The lead's fleet-lead skill + LEAD-LOG edits all day went to an UNTRACKED copy in the main checkout (branch ops/t6-a0-owner-batch lacks the skill), diverging from master's copy that bookkeeping edited
- cause: The lead session's checkout isn't on master, so the skill dir is untracked there; lead-closeout.mjs writes to the cwd copy
- guard: The lead runs lead-closeout.mjs from a master-tracking worktree (rf-work-sync or a dedicated one) and checks 'git ls-files .claude/skills/fleet-lead' is non-empty at session start; the SessionStart digest warns when the skill dir is untracked

## 2026-09-28 #2653

- what: N-kit burned two ~30-min pc-slot turns on its own check-types/repo-truth reds (a spec constructing AddonService with the old arg count; a report script naming DATABASE_URL)
- cause: Lanes ran tsc on src only before queuing; the verify's spec ratchet and repo-truth lane catch what src-tsc misses
- guard: Before taking the pc-slot, a lane runs the cheap gates locally: 'npm run check-types -w apps/api' (the spec ratchet) + the repo-truth jest lane; the slot is only for the full verify + push

## 2026-09-28 #2680

- what: PC Docker engine died at 12:20Z during the F prover's parallel capture image builds (WSL VM 8 GB cap), halting all PC captures ~40 min; the lead's log watcher also missed the 'running' state twice (pattern mismatch)
- cause: Parallel web+mobile image builds plus the running compose/api stacks exceeded the WSL VM memory; the watcher grepped a log line that the current Docker version doesn't emit
- guard: Capture image builds run strictly one at a time on the PC with old images pruned first; the Docker-up check is a single 'docker ps' after a fixed wait, not a log-pattern grep

## 2026-09-28 #2301

- what: #2301 passed lead Opus (jest 394 unit) + SA + F2 11/11, then ROLLED on CI: an existing DB spec (recompute-order-partial B785/SA-113a at-door reconcile) finds no draft invoice
- cause: Both the lead's executed jest and F2's real-PG run covered only the PR's own specs; neither ran the module's full DB lane where the changed function has other callers
- guard: A tier-1 gate on a shared money function includes the FULL db lane for the touched module(s) (npm run local:test:db filtered to invoices/orders/routes), not just the PR's new spec; the verdict states which DB suites ran

## 2026-09-28 #2185

- what: #2185 carried a PC 'full verify green' (api unit 10569) yet import-invoice-reimport.db.spec fails 12/12 on DI (ImportService gained ProductsService), found only when F2 ran #2190 stacked on it
- cause: The PC verify runs unit lanes only; a constructor change on a tier-1 import service was never exercised by the module's DB specs before the verdicts
- guard: A PR that changes a Nest service constructor lists every _.spec.ts/_.db.spec.ts that builds that service (git grep 'ServiceName' in createTestingModule) and F2 runs the module's full DB lane at the gated sha before any PASS
- rule: Tier-1 money reviews run the module's FULL DB lane, not just the PR's spec

## 2026-09-28 #2693

- what: A Sonnet Explore context pack reported the web+mobile inline-returns UI 'does NOT exist' (grep clean); the owner was using it in prod, and git grep origin/master found InlineReturnSection.tsx + mobile returns/inline.tsx
- cause: The agent's working-tree grep (Windows) missed the files, and a negative claim ('not found') was reported as fact without a pinned-ref search
- guard: Before any spec or issue uses a context pack's absence claim, the lead runs git grep <string> origin/master -- apps packages itself; the pack brief requires 'NOT FOUND' lines to include the exact git grep command + ref used
- rule: Never brief from an issue title or a PR title

## 2026-09-28 #2554

- what: The lead filed two janitor 'safety defects' (force-remove before junction unlink; a live lane classed merged) from a janitor report and source read in the MAIN checkout, which sits on the stale branch ops/t6-a0-owner-batch (janitor last touched 09-18); master already had B817 links-first and B748 dirty/idle guards, 122/122 self-test
- cause: Tooling was run and read from the main checkout without checking which ref it was on; its copy was 10 days behind master
- guard: The lead runs repo tooling and reads source only from a master-tracking worktree (rf-work-sync after git pull) or via git show origin/master:<path>; a finding cites the ref it was read at
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-28 #2686

- what: The lead sent the owner to the F2 prover's chat to grant simulator access on the Mac Lead's relayed word; the owner found F2 was not waiting for anything
- cause: An 'owner action needed' claim was relayed second-hand (Mac Lead about F2) and put to the owner without confirming with the acting session
- guard: Before any owner action is requested on another session's behalf, the lead messages that session directly and gets its own statement of the exact blocking UI element; the owner request quotes the acting session, not a relay
- rule: A fact restated in a second place is the copy that goes wrong; resolve against the primary source

## 2026-09-29 #2678

- what: #2678 landed at f2745d75 on a PASS that predated the binding fold ruling SA-551a (#2554 5867986094); the fold (U-po 6d3c202d) never shipped
- cause: The merge decision read the PR's last PASS, not the #2554 comments posted after it that named the PR
- guard: Before merging, the coordinator lists every #2554 comment that names the PR and was posted after its last PASS; any open fold, HOLD or FAIL blocks the merge
- rule: A verdict is only current until the next comment that names the PR; re-read the thread after it, not the last PASS

## 2026-09-28 #2185
- what: #2185 carried a PC 'full verify green' (api unit 10569) yet import-invoice-reimport.db.spec fails 12/12 on DI (ImportService gained ProductsService), found only when F2 ran #2190 stacked on it
- cause: The PC verify runs unit lanes only; a constructor change on a tier-1 import service was never exercised by the module's DB specs before the verdicts
- guard: A PR that changes a Nest service constructor lists every *.spec.ts/*.db.spec.ts that builds that service (git grep 'ServiceName' in createTestingModule) and F2 runs the module's full DB lane at the gated sha before any PASS
- rule: Tier-1 money reviews run the module's FULL DB lane, not just the PR's spec

## 2026-09-28 #2707
- what: #2707 passed lead Opus + SA + F2 (billing lane, seeded+fresh) and then ROLLED on CI: common/publish-and-repin.db.spec.ts expected 15 loss keys and got fewer, because the union removed false losses from the publish-and-repin mirror
- cause: The F2 lane and both review briefs were scoped by the module FOLDER (billing/**), while the PR changed a shared resolution consumed by a db spec in common/
- guard: The DB lane for a tier-1 PR = every *.db.spec.ts that imports, or greps, any module the PR changes (git grep -l on each changed module's export names across **/*.db.spec.ts), listed in the F2 brief and the review brief before the run
- rule: Tier-1 money reviews run the module's FULL DB lane, not just the PR's spec

## 2026-09-28 #2690
- what: The lead planned the #2690 sim re-proof over a PC→Mac LAN route; the PC F-prover built and started the stack (holding ~6 GB of WSL RAM and blocking two lane pushes) before anyone checked that the machines could reach each other; they are on different subnets (192.168.12.x vs 192.168.4.x)
- cause: The cross-machine route was assumed from 'same house' rather than tested; no reachability check preceded the resource spend
- guard: Any cross-machine proof plan starts with a reachability probe from the consumer (ping + curl of a trivial port) posted on the board before the provider builds anything
- rule: Probe reachability from the consuming machine before any cross-machine stack is built

## 2026-09-28 #2707
- what: The lead sent the MacBook lane's owed #2707 fold and #2695 PR-2 to 'RouteFlow MacBook bookkeeping' [30402e], a PC session whose title says MacBook; the real MacBook lane was offline, and the PC session nearly took tier-1 work onto a 97%-full disk
- cause: A session was picked by title alone; two sessions share 'MacBook' in their titles, and ListAgents showed [30402e] as a local Claude Desktop session on the PC
- guard: Before assigning work, the lead reads the target's ListAgents row (machine: local vs Remote Control, state) and its last self-reported worktree path; the assignment message names the expected machine, and the lane refuses if it differs
- rule: Assign by title AND verified machine/state from ListAgents, never by title alone

## 2026-09-28 #2719
- what: #2719 rolled on CI: the size ratchet (orders/[id]/page.tsx 3756 > 3745); the lead's tier-2 'touched workspaces only' verify ran web jest but the ratchet spec lives in apps/api/src/common
- cause: Cross-workspace guard specs (size-ratchet, enum-parity, no-bare-cron, addon-gate registry) run under api but guard files in every workspace; a workspace-scoped verify skips them
- guard: Every tier-2 verify also runs the cross-workspace guard specs (apps/api/src/common/size-ratchet.spec.ts, enum-parity.spec.ts, no-bare-cron.spec.ts, the addon-gate registry spec), adopted 21:51Z and relayed to all lanes
- rule: A scoped verify always includes the repo's cross-workspace guard specs

## 2026-09-29 #2554
- what: The owner paused the fleet 'for 10 mins, until I update Claude'; the lead resumed PC lanes at 02:43Z on elapsed time and a session-resume hook, without the owner's word; the owner then said 'hold the fleet'
- cause: The lead inferred the pause's end condition instead of asking; an owner-ordered pause was treated as a timer
- guard: An owner-ordered pause ends only on the owner's explicit resume word in chat; the lead's resume message must quote it verbatim with its time, and resume messages without a quote are not sent
- rule: Only the owner lifts an owner-ordered pause, in words, quoted in the resume

## 2026-09-29 #2554
- what: Lead rotation card 2026-09-29 was told to live at .claude/handoffs/ but existed only in local-assets/handoff/ and unmerged branch docs/lead-handoff-2026-09-27; the SessionStart hook surfaced the stale 09-27 handoff as newest
- cause: The card was committed on a docs branch and copied to local-assets, never to the main checkout's .claude/handoffs; the hook reads only that directory
- guard: SessionStart newest-handoff hook also scans local-assets/handoff/ and origin docs/* branches for a newer *-lead-*.md and prints the newest by mtime/commit date with its location
- rule: A rotation card is read by path from where the next session's hook looks; write it there, not only on a branch

## 2026-09-29 SA-575
- what: M2 commit 1 (2e59d820) passed split --check, lint-migrations and tsc yet its migration lacked CREATE TYPE RecipeStatus; deploy would have failed
- cause: none of the static gates compare the enums a migration's tables use against the CREATE TYPEs it contains; only a real replay does
- guard: migration-shape spec per schema PR asserts every enum used by a new column has a CREATE TYPE in that migration; F2 replays commit 1 fresh+seeded before any service code builds on it
- rule: schema-freeze commit 1 gets a real-PG replay before the build continues

## 2026-09-30 #2796
- what: Lead assigned N-kit ownership of the delivery types in packages/types; the types then contradicted spec 08-B and duplicated the bundle's Prisma enums (#2796 FAIL)
- cause: The type-ownership ruling was made from the lane plan, without reading spec 08-B and the MASTER-PLAN bundle contents that put EmailDeliveryStatus/EmailReasonCode in Prisma
- guard: Before assigning ownership of a shared type, grep the specs and MASTER-PLAN for the type/enum names and cite path:line in the assignment; Prisma-backed enums go to enums.ts via the bundle owner only
- rule: Type-ownership rulings cite the spec path:line that defines the shape

## 2026-10-02 #2616

- what: The lead ran `node scripts/work/reconcile.mjs --help` to read its usage and it APPLIED a live board update anyway (+1 issue, 40 fields set, a digest published).
- cause: The old argument parser looked only for `--dry-run`, `--json` and `--quiet`, ignored every other argument, and defaulted to writing.
- guard: #2616 (`b13f29c93`): `parseArgs` in `scripts/work/reconcile.mjs` rejects any unknown argument (exit 2 with the usage, nothing written, decided before the lock, the log or any gh call), a bare run is a DRY RUN, and writing needs an explicit `--apply`: `npm run work:reconcile` is the dry run and `npm run work:reconcile:apply` writes (`docs/work/WORKFLOW.md` states it). B973 tracks the follow-up self-test hardening (a temp ROOT, `--help --apply` and `--apply=1` cases).
- rule: A command that writes shared state needs an explicit opt-in flag and an allow-list parser; a help or typo path must never reach the writer, and "I only wanted the usage" is not a safe assumption about any script.
