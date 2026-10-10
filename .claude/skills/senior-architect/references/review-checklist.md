# SA read checklist — one PR, at the sha the builder names

Run every line; a skipped line is a claim.

## Provenance

- [ ] `git fetch origin <branch>`; record head sha, merge-base with master, and master's head now.
- [ ] Commits on the branch: which are the builder's, which are merge commits of master (→ squash-only),
      which belong to an already-squashed parent (L-190: rebuild from fresh master, cherry-pick own commits only).
- [ ] Files touched vs the ruling's allowed set ("this file + one spec, nothing else" when the window is narrow).

## Shape against the ruling

- [ ] The logic lives in the ONE place the ruling named; no second copy, no inline re-derivation.
- [ ] Callers pass the stored shape (boxes/pieces/unitLabel/snapshot pack), never a precomputed figure;
      a type pin proves the precomputed field is gone (in a plain `.ts` if specs are excluded from `check-types`).
- [ ] Evaluation order matches the ruling, first hit wins; every fallback warns with the ids and both values.
- [ ] Live-product reads on an existing-line path: none, or count-pinned + warn-only + commented with the route back.
- [ ] Sibling writers of the same axis/field were swept, not just the ones touched.

## Reachability

- [ ] "The first-party client never sends that" is not a guard: the endpoint is reachable from mobile, imports, scripts and curl, and the DTO validates fields independently — check the DTO for the cross-field invariant before accepting a shape as unreachable (SA-077a: `{qty, boxes, pieces}` with no `qty = boxes × pack + pieces` assertion).

## Tests

- [ ] Each red case names the entry condition it passes through.
- [ ] Each discriminating case primes BOTH reads (stale and live) and asserts the live value AND the absence of the stale one.
- [ ] Every expected number in the body says how it was observed (revert-and-run; patch-the-alternative-and-run; helper one-liner).
- [ ] "Green on first run against master" is expected when the writer was already fixed — the body must show the red proof against the PRE-fix code, or state honestly that the case is a pin against a refused alternative, not a revert.
- [ ] Non-finite / garbage inputs pinned to the loud `unknown` path where the function is a classifier.
- [ ] A red case fails for the RIGHT reason: the fixture must reach the guard under test (a split that implies its own pack never reaches a no-pack refusal); control cases pin that the guard does NOT fire on the adjacent legitimate shapes. A red that fails for the wrong reason is the same defect as a green that passes for the wrong reason (SA-077g).
- [ ] New tests in a NEW spec file when the existing spec sits at its size ceiling.

## Ratchets and guards

- [ ] Count the file yourself via `git ls-tree` + `git cat-file -p`; cap = baseline + 25; an extraction lowers the baseline in the same commit and the count at commit 1 equals the new baseline.
- [ ] Any guard baseline bump is count-pinned, justified as warn-only/display-only, and names the follow-up that lowers it — stating the PRESENT count and the retiring change, never a predicted future number (a prediction in a comment is a second copy of a fact and gets overtaken).
- [ ] Baselines only go DOWN: a lane that hoists or extracts lowers the pin in the same commit; a refusal from a ratchet is chased to a named change, never a bypass or an exemption list.
- [ ] Allowlists: every pre-existing site present, tagged, count-pinned per file, shrink-only.

## Body

- [ ] States what is fixed, what is deferred (with the bug id or the follow-up), and any interim (`?? snapshot`, P2025 rollback instead of a clean 409).
- [ ] Names the UI follow-ups a new error code needs (handlers that do not exist yet).

## After merge

- [ ] Merge commit has one parent (squash); `git diff --stat <reviewed-head> <merge-commit> -- <files>` is empty.
- [ ] Deployment `success` for the merge sha from the deployments API (per sha; ignore `statuses[0]`).
- [ ] Mark the ruling `[LANDED as #n @ sha]`; update the handoff's read queue.
