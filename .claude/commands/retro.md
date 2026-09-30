---
description: Ten-run pipeline cadence: read the ledger's ten-run rules and the RUN-LOG knob candidates since the last retro, apply what is now evaluable, escalate a 3x-recurring candidate to the owner as a written proposal. Not the per-bug postmortem (that is lessons-learned's Record).
---

Not lessons-learned's per-bug Record — this is the cross-run, ten-run cadence. Read-only through
step 4; writes only in steps 5-6.

1. **Due-ness — one clock (hooks' rule).** Filter `.claude/pipeline/cost-ledger.jsonl` rows to
   `telemetry==="true"`; cutoff = mtime of newest `retro-*.md` (0 if none); a row counts if
   `Date.parse(endedAt||startedAt) > cutoff`, else fall back to line index vs `rowCountAtRetro` in
   `.retro-marker.json`. delta = rows counted. RUN-LOG's `## Retro —` heading is informational only.
   **delta < 10 ⇒ print `not due yet (delta/10)` and STOP.**

2. **Ledger evidence.** `node .claude/skills/model-routing/scripts/pipeline-ledger.mjs summary
--project <cwd> --json`: `tenRunRules.cutRules[]` entries with `evaluable:true` and a zero-finding
   verdict, plus any held `cascadeAudit`/`escalation` trade. Zero `telemetry:"true"` rows ⇒ refuse
   the ten-run rules (still do step 3).

3. **RUN-LOG evidence.** Read every entry after the newest `## Retro —` heading in
   `.claude/skills/dev-pipeline/references/RUN-LOG.md` (top of file if none); pull every line with
   "knob candidate" or "candidate knob" (case-insensitive) **verbatim** — unquotable lines don't count.
   Group quotes by mechanism.

4. **Judgment**, over steps 2-3's gathered text ONLY — no other reads. Session is Fable ⇒ rule
   inline, prefixed "Fable ruling:". Otherwise hand the gathered text (≤10 KB, zero file access) to one
   `agent({model:'claude-fable-5-1', effort:'high'})` — never Opus; a declined Fable retries once on
   Opus, logged as a fallback.

5. **Write** `.claude/pipeline/retro-<date>.md`: each evaluable ledger rule ⇒ the CFG flag + the
   summary line justifying it, marked `_proposed_` (never edit CFG/skill files yourself);
   each candidate quoted in 3+ RUN-LOG entries ⇒ one owner proposal citing all its quotes verbatim,
   plus a revert signal (the undo result). Fewer than 3 recurrences ⇒ no proposal.

6. **Write the marker** `.claude/pipeline/.retro-marker.json {lastRetroAt, rowCountAtRetro}` beside
   the retro file (backs step 1's fallback). **Append** `## Retro — <date> · <project> ·
trueTelemetryCount=<N>` to RUN-LOG.md (N = step 1's count; informational only) — the only writer
   of that line. Append even with zero proposals.
