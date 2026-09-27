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

