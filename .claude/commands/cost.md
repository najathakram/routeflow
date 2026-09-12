---
description: Print this session's true per-model cost, cache-hit and active time, plus the project's last-10 pipeline baseline. Read-only. Triggers: "how much did this cost", "what did we spend", "token usage", "/cost".
---

Read-only — no writes, no new model spend. Run in order, print each verbatim:

1. `/usage` — the Console-billed baseline for this login. Say plainly that Console Usage is authoritative
   for billing; everything below is a cross-check, not a replacement.

2. `node .claude/skills/model-routing/scripts/session-usage.mjs --latest --all --project <cwd>` — this
   session's true per-model tokens/cost, cache-hit ratio, active vs idle time. No transcript found ⇒ say
   "no session usage yet" — never print `$0` as if it were a real reading.

3. If `.claude/pipeline/cost-ledger.jsonl` exists: `node
.claude/skills/model-routing/scripts/pipeline-ledger.mjs summary --project <cwd> --last 10` — the
   `runs` block, as a baseline for the live number. No ledger ⇒ skip; step 2 is then the whole measurement
   path for a plain session.

4. **Retro-due — same clock as /retro.** Filter ledger rows to `telemetry==="true"`; cutoff = mtime of newest `.claude/pipeline/retro-*.md` (0 if none); a row counts if
   `Date.parse(endedAt||startedAt) > cutoff`, else fall back to line index vs `rowCountAtRetro` in
   `.claude/pipeline/.retro-marker.json`. delta = rows counted (RUN-LOG's `## Retro —` heading is
   informational only). Print `retro due: <delta>/10 — run /retro` only when delta ≥ 10.

5. `/receipts` — shipped-vs-spend for this session.
