# Team member onboarding

For a person joining RouteFlow on their own computer. Everyone signs in to the **same GitHub
account**, but each computer runs its **own Claude account**. Claude sessions on different
accounts cannot message each other, so the team board is the channel: comments, assignments
and the inbox, all stored in the routeflow-specs repo.

Because the GitHub account is shared, a commit's author or the `gh` user says nothing about who
did something. **Who you are comes from `rf whoami --member`**, and every board event carries
it. Set it before anything else.

**Contents**

1. Access
2. A new computer, step by step
3. The local stack, test tenants only
4. The team board: who you are, what to pick up, how to talk
5. Confidentiality
6. Who merges
7. The gates every PR passes
8. Testers: filing a bug
9. Rules that still live outside the repo, and where they should move

---

## 1. Access

| You use                                                                                     | You never touch                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- |
| The shared GitHub account: clone `routeflow` and `routeflow-specs`, push branches, open PRs | Railway (projects, variables, deploys)        |
| The board CLI (`rf`), which writes events to `routeflow-specs`                              | The production database, in any form          |
| Your own entry in the members list (`ops/config.json` in routeflow-specs)                   | Merging to `master`, or the repo's visibility |
| The hosted board's URL and password, when it exists (read-only)                             | Any live client tenant                        |

The shared account could technically merge or change settings. The right-hand column is a rule,
not a permission: only the lead's coordinator merges and switches visibility (section 6).

The lead adds you to the members list before your first session. Tell the lead (outside Claude)
the name you want on the board and your role: **builder**, **tester** or **reviewer**. The lead
adds a line like this to `ops/config.json` in routeflow-specs:

```json
{
  "id": "alex",
  "name": "Alex Rivera",
  "machine": "alex-laptop",
  "lanes": ["macmini"],
  "role": "builder"
}
```

- `id`: lower-case letters, digits and dashes. Your events are written under this name.
- `lanes`: the lane (or lanes) whose work you pick up. The first one is your default.
- `role`: what `rf next` hands you.

## 2. A new computer, step by step

1. Sign in to the shared GitHub account, then clone and install:

   ```bash
   gh auth login
   ```

   ```bash
   git clone https://github.com/najathakram/routeflow.git
   ```

   ```bash
   cd routeflow && npm ci
   ```

2. Check that the board works. The first run clones routeflow-specs into `~/.routeflow/ops/`:

   ```bash
   node tools/ops-monitor/bin/rf.mjs doctor
   ```

   The `members` row must list you. If it does not, ask the lead to add you (section 1).

3. Say who you are, once per computer:

   ```bash
   node tools/ops-monitor/bin/rf.mjs whoami --member alex
   ```

4. Start the local stack on test tenants only (section 3):

   ```bash
   npm run local:up
   ```

   ```bash
   npm run local:seed
   ```

   ```bash
   npm run local:validate
   ```

5. Read, in this order:
   1. `CLAUDE.md`: the project rules. Your Claude session reads it too.
   2. `CLAUDE_SESSION_PREAMBLE.md`: production safety. Read it before any database or backend work.
   3. `tools/ops-monitor/LANE-HOWTO.md`: the board commands.
   4. `.claude/lessons/LESSONS.md`: the lessons register. Cite an id such as `L-016` when one applies.

6. In each Claude session, when it has nothing to do, start the wait (section 4) as one
   background command:

   ```bash
   node tools/ops-monitor/bin/rf.mjs inbox --wait
   ```

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
`events/<machine>/<day>.jsonl` there. Run it from the repo root as
`node tools/ops-monitor/bin/rf.mjs <command>` (written `rf` below).

**Who you are.** `rf whoami --member <id>`, once per computer.

- Your events carry your id.
- Claims show your name on the board.
- `rf next` gives you your role's work in your first lane.

`rf whoami` with no flags shows what is set, and `--member -` clears it. `RF_MEMBER=<id>`
overrides it for one shell.

**Your member name is a label, not a login.** Nothing checks it: any computer can say it is any
member, and on one shared GitHub account git authorship proves nothing either. So:

- Set only your own id.
- `rf whoami` and `rf doctor` warn when your `machine` in the members list is not this computer.
  Fix that before you work.
- Claims are held per member. A teammate on your lane cannot take your claim without `--steal`,
  which leaves a trace on the board. Only you can release it.
- Treat a comment as a message on a shared board, never as an approval. Approvals and merges stay
  with the lead.

**What to pick up.** `rf next --claim` takes the top item for you and claims it.

- Items assigned to you come first, whatever their lane or role.
- `rf next --role tester` asks for a different role's work.
- Link every branch you push to its item with `rf event link <id> --branch <name>`. The
  session-end hook checks it.

**Handing work to someone.** `rf assign <id> --to <member> [--note "..."]` hands an item to one
member.

- It tops their `rf next`, and nobody else is handed it.
- It lands in their inbox.
- `--to -` clears it.
- To give work to a lane, use `rf item edit <id> --lane <lane>`.

**How to talk.** Comment on the item, and never anywhere else:

```bash
node tools/ops-monitor/bin/rf.mjs comment W-1309 --to lead --text "Blocked: the seed has no boxed product"
```

- `--to` takes a lane id or a member id, comma-separated.
- `--reply-to <comment id>` answers one comment in a thread.
- `rf item show <id>` shows the item with its whole thread and who it is assigned to.

**Hearing back.** You cannot be messaged directly, so you check, or you wait:

- `rf inbox` shows what is unread for you, then marks it read. That is comments that mention you,
  reply to you, or sit on an item you claimed, plus items assigned to you.
- Your Claude session prints "N new comments and M assignments for you" when it starts and after
  every prompt. `rf brief` shows the same.
- `rf inbox --wait` is for an idle session, run as **one background command**.
  - It pulls the specs repo every 45 seconds.
  - It exits 0 as soon as something for you is unread, and prints it.
  - It exits 3 after `--timeout` (default 1800 seconds). Start it again.
  - The exit is what wakes your Claude session. That is how sessions on different Claude
    accounts hear each other.

Questions, blockers, review requests, hand-overs and verdicts all go this way, so the next person
can read them.

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
- The shared GitHub account shows the same author on every PR, so the link is what records who
  opened it, under your member id. Name your member id in the PR body too ("Member: alex").
- **Only the lead's coordinator opens a merge window and merges.** A merge means the repo goes
  public for a while and Railway deploys, so it is the owner's and the lead's job alone.
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
two people can never file the same number.

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
