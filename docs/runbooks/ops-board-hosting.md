# Hosted team board (ops monitor online): plan and owner steps

Status: **plan, nothing deployed.** Agents do not deploy this, do not create the Railway project
and never set a Railway variable. The owner runs every step marked **Owner**.

Why: new team members work from their own computers and Claude accounts. They cannot reach the
PC's `localhost:4317` board or message our sessions. The ops monitor
(`tools/ops-monitor`) is the one team board (the README explains why there is no Jira, Plane or
GitHub Projects board: four earlier boards drifted). This plan puts that board online behind the
existing password login.

## What already exists (no new code for phase A)

| Piece               | Where                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Container           | `tools/ops-monitor/Dockerfile` (node:20-alpine, git, tini, non-root)                                                                |
| Railway config      | `tools/ops-monitor/railway.toml` (Dockerfile build, `/api/health`, 1 replica)                                                       |
| Cloud mode          | `server.mjs --cloud`, `lib/cloud.mjs`: read-only clones, `readOnlyExec` refuses every git write                                     |
| Login               | `lib/auth.mjs`: scrypt password hash, signed HttpOnly SameSite=Lax cookie, per-IP and global rate limits, HTTPS redirect, `noindex` |
| Client-name masking | `CLIENT_NAMES_JSON`; the cloud refuses to start without it                                                                          |
| Real-time updates   | signed GitHub webhook at `/hooks/github` (optional), polls as the backstop                                                          |

Owner ruling of 2026-10-19 (routeflow-specs `decisions/D-2026-10-19-ops-monitor-online.md`):
the monitor runs in **its own Railway project**, behind a password, with read-only tokens, and
**the service never writes git**. Phase A keeps that ruling. Phase B needs an owner change to
it (below).

## Phase A: read-only board online (recommended now)

Members see everything the PC board shows: items, claims (with member names), statuses, drift,
the triage list, comments. They act with the `rf` CLI from their own checkout (everyone signs in to the
same GitHub account; who did what comes from `rf whoami --member`, see
`team-member-onboarding.md`). No new secret can write
anything, and nothing in phase A touches the RouteFlow app's Railway project.

### Owner steps (Railway dashboard)

1. **Owner. New project.** Railway → New Project → Empty project → name it `routeflow-ops`.
   Own project, not the app's project (D-2026-10-19b).
2. **Owner. Service from the repo.** In `routeflow-ops`: New → GitHub Repo →
   `najathakram/routeflow`, branch `master`. Open the service → Settings:
   - Source → **Root Directory** `/tools/ops-monitor` (the Dockerfile expects this folder as the
     build context root).
   - Build → **Config-as-code path** `/tools/ops-monitor/railway.toml`.
   - Build → **Watch Paths** `/tools/ops-monitor/**` (other merges do not rebuild it).
   - Deploy → leave **Replicas at 1** (one collector, one in-memory session store).
   - Name the service `ops-monitor`.
3. **Owner. GitHub token (read-only).** github.com → Settings → Developer settings →
   Fine-grained tokens → Generate:
   - Resource owner `najathakram`; repositories **only** `routeflow` and `routeflow-specs`.
   - Permissions: Contents **Read**, Pull requests **Read**, Commit statuses **Read**,
     Checks **Read** (if listed), Metadata **Read**. Nothing else. Expiry 90 days (set a
     calendar reminder to rotate).
4. **Owner. Password hash.** On the PC, in any routeflow checkout:
   ```bash
   node tools/ops-monitor/bin/rf.mjs hash-password
   ```
   Type the board password at the prompt. It prints only `scrypt$<salt>$<hash>`; the password is
   never stored.
5. **Owner. Session secret.**
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
6. **Owner. Variables.** Service → Variables → New Variable, one by one (paste values; never in
   git, never in chat with an agent):
   | Variable                                                                                      | Value                                                                 |
   | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
   | `GITHUB_TOKEN`                                                                                | the token from step 3                                                 |
   | `OPS_PASSWORD_HASH`                                                                           | the `scrypt$…` line from step 4                                       |
   | `OPS_SESSION_SECRET`                                                                          | the 64 hex characters from step 5                                     |
   | `CLIENT_NAMES_JSON`                                                                           | the same JSON array as `~/.routeflow/ops/client-names.json` on the PC |
   | Do **not** set `RAILWAY_API_TOKEN` in phase A: without it the board shows deploys as          |
   | "unknown" and the ops project holds no token for the app's production project at all. (If you |
   | later want deploy rows: a **project token** of the app project's production environment; the  |
   | code sends only read queries, pinned by `test/cloud.test.mjs`.)                               |
   | `RF_CLOUD`, `RF_MACHINE`, `RF_OPS_HOME` come from the Dockerfile; Railway sets `PORT`.        |
7. **Owner. Domain.** Service → Settings → Networking → Generate Domain. Note the
   `https://<name>.up.railway.app` address.
8. **Owner. Deploy.** Service → Deployments → Deploy (or wait for the first build to start by
   itself). Boot clones both repos read-only before it listens (healthcheck timeout 300 s).
9. **Owner. Check.** In a browser:
   - `https://<domain>/api/health` returns `{"ok":true,…}`.
   - `https://<domain>/` redirects to `/login`; the wrong password is refused; the right one
     opens the board.
   - The board shows today's items and the "Machines and lanes" panel; no live client name
     appears anywhere (search the page for each name on your list).
     If the deploy fails: Deployments → the failed build → View logs. A missing or empty
     `CLIENT_NAMES_JSON`, `OPS_PASSWORD_HASH` or `OPS_SESSION_SECRET` stops the boot with a message
     naming the variable (never its value).
10. **Owner. Optional, real-time.** Make a webhook secret (step 5 command again), set it as
    `GITHUB_WEBHOOK_SECRET`, then on each of `routeflow` and `routeflow-specs`: Settings →
    Webhooks → Add: payload URL `https://<domain>/hooks/github`, content type
    `application/json`, the same secret, events: Pushes, Pull requests, Check runs, Check
    suites, Statuses, Deployment statuses. Without it the board polls (2 to 5 min behind).
11. **Owner. Share.** Give members the address and the password over a private channel (not
    the board, not git, not an issue).

Rotation: a new password = steps 4 and 6 for `OPS_PASSWORD_HASH`; to log everyone out, replace
`OPS_SESSION_SECRET`. Removing a member = new password plus removing their GitHub collaborator
access.

What it costs: one small always-on container (no database, no volume).

## Phase B: comment, claim and status from the hosted board (needs an owner ruling)

The ask includes acting on the board (comment, claim, release, status) from a browser, for a
person with no checkout at hand. Members with a checkout already do all of this with `rf`
(including `rf assign` and `rf inbox --wait`), so phase B is a convenience, not a blocker. That means the service must **write** events, which the 10-19 ruling
forbids. Proposed amendment for the owner to accept or refuse:

> The online ops monitor may append events to routeflow-specs `events/cloud/<day>.jsonl` only,
> of the kinds `comment`, `claim`, `release` and `status` (not `shipping`, `live` or
> `verified`, which follow merges and deploys), using a second fine-grained token with Contents
> Read and write on **routeflow-specs only**. Its token for the routeflow code repo stays
> read-only. It never touches the app's Railway project or database.

Build, after a yes (separate PR, test-first):

- **One login per member** instead of one shared password: `OPS_MEMBERS_AUTH_JSON` =
  `{"<member id>": "scrypt$…"}` (ids from `members` in specs `ops/config.json`). Each write
  is recorded under that member's id; a shared password cannot say who did what.
- `POST /api/actions/{comment,claim,release,status}`: same-origin check (already in
  `server.mjs`), body cap, per-member rate limit, and the same `validateEvent` plus
  `validateAgainstState` the CLI uses, so an action the CLI would refuse is refused here too.
- The writer is the only git write in the container: `appendEvents` under the specs lock,
  `events/cloud/` paths only; `readOnlyExec` keeps refusing writes for the code repo clone.
- New variable `GITHUB_SPECS_WRITE_TOKEN` (owner makes and pastes it; agents never do).
- Buttons on the item sheet: Comment (with mention picker from lanes and members), Claim /
  Release, and the status menu limited as above.

Until phase B ships, members act with `rf` on their own computer; the board shows the result
within a poll.

Triage stays off the hosted board in both phases. `rf triage promote` writes the bug registry
in the code repo (`scripts/campaign/bugs.mjs`), so it runs only on the lead's or coordinator's
machine. A tester's draft (`rf item new --type bug`, always status `draft`) could become a
phase B action later; it is not in the proposed kind list above.

## Not in this plan

- No staging copy of the app, no Railway access for members, no production database access.
- No second board, no Jira, Plane or GitHub Projects.
