# @routeflow/control

Delivery-program control service and `ctl` CLI. Zero runtime dependencies, no `@routeflow/*`
imports, deployed in isolation (`railway.toml` watches `apps/control/**` only).

- `npm run control` (repo root) — build if stale, then `ctl serve`.
- `npm run ctl -- <command>` — run the CLI.
- `npm run dev:control -w apps/control` — watch-run the server (named so root `npm run dev` skips it).
- `npm test -w apps/control` — Jest specs under `test/**/*.spec.ts`.
- Health probe: `GET /api/health?public=1` returns `{"ok":true}`.

`src/main.ts` is a minimal boot stub; later work packages fill in the service.

The image builds from the root `package.json` and `package-lock.json`, which sit outside
`watchPatterns`, so a root lockfile change does not redeploy control.

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
  redirect) therefore fails; point `CONTROL_REPO` / `CONTROL_STATE_REPO` at the new name.
- **Write-back is off.** State is read from the separate state repo; a write token would be a
  separate, later change. State never lives in the product repo, and `CONTROL_STATE_REPO` set to
  `najathakram/routeflow` (any spelling: case, `.git`, `.wiki`, trailing `/` or `.`) is refused, as
  is a `CONTROL_STATE_REPO` equal to `CONTROL_REPO`.

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
- A renamed repo answers a redirect, which counts as unknown, so the boot refuses (fail closed).
  Fix the repo name in the env.

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
| `CONTROL_RAILWAY_TOKEN`, `_PROJECT_ID`, `_ENVIRONMENT_ID` | no         | deploy panel                                           |
| `CONTROL_STATE_DIR`, `CONTROL_MASTER_DIR`                 | no         | clone locations (default under the OS temp dir)        |
| `CONTROL_PORT` / `PORT`                                   | no         | default 3000 (4317 in local mode)                      |
| `CONTROL_LOCAL=1`, `CONTROL_FIXTURE`                      | local only | refused on Railway; local needs no secrets             |
| `CONTROL_DEPLOY_KEY_B64`                                  | retired    | ignored; boot prints a warning, remove it              |
