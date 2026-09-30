# 2026-09-30 — sentinel-email sweep (branch claude/great-heyrovsky-591004)

## State

- Head: `363f3489` (docs commit; Mac Lead verified `82feb9ed` — diff since is one code-map line
  - this bookkeeping). Commits: `86a23904` fix (sweep + Lane B fold), `381a907f` merge of master
    `47f648ce` (10 conflicts resolved), `82feb9ed` prettier, `363f3489` map note.
- HOLDS (Mac Lead): NO push, NO PR, NO full `npm run verify` until the owner frees disk
  (~6.2 GB free, floor 10 GB). No more installs; clean nothing.
- Gates run on merged tree: customers+messaging+internal-email API specs 182/182, mobile helper
  test 5/5, map validator clean. Pre-existing (byte-identical to master, lockfile unchanged):
  3 tsc errors (mailbox-alert.service.ts, routeflow.gateway.ts Timeout typing); web `next lint`
  config failure. This worktree needed `npm install` (+2.2 GB) + `prisma generate` (L-176/L-180).
- Next: on lead's verify go → full verify + `check-types -w apps/api` → push → PR (NO merge,
  needs lead's Opus review) → report PR # + head sha to "RouteFlow Mac Lead coordination".
- Lane B ("Filter sentinel emails from portal invites") stood down; its deltas are folded.
- Remote Control toggle: declined (relayed ask); surfaced to owner in-session.

## Drafted lesson (NOT minted — cap 52/52; Option B follow-up; lead allocates id)

- **Symptom:** a lane copied the isInternalEmail helper + specs "verbatim from branch
  fix/invoice-send-smtp-hang so the merge stays clean". That branch had already landed as #345
  weeks earlier, WITH landing-review scrubs (live-client name → `acme_store` in the helper
  specs). The copy reintroduced the pre-scrub text; the master merge surfaced it as an add/add
  conflict, and the live-client-name policy violation had sat in the worktree meanwhile.
- **Root cause:** the branch tip was treated as the source of truth without checking whether its
  content had landed; deltas were taken against an in-flight ref, not against origin/master.
- **Lesson:** Take deltas against the LANDED version on origin/master, never an in-flight
  branch — landing review may have scrubbed or amended exactly the lines being copied; first
  check whether the "unmerged" work already landed under another PR number (cf. L-190, L-195).
- **Guard:** none automated. Ritual: before copying from any branch, `git log --all --oneline --
<file>` + `git cat-file -e origin/master:<file>`; a stale base (>1 week behind origin/master)
  requires the drift check before any cross-branch copy.

## PR body must include

The drafted lesson above + the disk note + the pre-existing failures list.
