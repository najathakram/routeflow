# PR draft (not pushed; the push needs the owner's explicit say-so via the AI OS lead)

**Title:** feat(plane): add the RouteFlow <-> Plane bridge (AI OS step 2.2)

**Body:**

## What

The owner's local Plane CE (`http://localhost:7090`, workspace `routeflow`, project `BUGS`) becomes the owner of the
bug registry's task state, and the registry files become a view regenerated from Plane (AI OS ADR-022, plan step 2.2).

- `scripts/campaign/plane-bridge.mjs` (`npm run plane:bridge`): `status`, `push` (registry → Plane, dry by default,
  `--apply` to write) and `regen` (Plane → registry files; `--check`, `--present-only`, `--out`). Built on the shared
  `plane-client.mjs`: one HTTP client, the denylist, write budget and ledger.
- `scripts/campaign/plane-bridge-codec.mjs`: the one place items are built and read.
  - Lossless: the full catalogue and status rows ride in a sha256-checked payload block in `description_html`.
  - Plane edits to name, state or priority win on decode.
  - Field-level merge: a conflict is only the same field changed on both sides.
  - Human text outside the payload block is kept.
  - Rows that trip the denylist are held and never sent.
- `scripts/campaign/plane-bridge.json` holds the target, token file, project, AI OS state set and both maps. **Ships
  `bugs.owner = "registry"`.** Flipping it to `"plane"` is a separate, owner-approved diff once `status` shows its
  preconditions met: held 0, regen clean, plus the `bugs.mjs` writer path (SA LATER note).
- `plane-sync.mjs` makes zero writes to a target the bridge claims. Its output for every other target is unchanged.
- `plane-fake-server.mjs` gains two additive routes: `POST projects/` and `POST states/`.

## Proof

- `plane-bridge.self-test.mjs`: 66 PASS. It includes a codec round trip over all 1,226 live register rows, the merge
  table, held rows, a token-echo redaction case, `--out` guards and dry-run zero writes.
- `plane-golden.self-test.mjs` (SA-AIOS-01): every existing `plane-*` command's output is byte-identical to base
  `a587d034e7`, 27 PASS including a 1-byte probe. On a claimed target, base makes 3 writes and HEAD makes 0.
- `plane-sync.self-test.mjs`: all checks pass.
- In-lane Opus review: round 1 FAIL (4 important, all fixed); round 2 PASS at `c7de5569f2`.
- Live (owner's local Plane, SA-AIOS-16 pass, lead backup restic `ffb199f7441d`):
  - Canary: 3 items written; `regen --check --present-only` clean.
  - Full seed: see the run notes.

## Design Gate

`.claude/pipeline/2026-11-14-plane-bridge/spec.md` (Full gate; check-gate PASS; SA-AIOS-04).

## Not in this PR

- The ownership flip and the `bugs.mjs`/Gate 5 redirect.
- Roadmap registries.
- Bug records' prose (it stays in git).
- B933: the fleet's own denylist fix.
- The redaction chore for the 17 held rows.

Bookkeeping follow-up (code map, lessons, `_meta.json`) lands in the docs-only PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
