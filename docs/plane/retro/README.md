# Plane weekly knob retro

`plane:retro -- --apply` runs Mondays via `routeflow-plane-daily`. When it applies or
proposes anything, it opens a docs-only PR `chore(plane): weekly knob retro <date>` off
`origin/master`.

## PR contents

- `scripts/campaign/plane-knobs.json` — updated only for knobs the retro moved (`autoTune:
true`, within `[min, max]`, at most one move per knob per window).
- `docs/plane/retro/<date>.md` — the report: per-tool runs, failure rate, p50/p95
  duration/GETs, deferred rate, forbidden hits, rate-limit sleeps, drift trend, intake
  volume, manual-budget usage, "landing without sync" incidents.

## Reading a report

A proposal reads `{knob, from, to, rule, evidence}`. `applied N / proposed-only M`:
proposed-only means out of bounds, not auto-tunable, or already moved this window. Candidate
lessons land in `local-assets/plane/lessons-candidates.md`, never auto-filed.

Repo = law: the owner merges like any PR; nothing applies until the next tool run re-reads
the knob file.
