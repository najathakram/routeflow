# @routeflow/control

Delivery-program control service and `ctl` CLI. Zero runtime dependencies, no `@routeflow/*`
imports, deployed in isolation (`railway.toml` watches `apps/control/**` only).

- `npm run control` (repo root) — build if stale, then `ctl serve`.
- `npm run ctl -- <command>` — run the CLI.
- `npm run dev:control -w apps/control` — watch-run the server (named so root `npm run dev` skips it).
- `npm test -w apps/control` — Jest specs under `test/**/*.spec.ts`.
- Health probe: `GET /api/health?public=1` returns `{"ok":true}`.

`src/main.ts` is the service entry: it loads the config, refuses to boot on a bad one, then serves the
dashboard and polls its sources (`ctl serve` runs it in local mode).

The image builds from the root `package.json` and `package-lock.json`, which sit outside
`watchPatterns`, so a root lockfile change does not redeploy control.

## State repo setup

The control state is one git branch, `ctl/state`, written by `ctl` (and by the dashboard's web write path
only when `CONTROL_WRITEBACK=on`). It must live in a **separate,
private repo**. `ctl` refuses any state remote that resolves to the product repo itself
(`najathakram/routeflow`): every URL form (https, ssh, scp-like with a host alias, `git://`, `ext::`,
mixed case, percent-encoded, with or without `.git`, `/.git`, a trailing slash, or the `.wiki` suffix,
since the wiki goes public with the repo), and every origin that the git `ctl` runs resolves there through
`url.<base>.insteadOf` or `pushInsteadOf` (checked offline with `git ls-remote --get-url` and
`git config`). A local path or `file://` URL is refused when that directory is a git repo with any remote
git resolves to the product repo (including `include.path`, `config.worktree`, legacy `remotes/` and
`branches/` files), or whose remotes are local clones that do (up to 3 levels). That repo goes public during
CI windows, so the state must never share it, and no write key for it should exist.

1. Create a **private** repo for the state (any name except the product repo's), for example
   `<owner>/<state-repo>`, and give your machine push access (an SSH key or a credential helper).
2. Point `ctl` at it, once per machine: `ctl origin set ssh://git@<your-git-host>/<owner>/<state-repo>.git`
   (any git URL works). **Never put a token in the origin URL.** `ctl` redacts `user:token@` and any
   `?query` or `#fragment` in its own messages (`origin show`, `origin set`, refusals), but the URL is stored as
   typed in the 0600 origin file, and `git clone` writes it in plain text into the clone's `.git/config`.
   Use SSH keys or a git credential helper instead.
   `ctl origin` shows what is in force and where it came from (`flag`, `env`, `file` or `none`);
   `ctl origin unset` removes it. These three verbs never touch the network.
3. Write a roster, a JSON array of up to 60 lanes (ids are lane names: lowercase letters, digits and `-`, 2 to 24
   characters; `kind` is one of `feature bug test investigation release-prep lead sa coordinator owner`;
   `active` defaults to true):

   ```json
   [
     { "id": "lead", "name": "Lead", "machine": "mac-a", "kind": "lead" },
     { "id": "lane-a", "name": "Lane A", "machine": "mac-a", "kind": "feature" },
     { "id": "lane-b", "name": "Lane B", "machine": "mac-b", "kind": "bug", "active": false }
   ]
   ```

4. `ctl init --roster roster.json --dry-run` prints the plan (lane count, emitter, byte size) and pushes nothing
   (it does not contact the remote either). Then `ctl init --roster roster.json` creates the orphan `ctl/state`
   branch with a `README.md` and one `lane.registered` event per roster entry, all written to the emitter's
   `events/<emitter>.jsonl` (the first lead-like lane in the roster, or `--emitter <lane>`; it must have kind
   `lead`, `coordinator` or `owner`). It pushes once, never with force: an origin that already has
   `ctl/state` is refused (exit 3, "already initialised"), and a lost race is exit 5.
5. Add lanes later with `ctl lane register <id> --name "<name>" --machine <machine> --kind <kind> [--inactive]`,
   run as a lead-like lane (`--lane`, `CTL_LANE` or `ctl lane use`). It appends one `lane.registered` event like
   any other verb; registering an existing id updates its fields.

Configuration, in order of precedence: `--origin <url>` (one call), the `CONTROL_STATE_ORIGIN` environment
variable, then the first non-empty, non-`#` line of `<config dir>/origin`. The config dir is
`CONTROL_CONFIG_DIR` if set, else `$XDG_CONFIG_HOME` or `~/.config`, plus `/routeflow-control`. With none of them
set there is no state remote: `ctl next` prints one line (`control: no state remote configured ...`) and exits 0,
`ctl next --hook` prints nothing, and every other verb exits 2 with the same message. `ctl` no longer falls back
to the working repo's `origin`. `CONTROL_STATE_DIR` still overrides the local clone directory.

The dashboard server does not use any of this: it reads `ctl/state` from the state repo named by
`CONTROL_STATE_REPO` over HTTPS with the one read-only token (see "Credentials" below), and never pushes
unless `CONTROL_WRITEBACK=on`. `ctl` is the writer.

## Security notes

- **Logout is stateless.** The session is a signed 12 h cookie; `POST /logout` only clears it in that
  browser. A copied cookie stays valid until it expires. To invalidate every session, rotate
  `CONTROL_SESSION_SECRET` and redeploy.
- **Global login lockout.** The login limiter allows 5 failures per IP and 30 in total per 15 minutes.
  The 30-failure global cap means a determined attacker can lock the owner out of login for up to 15
  minutes (nothing else is exposed; the write path is unaffected for an existing session). Behind
  Railway the client IP is the rightmost `X-Forwarded-For` hop.
- Boot refuses to start (exit 1) without a 16+ character `CONTROL_PASSWORD`, `CONTROL_PUBLIC_URL`, a
  loadable denylist, and when `CONTROL_LOCAL=1` is set on Railway. Git children never inherit
  `CONTROL_*` variables.

## Credentials: one read-only token

The server reads two private repos with **one fine-grained GitHub token**, over HTTPS. There is no
deploy key and no SSH (GitHub deploy keys belong to a single repo, so they cannot serve both).

- **Scope:** `contents: read` on exactly `najathakram/routeflow` (the product repo: master
  registers, history) and `najathakram/routeflow-control-state` (the state branch). For the GitHub
  poller, also read access to pull requests, commit statuses and checks (and deployments, if the
  deploy panel is wanted) on the product repo. Nothing with write access, ever.
- **Where it lives:** only in the Railway env as `CONTROL_GITHUB_TOKEN`. It reaches git children as a
  scoped `http.https://github.com/.extraheader` (via `GIT_CONFIG_*` env), never in argv, a URL or
  `.git/config`, and is redacted from error text (the raw token and its Basic form, before any
  message is cut to length). Git also runs with `http.followRedirects=false`: a redirect is a
  failure, so the header can never reach another host. A renamed or moved repo (GitHub answers a
  redirect) therefore fails, and the boot probe counts the redirect as unknown (fail closed): fix
  `CONTROL_REPO` / `CONTROL_STATE_REPO` to the new name.
- **Write-back is off.** State is read from the separate state repo; a write token would be a
  separate, later change. State never lives in the product repo, and `CONTROL_STATE_REPO` set to
  `najathakram/routeflow` (any spelling: case, `.git`, `.wiki`, trailing `/` or `.`) is refused, as
  is a `CONTROL_STATE_REPO` equal to `CONTROL_REPO`. The `ctl origin set` check applies the same
  spellings (including a trailing `.` and percent-encoded `.` or NUL).
- **With write-back off the server never pushes, of any kind.** It fetches only: no PR-ledger commit
  (`derived/prs.jsonl`), no compaction and no archive push, so the read-only token never meets a failing
  push and `/api/health` carries no ledger error. The PR ledger then lives in memory only: the dashboard
  serves the rows it has seen since boot (only the newest 5,000 are kept), a restart starts from what is
  already on `ctl/state`, and PR history older than what the GitHub poll returns is not persisted. Turn
  `CONTROL_WRITEBACK` on (with a write credential limited to the state repo) to persist the ledger and
  to let the server compact the branch.

### Boot probe

Before it listens, a non-local, non-fixture boot sends one `GET <repo>.git/info/refs?service=git-receive-pack`
to each repo (product, then state) with the token. This is the push advertisement: it changes
nothing and pushes nothing. GitHub answers 200 only to a token that may push.

| Answer                 | Meaning                                       | Boot                          |
| ---------------------- | --------------------------------------------- | ----------------------------- |
| 200                    | token can write                               | refused, names the repo       |
| 401, 403, 404          | read-only (or no access)                      | continues                     |
| anything else, timeout | cannot verify (retried 3 times, 1 s then 2 s) | refused, names the repo + why |

Every boot logs one line per repo, status only (never a header or the token).

**First-deploy check:** read the two lines in the Railway log and confirm both say read-only with
a 403, for example `control: probe <owner>/<repo> -> read-only (403)`. A `WRITE access (200)` or
`unknown (...)` line means the boot was refused: replace the token with a read-only one, or look at
the reason in parentheses.

**What the probe can and cannot tell you.**

- It detects only `contents: write` (push). A token that also carries `pull_requests`, `issues`,
  `actions`, `administration` or any other write permission would pass. Create the token with
  **only the read permissions listed above** and nothing else; the probe is a backstop, not the
  permission review.
- It assumes GitHub answers 403 on `git-receive-pack` to a read-only token. On the first deploy
  read the two `control: probe <repo> -> ...` lines to confirm that is what GitHub does for this
  token. If GitHub answers something else (say 200 for everyone), the boot refuses and the log
  names the status; do not work around it by editing the probe.

### Environment

| Variable                                                  | Required   | Notes                                                  |
| --------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `CONTROL_PASSWORD`                                        | yes        | 16+ characters                                         |
| `CONTROL_SESSION_SECRET`                                  | yes        | 32+ bytes                                              |
| `CONTROL_GITHUB_TOKEN`                                    | yes        | the read-only token above                              |
| `CONTROL_REPO`                                            | yes        | `owner/name` of the product repo                       |
| `CONTROL_STATE_REPO`                                      | yes        | `owner/name` of the state repo; never the product repo |
| `CONTROL_PUBLIC_URL`                                      | yes        | the origin writes are checked against                  |
| `CONTROL_WEBHOOK_SECRET`                                  | no         | enables the GitHub webhook                             |
| `CONTROL_WRITEBACK`                                       | no         | web write path; default off, only exactly `on` enables |
| `CONTROL_RAILWAY_TOKEN`, `_PROJECT_ID`, `_ENVIRONMENT_ID` | no         | deploy panel                                           |
| `CONTROL_STATE_DIR`, `CONTROL_MASTER_DIR`                 | no         | clone locations (default under the OS temp dir)        |
| `CONTROL_PORT` / `PORT`                                   | no         | default 3000 (4317 in local mode)                      |
| `CONTROL_LOCAL=1`, `CONTROL_FIXTURE`                      | local only | refused on Railway; local needs no secrets             |
| `CONTROL_DEPLOY_KEY_B64`                                  | retired    | ignored; boot prints a warning, remove it              |

**`CONTROL_WRITEBACK`** switches the dashboard's web write path (`POST /api/event`) on or off. It is
**off by default**, and only the exact, case-sensitive string `on` turns it on (`ON`, `true`, `1`,
`yes` and anything else stay off, without an error). While off, the page shows a "View only" chip, every
Save, Dismiss, Make next and Give to button is disabled, and a direct `POST /api/event` from a signed-in
browser session answers `403 {"error":"writeback_off"}` before it reads the body or touches the state
clone (an unauthenticated call still gets `401`). Why: a web save needs a write credential limited to
the state repo, and this version carries only the read-only token above, so every web save would fail
anyway. Boot prints a warning if you set `on` against a real deployment. Off also means the server
itself never pushes (no ledger commit, no compaction; see Credentials). The `ctl` CLI writes lane state
directly and is unaffected.
