# The SA's own errors, generalized (one seat, one night) — and the rule each produced

Classes: **A** stale/second-hand · **B** untraced path · **C** unforced work · **D** correctness traded for flow.

| id | class | what happened | rule |
|---|---|---|---|
| E9 | B | Passed a ledger PR after reading two reversal writers; the third still booked the box axis | A ruling that moves one axis is checked against EVERY writer of that axis (grep the field) |
| E10 | B | Sent eight rulings to an unreachable address for hours | The first cross-machine send is a probe whose result is READ; a failed send is an open item |
| E11 | B | Ran a query on the prover's shared stack without asking | Shared stacks belong to their prover; clear any use, even read-only, through the lead |
| E12 | A | "Confirmed tracked from here" sent before the check's output was read | State a result only from output already in hand |
| E13 | A | Predicted red values (−5, −60) without running the reverted code | A red-first instruction names the case and says "observe and report"; a number appears only when run |
| E14 | A | Reported a commit position the lead had already moved past | Never report another session's position; say "at rest" and let it read the files; cite the branch head |
| E15 | A | Halted a lane on two sequential messages read as contradictory | The newer message from one sender supersedes; ask for the verbatim record, never halt a lane building the item common to both lists |
| E16 | A | Named `{10,3,1}` as non-derivable; `(10−1)/3 = 3` | Run the fixture through the real helper before writing the expected value |
| E17 | B | Named a price-only edit as the red case; the branch's entry condition excludes it | A red case names the entry condition it passes through |
| E18 | B | Named a stale set (stock delta) that the lock already made live | Read the lock and the read sites AND the entry condition before naming what is stale |
| E19 | B | Ruled clients branch on `replayed: true`; the flag was a service-local variable discarded at `return result.ret` | A field a client branches on is verified on the wire (the controller's return path), never in a service's local control flow |
| E20 | B | Ruled each quote chunk shows its source invoice number and date; the chunk carries only source ids | A field a client must display is a claim it is on the wire — read the response type before the ruling ships |

Pattern across the night: **a state last observed, reported as current** (A) and **a claim that sounded right and had never been executed against the thing it describes** (B). The fix for both is mechanical — re-derive at the moment of decision, run before writing, name the sha or the output — and the fleet's builders reporting what they observed instead of fitting fixtures is what kept every one of these from becoming the record.

The same shape appeared in six repository controls in one day (a DB test lane not in CI; specs type-checked by nothing; an include-list tsconfig nobody runs; parked tables with no writer; a posted-PASS merge rule not read before `gh pr merge`; a `*.sql` ignore eating an owner-run query): **a control that exists and does not run on what it protects.** Prediction that held: the next instance is a guard added in a PR and never wired into `verify` — one grep of `package.json`/`turbo.json` per new spec config.
