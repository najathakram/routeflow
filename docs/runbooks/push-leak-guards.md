# Push leak guards

A private, not-yet-public name must never reach the public repo. The guard is brand-neutral: the
secret pattern is never in git.

## One-time setup (every clone)

Create the untracked patterns file, one case-insensitive regex per line (`#` comments allowed):

```bash
printf '%s\n' "your-regex-here" > "$(git rev-parse --git-common-dir)/info/leak-patterns"
```

All worktrees of the clone share it (it lives in the git common dir). Ask the coordinator for the
regex; never paste it into a file, test, commit message or PR.

## What runs

- `.husky/pre-push` runs `node scripts/leak-check.mjs --hook` **first**, before the trunk check, the
  `SKIP_VERIFY` hatch and verify, so `SKIP_VERIFY` cannot bypass it. It refuses:
  - a `rebrand/*` branch pushed anywhere except its own ref (owner ruling 2026-11-19): `git push origin rebrand/<name>` is allowed and not scanned; any cross-ref push (`rebrand/x` to `feat/y`, `feat/y` or `HEAD` to `rebrand/x`, a case variant) is refused unless `RF_REBRAND_PUSH=launch`;
  - a push to any other ref that contains commits reachable from a local `rebrand/*` branch or a remote-tracking `refs/remotes/*/rebrand/*` ref (and not on `origin/master`), whatever the ref is called;
  - a pattern hit in added lines (including new and renamed files, `--text`), file names, commit
    messages or ref names of the outgoing range. A new branch scans from the merge-base with
    `origin/master` (or every commit not on a remote when there is none); an update scans
    `remote-sha..local-sha`.
- Fail-closed: a missing, empty or invalid patterns file refuses the push with a message saying how
  to create it. `CI=true` does not skip the hook: it never skips a push. Only the manual modes (`--range`,
  `--text-file`, `--stdin`, `--tree`) treat a missing patterns file under CI as a skip, exit 0.
- Output names commit shas, file paths and counts only; a path or ref that itself matches is
  withheld, and so is any path git quotes (unusual bytes, such as zero-width or non-ASCII letters).
  Matched text is never printed.

## Manual use

```bash
node scripts/leak-check.mjs --range origin/master..HEAD --ref "$(git branch --show-current)"
node scripts/leak-check.mjs --text-file pr-body.md      # or --stdin, for a PR title/body/squash text
node scripts/leak-check.mjs --tree                       # ledgers, RUN-LOGs, lessons, code-map, campaign
```

Exit codes: 0 clean, 1 hit, 2 usage or patterns file missing/empty/invalid.

## Self-test

`node scripts/leak-check.self-test.mjs` (throwaway git repos, neutral fixture pattern).

## Notes

- The hook runs from the checked-out tree: a branch cut before this guard landed has no guard until
  you merge master into it.
- An own-ref `rebrand/*` push needs no env var and no patterns file when it is the whole push; any other
  ref in the same push is still scanned and still needs the patterns file.
- `RF_REBRAND_PUSH=launch` is only for launch-day pushes of the name to master or other refs: it lifts
  the cross-ref refusal and the content scan for rebrand-named refs only; any other ref in the same
  push is still scanned.
- The own-ref allowance applies to any remote. The repo is public during deploy windows, so a
  `rebrand/*` ref pushed then is visible (owner ruling 2026-11-19 accepted that).
- `git push --no-verify` and `HUSKY=0` skip the whole guard. House rule: never use them.
- Merge commits are scanned against their first parent, annotated tag messages are scanned, and any
  failed git call or non-UTF-8 patterns file refuses the push (exit 2) instead of passing.

## Retirement (after launch)

Once the name is public, master contains it and the guard would refuse every push. In one PR: remove the
`# >>> leak-guard` ... `# <<< leak-guard` block from `.husky/pre-push`, delete `scripts/leak-check.mjs`,
`scripts/lib/leak-patterns.mjs`, `scripts/leak-check.self-test.mjs` and this runbook, then each developer
deletes the untracked `$(git rev-parse --git-common-dir)/info/leak-patterns`. Until that PR lands, a push
that must contain the name needs the coordinator's launch procedure (`RF_REBRAND_PUSH=launch`).
