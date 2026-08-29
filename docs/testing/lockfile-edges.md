# Lockfile edge validation

`npm ci` can install a broken tree, exit 0, and look healthy. This document explains the gap,
the check that closes it ([`scripts/validate-lock-edges.mjs`](../../scripts/validate-lock-edges.mjs),
wired into CI's Lint job), and the triage of every skew the check currently tolerates.

## The gap npm leaves

npm's arborist verifies that each `package-lock.json` entry's own tarball is present and
integrity-matched. It never re-walks the tree to confirm that each entry's declared
`dependencies` are actually **reachable** from where that entry sits. So a lock can describe a
tree with holes, and `npm ci` will faithfully install those holes.

This is not theoretical — it cost the npm-ci migration ([#488](https://github.com/najathakram/routeflow/pull/488))
two full CI rounds. `@jest/reporters@30.2.0` declares `istanbul-lib-report`, `istanbul-reports`,
`istanbul-lib-source-maps`, `v8-to-istanbul` and `@bcoe/v8-coverage`; `jest-changed-files`
declares `execa`. **None of the six were in the lock at all.** They are lazily `require()`d only
at coverage-report time, so plain `npm run verify` never touched them and `jest --coverage` — a
CI-only flag — crashed on a different one each round. Fixing them one at a time was whack-a-mole;
a full edge walk enumerated all six at once.

Hand-editing the lock has the same failure mode at larger scale: deleting one entry makes
arborist silently drop the **entire subtree** beneath it, and `npm ci` accepts the result.

## Running it

```bash
npm run validate-lock
```

Add `-- --verbose` to list the informational classes, or pass a path to check a different
lockfile. It reads the tree `npm ci` installed (for `semver` only) and finishes in about a
second, which is why it sits in the Lint job right after install rather than in a job of its own.

## What it reports

Four classes, two of which fail the build:

| Class                        | Gates? | Meaning                                                                                |
| ---------------------------- | :----: | -------------------------------------------------------------------------------------- |
| **MISSING**                  |   ✖    | A prod/dev edge resolves to nothing. The tree has a hole — this is the #488 class.     |
| **workspace override break** |   ✖    | A workspace declares a range the root `overrides` pin falls outside. See below.        |
| **SKEW**                     |   ✖    | An edge resolves to a version outside its range, and is not in the tolerated baseline. |
| override-forced / peer       |   —    | Informational. Real signal, never a gate.                                              |

### Why a workspace override break is fatal

This encodes #488's actual root cause, so it can never recur silently. **npm 10 — which CI and
every `node:20-alpine` image run — does not apply `overrides` in its `ci` tree validator.** npm 11
does. So when `apps/mobile` declared `jest: ^30.3.0` against the root pin of `jest: 30.2.0`, npm 11
resolved it silently while npm 10 floated the declared range to a phantom `jest@30.5.0` subtree and
reported that whole subtree — roughly 97 cascading Missing/Invalid errors naming `@parcel/watcher`,
`glob@13`, `picomatch@4` and friends, none of which were the problem.

That is the "works locally, fails in CI and Docker" signature. When you see a cascade like it,
don't chase the leaf packages — look for the **one** incoherent edge. This check now finds it for
you, and names the workspace and the two conflicting specs directly.

Keep every workspace's declared range compatible with the pin in root `overrides`.

## Current baseline

As of this document: **0 missing, 0 workspace breaks, 8 tolerated skews, 23 override-forced and
4 unsatisfied peer edges.**

Every tolerated skew lives in `TOLERATED_SKEWS` in the script with its reason. Matching is on the
`(name, found, wanted)` triple and deliberately **not** on location, so a dedupe that moves a
package around does not silently invalidate the baseline.

### Tolerated skews — all 8, none shipped

All eight are `"dev": true` in the lock: they exist only in the jest toolchain and reach no
runtime artifact. The tree carries three coexisting jest generations, each internally consistent:

- **30.2.0** — the pinned generation the suites actually run on. `jest` and `jest-cli` each carry
  their own nested copies, so the runner never leaves it.
- **30.5.x** — a hoisted island (`jest-mock`, `jest-util`, `jest-message-util`, `expect` and their
  nested `@jest/types`) that nothing on the run path reaches.
- **29.7.0** — what `jest-expo` pulls in for mobile (`@jest/globals`, `jest-snapshot` and their
  nested `jest-mock`).

| Skew                                      | ×   | Verdict   | Reason                                                                                                                                                                                                                         |
| ----------------------------------------- | --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jest-mock` 30.5.0 ← wanted 30.2.0        | 1   | tolerated | Root override pins 30.2.0, but npm applies an override only when it **resolves** an edge; this hoist predates the pin. Unused — `jest`/`jest-cli` nest their own.                                                              |
| `@jest/types` 30.5.0 ← wanted 30.2.0      | 3   | tolerated | Nested alongside the 30.5.x hoists, self-consistent. Every **non-dev** consumer (metro and react-native pull jest packages as production deps) gets root 30.2.0.                                                               |
| `jest-mock` 29.7.0 ← wanted 30.2.0        | 3   | tolerated | The jest-29 island under `@jest/globals@29.7.0`, consistent at 29.7.0. Forcing it to 30.2.0 is the riskier change.                                                                                                             |
| `babel-plugin-jest-hoist` 30.4.0 ← 30.2.0 | 1   | tolerated | The only skew here not caused by an override: `babel-preset-jest@30.2.0` declares an exact sibling pin and mobile hoisted 30.4.0 over it. Two patch releases apart on a dev-only Babel plugin that hoists `jest.mock()` calls. |

**Nothing is fix-now.** Seven of the eight would need a from-scratch lock regeneration to clear
(see below), which is a very large diff carrying real risk, for a dev-only cosmetic gain — and it
is entangled with the queued Node 20→22 decision, which will force a regeneration anyway. The
eighth would mean adding a ninth jest entry to `overrides` for no behavioural change. The honest
call is to hold the baseline and let the next forced regeneration clear it.

### Override-forced edges (23, informational)

An edge that resolves **only because** an override rewrote it — the declarer asked for something
else. All 23 are jest-29-generation packages (`jest-snapshot`, `jest-validate`,
`jest-watch-typeahead`, `jest-expo`, `react-native`, `@jest/create-cache-key-function`) asking for
`@jest/types@^29.6.3`, `@jest/transform@^29.7.0` or similar and being pulled onto the 30.2.0 pin.

That is the overrides doing exactly their job — deliberately holding the jest family on the proven
30.2.0 generation from #74. They are surfaced rather than hidden because this is the same
mechanism as the fatal workspace case, one position removed; a sharp rise in this count is worth a
look.

### Unsatisfied peer ranges (4, informational)

Peer mismatches are what npm itself only warns about, so they never gate. Two are worth knowing:

- **`react@19.2.5` against `next`'s `^18.2.0` and `react-dom`'s `^18.3.1`.** This is expected and
  load-bearing. The lock hoists React 19; `apps/web/Dockerfile` swaps it at build time with
  `npm install --force --no-save react@18.3.1 react-dom@18.3.1` (kept deliberately in #488 —
  `npm ci` cannot add packages, and `--force` is required to override the React-19 peer ranges).
  **If these two lines ever vanish, check whether that swap is still doing what it should.**
- **`eslint@9.39.4` against `eslint-config-next`'s `^7 || ^8`.** Flat-config ESLint 9 against a
  Next 14 config that has not published a 9-compatible peer range. Lint passes.

## When the check fails

**MISSING** — the package is genuinely absent. Declare it as a root `devDependency` (the
established hoist-shim pattern here, used for the jest coverage chain, `react-native-worklets` and
`rxjs`), then regenerate:

```bash
npx -y npm@10.8.2 install --package-lock-only --no-audit --fund=false
```

Always regenerate with **npm 10.8.2** — it is what CI and the Dockerfiles run, and npm 11 masks
the override-awareness bug described above. Always pass `--no-audit`; through `npx` the audit step
hangs for ten minutes or more. Then confirm both gates:

```bash
npx -y npm@10.8.2 ci --dry-run --no-audit
```

must print zero Invalid/Missing, and `npm run validate-lock` must exit 0. The two checks overlap
very little — run both.

**Workspace override break** — widen the workspace's declared range to include the override pin
(never the reverse: the pins are deliberate), then regenerate the lock.

**SKEW** — either align the range and regenerate, or, if the skew is genuinely harmless, add it to
`TOLERATED_SKEWS` **with a reason that says why it is safe**, not merely that it is old. "Tests
pass" is evidence, not a reason; the reason should be structural, the way the entries above name
the island each package sits in.

## Retiring the baseline

Seven of the eight tolerated skews exist because a `--package-lock-only` regeneration preserves
pre-existing satisfying subtrees rather than re-resolving them, so islands that predate an override
pin survive it. Clearing them needs a from-scratch resolution.

**A from-scratch resolution currently does not complete.** Verified 2026-08-29 by resolving the
manifests alone (no prior lock) with npm 10.8.2: it exits ERESOLVE.

```
Could not resolve dependency:
peer react@"^19.2.8" from react-test-renderer@19.2.8
  peer react-test-renderer@">=16.0.0" from @testing-library/jest-native@5.4.3
    dev @testing-library/jest-native@"^5.4.3" from @routeflow/mobile
Found: react@19.2.0 from @routeflow/mobile
```

`react-test-renderer` is **declared nowhere and pinned nowhere** — it is a floating peer of
`@testing-library/jest-native@5.4.3`, whose `>=16.0.0` range lets it drift to whatever the registry
publishes. The committed lock holds it at 19.2.0, which agrees with mobile's exact `react@19.2.0`.
The registry has since moved to 19.2.8, which demands `react@^19.2.8`.

Nothing is broken today, and that is the point: the pinned lock is holding back a conflict that
would already have broken the old `rm lockfile && npm install --force` recipe. It is exactly the
registry-drift exposure #488 set out to close. But it means the next full regeneration must first
either pin `react-test-renderer` to match the react pin (in `apps/mobile` devDependencies or root
`overrides`, the way the other RN natives are pinned) or accept `--legacy-peer-deps`. Prefer the
pin — `--legacy-peer-deps` disables peer checking across the whole tree.

So: do the regeneration when something already forces one, and deal with the pin first. The
**Node 20→22 move** is the obvious occasion — Prisma 7.10's dev-only `@prisma/streams-local`
declares `engines: node>=22`, which is why all nine CI install lines carry `--engine-strict=false`
today. That move is an owner decision and must land as one change (CI, all three Dockerfiles, the
`sanitize-html` unpin and `@types/node` together), never piecemeal. When it happens: pin
`react-test-renderer`, regenerate from scratch, re-run this check, and delete whichever
`TOLERATED_SKEWS` entries have gone quiet.

## Related

- [`scripts/validate-lock-edges.mjs`](../../scripts/validate-lock-edges.mjs) — the check itself.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — Lint job, "Validate lockfile
  dependency edges".
- [`verification-matrix.md`](verification-matrix.md) — the four verification layers this sits
  alongside.
