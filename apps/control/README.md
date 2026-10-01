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

The control state is one git branch, `ctl/state`, written only by `ctl`. It must live in a **separate,
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

**Dashboard server (not in this change).** `ctl serve` / `src/main.ts` / `src/config.ts` still derive the
state origin from `CONTROL_REPO` (over SSH with the one deploy key in `CONTROL_DEPLOY_KEY_B64`) and read the
registers, PRs and CI from that same repo. So today the server can only read `ctl/state` from the repo named
by `CONTROL_REPO`, which is exactly what this change forbids for the CLI. Reading the state from a separate
state repo needs a second credential (a deploy key for the state repo) and its own config; that is a
follow-up. Until it lands, do not point a deployed server at a state that lives only in the separate repo: it
would not see it. The CLI side (`init`, `lane register`, `next` and every writing verb) works against the
separate repo today.

## Security notes

- **Logout is stateless.** The session is a signed 12 h cookie; `POST /logout` only clears it in that
  browser. A copied cookie stays valid until it expires. To invalidate every session, rotate
  `CONTROL_SESSION_SECRET` and redeploy.
- **Global login lockout.** The login limiter allows 5 failures per IP and 30 in total per 15 minutes.
  The 30-failure global cap means a determined attacker can lock the owner out of login for up to 15
  minutes (nothing else is exposed; the write path is unaffected for an existing session). Behind
  Railway the client IP is the rightmost `X-Forwarded-For` hop.
- Boot refuses to start (exit 1) without a 16+ character `CONTROL_PASSWORD`, `CONTROL_PUBLIC_URL`, a
  loadable denylist, and when `CONTROL_LOCAL=1` is set on Railway. Git over SSH uses a pinned GitHub
  host key (`StrictHostKeyChecking=yes`) and never inherits `CONTROL_*` variables.
