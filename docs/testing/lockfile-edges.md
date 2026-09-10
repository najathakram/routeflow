# Lockfile edge validation

`npm ci` can install a broken tree, exit 0, and look healthy. This document explains the gap,
the check that closes it ([`scripts/validate-lock-edges.mjs`](../../scripts/validate-lock-edges.mjs),
run pre-install in CI and as step 1 of `npm run verify`), and the triage of every skew the check
currently tolerates.

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

Add `-- --verbose` to list the informational classes, or pass a path to check a different lockfile.
It finishes in about a second.

It runs in two places, both the full gate:

| Where                                                        | Catches    |
| ------------------------------------------------------------ | ---------- |
| CI **Lockfile integrity** job, before any install            | everything |
| `npm run verify` step 1, so the pre-push hook gates the lock | everything |

### Why the CI job runs pre-install

Because an incoherent override makes **`npm ci` itself fail**, so a post-install gate would never
run on the case it exists to explain. Verified: with mobile declaring `jest ^30.3.0` against the
30.2.0 pin, `npm ci` reports `Missing: jest@30.5.0 / @jest/core@30.5.0 / camelcase@6.3.0 …` — the
phantom subtree, naming everything except the cause. Every job that installs dies at install.
Pre-install is the only placement that survives it, and it also stops CI spending minutes
installing a tree already known to be holed.

### Why it installs semver into a scratch directory

The version-aware findings need `semver`, and pre-install there is no `node_modules` to supply it.
The job fetches it — into an **empty scratch directory, never the repo root**. `npm install <pkg>`
at a workspaces root re-resolves the entire workspace tree from the registry (measured at over ten
minutes without finishing), which is both slow and precisely the registry-drift behaviour #488
removed. An isolated directory adds exactly one package, and `NODE_PATH` makes it resolvable — the
same mechanism `apps/mobile/Dockerfile` uses.

The pinned version matches what the repo's own tree hoists, so CI and the pre-push hook cannot
reach different verdicts on the same lockfile; **bump the two together.** The validator prints the
semver version it used, so a divergence surfaces instead of passing silently.

Reading `semver` rather than reimplementing it is deliberate: arborist's own check is
`semver.satisfies(v, spec, true)`, so borrowing the same library keeps this honest to the tool it
emulates.

### `--edges-only`

Reachability only, needing no `node_modules` at all. It is an **explicit flag, never inferred from
a missing `semver`** — without it, an unresolvable `semver` is a hard error (exit 2) rather than a
partial pass. Most of the gate would otherwise be skipped while the run still reported green, and a
gate that can go falsely green is worse than one that refuses to run.

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

Measured on master `28cb0a25`, over a 2665-entry lock: **0 missing, 0 workspace breaks, 8 tolerated
skews, 23 override-forced and 4 unsatisfied peer edges.**

Those are a point-in-time snapshot, not a target. The entry count in particular moves whenever a
dependency is added or dropped — a later reading is ordinary, not drift. The number that has to stay
at zero is `missing`, and the gate enforces that on its own; nothing here needs updating to match a
new count.

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

### Unsatisfied peer ranges (0, informational)

Peer mismatches are what npm itself only warns about, so they never gate. The validator has reported
**0** since the Next 15.5 upgrade (`chore/next-15`), which resolved the two that used to be worth
knowing:

- **React.** `apps/web` pinned `react`/`react-dom` `^18` while the rest of the repo was on 19, so the
  lock hoisted React 19 against `next@14`'s `^18.2.0` peer, and `apps/web/Dockerfile` swapped it back
  at build time with `npm install --force --no-save react@18.3.1 react-dom@18.3.1`. The upgrade moved
  `apps/web` to `^19.2.0` and `next@15.5.25`, whose peer range accepts `^19`, so the root pair is now a
  consistent `react`/`react-dom` 19.x and **that Dockerfile swap is gone on purpose — do not restore
  it**. `apps/mobile` still pins React `19.2.0` exactly, so it keeps its own nested copy.
- **ESLint.** `eslint@9` against `eslint-config-next@14`'s `^7 || ^8` peer. `eslint-config-next@15.5.25`
  accepts `^9`.

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

**A from-scratch resolution does not complete on this branch** (master `28cb0a25`). Verified
2026-08-29 by resolving the manifests alone, no prior lock, with npm 10.8.2: it exits ERESOLVE.

```
Could not resolve dependency:
peer react@"^19.2.8" from react-test-renderer@19.2.8
  peer react-test-renderer@">=16.0.0" from @testing-library/jest-native@5.4.3
    dev @testing-library/jest-native@"^5.4.3" from @routeflow/mobile
Found: react@19.2.0 from @routeflow/mobile
```

`react-test-renderer` is **declared nowhere and pinned nowhere** on this branch — it enters only as
a floating peer, whose range lets it drift to whatever the registry publishes. The committed lock
holds it at 19.2.0, which agrees with mobile's exact `react@19.2.0`. The registry has since moved to
19.2.8, which demands `react@^19.2.8`.

Nothing is broken today, and that is the point: the pinned lock is holding back a conflict that
would already have broken the old `rm lockfile && npm install --force` recipe. It is exactly the
registry-drift exposure #488 set out to close. But the next full regeneration has to deal with it
first. A pin is in flight as its own master-based PR; if it has landed by the time you read this,
`react-test-renderer` will be an exact `apps/mobile` devDependency and a from-scratch resolution
completes.

Two things about that fix are worth knowing, because both are easy to get wrong later:

- **Pin it as a workspace devDependency, not in root `overrides`** — the two are _not_
  interchangeable here. This lock records no `overrides` field at all (the same fact that forces
  this validator to read overrides from `package.json`), so an `overrides` pin leaves **zero trace
  in the lock** and `npm ci`'s own validator can never check it. A workspace devDependency lands in
  `packages["apps/mobile"].devDependencies` and is checked on every install. Resolved from scratch,
  both produce byte-identical trees apart from that one manifest line — so the choice costs nothing
  and one of them is verifiable.
- **Retiring `@testing-library/jest-native` does not make the pin redundant.** It is tempting to
  think so, since that package is deprecated in favour of `@testing-library/react-native`'s built-in
  matchers. But `@testing-library/react-native@13.3.3` declares its own **non-optional**
  `react-test-renderer: ">=18.2.0"` peer (its `peerDependenciesMeta` marks only `jest` optional), so
  the float survives. Measured: with `jest-native` and the pin both removed, a from-scratch resolve
  still fails on 19.2.8. Only removing _both_ testing-library packages would free it. Do not drop
  the pin as dead weight.

The alternative to pinning is `--legacy-peer-deps`, which is worse: it disables peer checking across
the entire tree rather than fixing one edge.

So: do the regeneration when something already forces one, and deal with the pin first. The
**Node 20→22 move** is the obvious occasion — Prisma 7.10's dev-only `@prisma/streams-local`
declares `engines: node>=22`, which is why all nine CI install lines carry `--engine-strict=false`
today. That move is an owner decision and must land as one change (CI, all three Dockerfiles, the
`sanitize-html` unpin and `@types/node` together), never piecemeal. When it happens: pin
`react-test-renderer`, regenerate from scratch, re-run this check, and delete whichever
`TOLERATED_SKEWS` entries have gone quiet.

## Related

- [`scripts/validate-lock-edges.mjs`](../../scripts/validate-lock-edges.mjs) — the check itself.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — the "Lockfile integrity" job
  (pre-install) and the Lint job's "Validate lockfile dependency edges (full)" step.
- [`verification-matrix.md`](verification-matrix.md) — the four verification layers this sits
  alongside.
