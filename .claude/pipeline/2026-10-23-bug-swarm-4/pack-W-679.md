1e162686ae8f2229119104cd4cfe1eb722537ba3
# Row W-679: heavy-slot.mjs refuses a bare npm ci

## Liveness
scripts/heavy-slot.mjs and scripts/lib/heavy-slot.mjs contain no npm ci / ignore-scripts check (grep empty); runbook docs/runbooks/shared-host-heavy-slot.md; check-git-hooks.mjs:4,28 shows the hooksPath hazard.

## Files / signatures
scripts/heavy-slot.mjs, scripts/lib/heavy-slot.mjs, heavy-slot.self-test.mjs

## Radius
scripts/heavy-slot*.mjs, heavy-slot-self-test-script.spec.ts, shared-host-heavy-slot.md, lane prompt

## Lessons
L-176 worktree needs own npm ci; L-272 prune after proof runs
