# Verification — the evidence contract

A finding that turns out to be wrong costs more than a finding never made: it burns a developer's
afternoon, and it teaches everyone to distrust the register. Verification is not a formality at the
end of the hunt — it *is* the product.

Measured on this repo: of 53 round-2 candidates, verification **corrected the substance of 6** and
**reversed 2 outright**. Both reversals looked completely convincing in the finder's write-up.

## Refute-first protocol

Give the verifier a *different* agent, a *strong* model (never weaker than the finder for a
critical claim), and this stance:

> Your default position is that this claim is **wrong**. Open the cited files and their
> callers/callees and try to kill it. Only if you fail does it survive.

Force these refutation modes explicitly — each has caught a real false positive here:

| Mode | The question | Real example |
| --- | --- | --- |
| Guard elsewhere | Is the missing check present further up the chain — decorator, service guard, DB constraint, transaction wrapper? | Driver edit-wipe: server forces `replaceAll=false` for DRIVER. Claim died. |
| Branch is reachable | Re-derive the logic yourself; is the "dead" branch really dead? | B46 *was* dead (`setDate(1)` before the test) — the opposite outcome, proven by execution. |
| Already fixed | `git log -S <symbol>` — did a PR fix this and the claim is stale? | Five 2026-08-17 money bugs, all fixed on master. |
| Unreachable path | If no UI or role can trigger it, it's dead code, not a live bug — downgrade. | Several "critical" claims became `low`. |
| Sides actually agree | Read *both* halves of a claimed mismatch fully. | Vendor-bill tax "drop" — the server falls back to the persisted value. Refuted. |
| Do the arithmetic | Never accept a numeric claim you haven't computed. | B46 confirmed by running `calcNextRunAt` across twelve real dates. |
| Wrong app | "No caller exists" — did you grep **both** `apps/web` and `apps/mobile`? | Caused two wrong claims (B13, B24) before it was caught. |

## Verdicts

- **CONFIRMED** — accurate as stated, today, on this SHA.
- **PARTIAL** — real, but the finder got something wrong. Put the correction in `note` and fix the
  entry text. Partials are *valuable*: they're usually a sharper version of the finding.
- **REFUTED** — not a bug. **Keep it**, in the register's *Investigated & Cleared* section, with
  why. Deleting it guarantees someone re-chases it in six months.

## Evidence standard

Every finding carries `path:line` **the agent actually opened** — both the defect site and the
counterpart (the caller, the writer, the guard that should exist). Cite the symbol name too:
line numbers drift with every merge; `calcNextRunAt` does not.

Not evidence: the code map (a map, not the territory — it has been stale), a grep count with no
file read, a plausible-sounding trace, "the docs say", or another agent's summary.

## Runtime confirmation

Static reading settles most claims. When it can't, in order of preference:

1. **Execute the pure function** with concrete inputs — strongest, zero risk. Transcribe it into a
   scratch script and print the results. This is how B46 was proven.
2. **Read-only API/DB query** on `routeflow-demo` — confirms whether the shape exists in real data.
3. **Write path on an approved test tenant only** (`test`, `e2e-routeflow`, `routeflow-demo`,
   `qa-*`, `e2e-*`, `ux-audit-*`), prefixed and cleaned up. Never a live client tenant, ever.
4. **Forensic query** for damage already done — `scripts/data-integrity-report.mjs`, read-only,
   IDs and counts only, never customer data.

Note that `routeflow-demo` is the standing sales-demo tenant: don't leave junk in it.

## Triage before verification, when volume is high

With more than ~20 candidates, put an **Opus** judge between hunt and verify to: merge duplicates
(keeping the strongest evidence from each), drop anything already registered or already fixed by an
open PR, drop enhancements dressed as bugs, and spot-check suspicious evidence by opening the cited
file. Cheaper than verifying the same bug five times from five finders.

## What a finished entry looks like

The triple, in the user's language, plus evidence and a fix:

> **B46 · MONTHLY recurring invoices re-fire every midnight**
> *Meant to do* — a monthly template generates one invoice per cycle, then waits until next month.
> *Actually does* — `calcNextRunAt`'s month-advance is dead code, so `nextRunAt` returns a date in
> the same month, at or before today.
> *The gap* — the cron re-selects the template every midnight; with auto-send on, the customer is
> emailed a fresh invoice daily, indefinitely.
> *Evidence* — `recurring-invoices.service.ts:27-38` (dead branch), `:227-251` (cron filter),
> `:205-214` (autoSend). Traced: nextRunAt 2026-07-15, dom 15 → returns 2026-07-15 unchanged.
> *Fix* — decide rollover from the pre-`setDate(1)` date; assert the returned value across two
> consecutive cycles in the spec.

If you cannot write the gap line in one plain sentence a non-engineer would understand, you do not
yet understand the bug well enough to file it.
