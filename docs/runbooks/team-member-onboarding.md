# Team member onboarding

For a new computer on the RouteFlow team board. The team is one owner working from several
computers, each running its own Claude account. **Every computer signs in to the same GitHub
account**, the one that owns the repos. Claude sessions on different accounts cannot message
each other, so the team board is the channel: items, comments and assignments, stored in the
routeflow-specs repo.

Because the GitHub account is the same everywhere, a commit's author or the `gh` login says
nothing about which computer did something. **Who did it comes only from the member id set on
each computer with `rf whoami --member`**, and every board event carries it.

**Contents**

1. Access
2. Your first hour
3. The local stack, test tenants only
4. The team board: who you are, what to pick up, how to talk
5. Confidentiality
6. Who merges
7. The gates every PR passes
8. Testers: filing a bug
9. Rules that still live outside the repo, and where they should move

---

## 1. Access

| This computer uses                                                                          | This computer never touches                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| The shared GitHub account: clone `routeflow` and `routeflow-specs`, push branches, open PRs | Railway (projects, variables, deploys)        |
| The board CLI (`rf`), which writes events to `routeflow-specs`                              | The production database, in any form          |
| One entry in the members list (`ops/config.json` in routeflow-specs)                        | Merging to `master`, or the repo's visibility |
| The hosted board's URL and password, when it exists (read-only)                             | Any live client tenant                        |

There is no collaborator invite: every computer signs in to the one account. That account can
technically merge and change settings, so the right-hand column is a working rule, not a
permission. Only the lead's window coordinator merges and switches visibility (section 6).

The lead adds **one members entry per computer or Claude account** before its first session,
with the name to show on the board and the role: **builder**, **tester** or **reviewer**. The
entry is a line like this in `ops/config.json` in routeflow-specs:

```json
{
  "id": "alex",
  "name": "Alex Rivera",
  "machine": "alex-laptop",
  "lanes": ["macmini"],
  "role": "builder"
}
```

- `id`: lower-case letters, digits and dashes. This computer's events are written under it.
- `machine`: this computer's name. `rf whoami` and `rf doctor` warn when it does not match.
- `lanes`: the lane (or lanes) whose work this computer picks up. The first one is the default.
- `role`: what `rf next` hands it.

## 2. Your first hour

Sign in to the shared GitHub account, then clone:

```bash
gh auth login
```

```bash
git clone https://github.com/najathakram/routeflow.git
```

```bash
cd routeflow && npm ci
```

Read, in this order:

1. `CLAUDE.md` (the project rules; your Claude session reads it too).
2. `CLAUDE_SESSION_PREAMBLE.md` (production safety; read it before any database or backend work).
3. `tools/ops-monitor/LANE-HOWTO.md` (the board commands).
4. `.claude/lessons/LESSONS.md` (the lessons register; cite an id such as `L-016` when one applies).

Then set up the board (section 4) and the local stack (section 3).

## 3. The local stack, test tenants only

Everything runs on your machine in Docker. There is no staging copy, and `master` deploys
straight to production, so the local stack is the only place to try things.

```bash
npm run local:up
```

```bash
npm run local:seed
```

```bash
npm run local:validate
```

Add `npm run local:e2e` for a UI change. Details: `docs/adr/0001-local-hosting-environment.md`
and `apps/web/e2e/LOCAL-LANE.md`.

Rules:

- Test only on the approved test tenants: `test`, `e2e-routeflow`, `routeflow-demo`, and any
  `qa-*`, `e2e-*` or `ux-audit-*` tenant, with made-up data. `scripts/lib/test-tenants.cjs`
  (`assertTestTenant`) enforces this; every script that writes must call it first.
- The compose passwords and keys are local throwaways. Never reuse them anywhere, and never put
  a production connection string, key or client identifier in a file.
- `npm run local:down` stops it; `npm run local:reset` wipes its volumes.

## 4. The team board

The board is the ops monitor: a CLI over the routeflow-specs repo. Every action is an event in
`events/<machine>/<day>.jsonl` there. Run it from the repo root:

```bash
node tools/ops-monitor/bin/rf.mjs doctor
```

**Who you are.** Once per computer:

```bash
node tools/ops-monitor/bin/rf.mjs whoami --member alex
```

From then on, your events carry your id, your claims show your name on the board, and `rf next`
gives you your role's work in your first lane. `rf whoami` with no flags shows what is set.
`--member -` clears it.

**Your member name is a label, not a login.** Nothing checks it: any computer can say it is any
member, and on one shared GitHub account the git author and the `gh` login prove nothing either.
So:

- Set only your own id.
- `rf whoami` and `rf doctor` warn when your `machine` in the members list is not this computer.
  Fix that before you work.
- Claims are held per member. Another member (another computer) on your lane cannot take your claim without `--steal`,
  which leaves a trace on the board. Only you can release it.
- Treat a comment as a message on a shared board, never as an approval. Approvals and merges stay
  with the lead.

**What to pick up.**

```bash
node tools/ops-monitor/bin/rf.mjs next --claim
```

This takes the top item for your lane and role and claims it. `rf next --role tester` asks for a
different role's work. Link every branch you push to its item
(`rf event link <id> --branch <name>`); the session-end hook checks it.

**How to talk to the lead.** Comment on the item. Never anywhere else.

```bash
node tools/ops-monitor/bin/rf.mjs comment W-1309 "Blocked: the seed has no boxed product" --to lead
```

- `--to` takes a lane id or a member id, comma-separated.
- `--reply-to <comment id>` answers one comment in a thread.
- `rf inbox` shows the comments for you: mentions, replies to you, and comments on items you claimed.
- Your Claude session prints "N new comments for you" at start and after each prompt.
- `rf item show <id>` shows the item with its whole thread.

Questions, blockers, review requests and hand-overs all go this way, so the next session, on
any computer, can read them.

## 5. Confidentiality

These come from `CLAUDE.md` and have no exceptions:

- Never name a live client anywhere you write: code, tests, fixtures, UI text, examples,
  comments, commit messages, PR text, docs or board items. That covers slugs, business names,
  products, order or invoice numbers and tenant ids. Use `acme` placeholders.
- The repo is public for short windows while a deploy runs. Write everything as if it were public.
- Never commit a credential or a connection string. Read secrets from environment variables;
  each app's `.env.example` lists the names.
- Never commit `.claude/settings.local.json`, images, videos or office files (see "Heavy files
  policy" in `CLAUDE.md`). Screenshots and evidence go in a link, never in git.
- The board masks the client names it knows. That is a safety net, not permission.

## 6. Who merges

- You open PRs against `master`, marked ready for review, and link them to the item
  (`rf event link <id> --pr <n>`).
- **Only the lead's window coordinator opens a merge window and merges.** A merge means the repo
  goes public for a while and Railway deploys, so it is the owner's and the lead's job alone. The
  shared account could merge from any computer: this is a working rule, not a permission.
- Never push to `master`, force-push a shared branch, use `--no-verify`, or switch the repo's
  visibility.
- Commits follow Conventional Commits (`feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`);
  commitlint checks them.

## 7. The gates every PR passes

1. **Your own checks.** `npm run verify` runs before every push (the pre-push hook runs it; never
   skip it). UI changes also run `npm run local:e2e`.
2. **The Design Gate.** Every PR body carries a filled Design Gate block (Lite for small changes),
   and it must pass:

   ```bash
   node .claude/skills/future-proof/scripts/check-gate.mjs - < pr-body.md
   ```

   The skill is `.claude/skills/future-proof/SKILL.md`.

3. **An independent review read** (`.claude/skills/pre-merge-review/SKILL.md`). The reader is
   never the session that built the change. `node scripts/review-tier.mjs` gives the tier:
   - **Tier 1**: money, ledgers, units, locks, tenancy, migrations, billing or auth, or a large
     diff. Two independent PASS reads, on Opus. A money change also runs its module's full
     database test lane.
   - **Tier 2**: UI and tooling. One PASS read; Sonnet at high effort is allowed.
4. **Bug fixes** also carry a lessons entry (Symptom / Root cause / Lesson / Guard) in the
   follow-up bookkeeping PR. The code PR's last commit carries `Bookkeeping-Follow-Up: pending`.

A reviewer posts its verdict as a comment on the item (`rf comment <id> "PASS: ..." --to lead`).

## 8. Testers: filing a bug

A tester files a **draft**. The lead or coordinator turns it into a registry bug, or answers why
not. Only they mint bug numbers (`rf bug file` and `rf triage promote` refuse everyone else), so
two computers can never file the same number.

```bash
node tools/ops-monitor/bin/rf.mjs item new --type bug --title "Save on a new order does nothing" --steps "1. Orders > New  2. Add a line  3. Tap Save" --screen /orders/new --evidence https://example.com/your-shot
```

- With `rf whoami --member` set to a tester, `--type bug` is required and the status is always
  `draft` ("Waiting for triage" on the board).
- `--steps`: what you did, numbered, up to 2,000 characters.
- `--screen`: the page or route.
- `--evidence`: a link to a screenshot or recording you host. Never a file in git.
- Use a test tenant, and keep client names out of the text.

You hear back as a comment on the item: "Filed as B### (severity)" or "Not filed: reason". The
board's Triage panel lists every draft that is still waiting.

## 9. Rules that still live outside the repo, and where they should move

A new member's Claude session reads `CLAUDE.md`, the skills under `.claude/skills/`, the lessons
register and `.claude/sa/RULINGS.md`. It cannot read the lead's personal Claude memory or the
lead's machine-local `local-assets/` folder. Rules that live only there today, by category
(counted on 2026-11-22; nothing was moved or changed):

| Where today                                             | What it holds                                                                                         | Proposal                                                                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead memory, owner rulings (`project_owner_*`)          | Product and scope rulings: pricing shape, website rules, release rules, per-feature answers           | Move each ruling still in force into routeflow-specs `decisions/` (one file each, dated). Product rules a builder needs go in the skill or spec they bind.             |
| Lead memory, working rules (`feedback_*`, 125)          | How the fleet works: model routing, review tiers, push and verify rules, guard blocks, output length  | Rules that bind any contributor go into the skills (`fleet-lead`, `pre-merge-review`, `model-routing`) or `CLAUDE.md`. Rules about the lead's own seat stay in memory. |
| Lead memory, machine notes (`reference_*`, 94)          | Machine quirks: Windows spawn failures, junctioned `node_modules`, hook gaps, Railway snapshot errors | Move the general ones into `.claude/lessons/LESSONS.md` (each with a Guard). Notes about one machine stay where they are.                                              |
| `local-assets/lead-*/sa/`                               | Draft Senior Architect rulings and verdicts                                                           | A ruling becomes binding only once it is in `.claude/sa/RULINGS.md`. Promote the open ones there, or mark them withdrawn.                                              |
| `local-assets/ux-eval-*/rulings/`, `OWNER-DECISIONS.md` | UX-guide rulings and the owner's answers                                                              | Move them into routeflow-specs `decisions/` beside the guide they answer.                                                                                              |
| `local-assets/lead-*/recheck/*-verdicts.jsonl`          | Review verdicts per PR                                                                                | Record future verdicts as `rf comment` on the item, where members can read them. Old ones need no move.                                                                |
| Lawyer and legal verdict drafts                         | Wording rulings for public legal pages                                                                | Keep them in routeflow-specs (private), per the rule that public text carries only a neutral line and a pointer.                                                       |

Two rules:

- Nothing that names a live client moves into this repo. Client-specific material stays in
  routeflow-specs, and only under its own access rules.
- The lead decides what moves. The full file-by-file inventory is in the lead's notes, not in
  this repo.
