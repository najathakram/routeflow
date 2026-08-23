---
name: code-map
description: >
  Consult and maintain the signature-level code map under .claude/code-map/. Auto-load
  when orienting in the repo, at the start of a session, when answering "where is X" /
  "how does Y work", when planning or making a code change, or right after editing code
  (to update the map). Keywords: "code map", "understand the codebase", "where is",
  "how does", "orient", "navigate the repo", "onboard", "what changed".
---

# Skill: Code Map (RouteFlow)

A **code map** lives at [`.claude/code-map/`](../../code-map/) — a signature-level index of
the repo. Use it INSTEAD of re-reading the codebase.

## Files

- `INDEX.md` — stack, entry points, run/test commands, the global "Where to find" table, and
  links to the area files.
- `api.md`, `web.md`, `mobile.md`, `packages.md` — one per workspace; each has a local
  "Where to find" table and terse per-file entries (purpose, exports/signatures, cross-refs).
- `_meta.json` — `mappedSha` (the commit the map was last reconciled to), `generatedAt`, and a
  `notes` field carrying ONLY the latest session note (plus a pointer to `CHANGELOG.md`).
- `CHANGELOG.md` — session-by-session history of map updates: one dated bullet per session
  note, newest first.

## When understanding / navigating (before grepping broadly or reading source)

1. Read `INDEX.md`. Pick the area(s) the task touches from its table.
2. Open that `<area>.md`, use its **Where to find** table → land on the exact file/symbol.
3. Open only those files. Expand outward only where an entry's cross-refs say a change ripples.

## Before a change

Consult the map to scope which files are involved and where a change ripples — plan from it.

## After EVERY change (surgical, not a regen)

Update the touched entries (purpose, exports/signatures, cross-refs) in the area file, and bump
`_meta.json` (`mappedSha` → new HEAD, `generatedAt`). Record your session note by adding a dated
bullet at the TOP of `CHANGELOG.md` and REPLACING `_meta.json` `notes` with that same note + the
CHANGELOG pointer — never prepend/accumulate history in `notes` (it once grew to ~90K chars and
cost ~38K tokens per read). A small code change is a few-line map edit — never regenerate the
whole map. Trust the code over the map when they disagree, and fix the map.

## Staleness

Compare `_meta.json.mappedSha` to `git rev-parse HEAD`; `git diff --name-only <mappedSha> HEAD`
shows the drift. Refresh the affected entries (or re-map an area if the drift is structural).

## Money math note

Money/line/tax math mirrors live in `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts` — keep
all three in sync (the map flags this).
