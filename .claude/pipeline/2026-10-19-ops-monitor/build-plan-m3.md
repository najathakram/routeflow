# Build plan, milestone 3: online on Railway + apple-design pass

Owner ruling 2026-10-19: the monitor runs online as a new Railway service in the SAME routeflow project, behind a password login, and the UI/UX/flow follow the apple-design skill. Read `build-plan.md` (same folder) first: its design rules, contracts and Snapshot shape all still apply.

The same code runs locally (dev) or in a Railway container. Nothing is on disk at container boot. Every secret comes from env vars that the OWNER sets in the Railway dashboard; agents never type secrets:
- `GITHUB_TOKEN`: fine-grained. routeflow read (contents, pull requests, checks/statuses, metadata); routeflow-specs read+write contents.
- `RAILWAY_API_TOKEN`: project token, read.
- `OPS_PASSWORD_HASH`: `scrypt$<saltB64>$<hashB64>`, N=16384 r=8 p=1 keylen 64, made by `rf hash-password`.
- `OPS_SESSION_SECRET`: at least 32 random bytes, hex.
- `GITHUB_WEBHOOK_SECRET`.
Non-secret: `PORT` (Railway), `RF_CLOUD=1`, `RF_MACHINE=cloud`, `RF_OPS_HOME=/tmp/ops`.

## P6: cloud server (auth, webhooks, boot, deploy files)
Files: `tools/ops-monitor/lib/{auth,webhooks,cloud}.mjs`, `tools/ops-monitor/public/login.html`, `tools/ops-monitor/Dockerfile`, `tools/ops-monitor/railway.toml`, `.dockerignore` at the repo root ONLY IF none exists (check first; if one exists, use a Dockerfile-specific `tools/ops-monitor/Dockerfile.dockerignore` instead). Edits to `tools/ops-monitor/server.mjs` (auth, webhooks, `--cloud`) and to `tools/ops-monitor/lib/collector.mjs` (cloud sources). Edits to `tools/ops-monitor/lib/config.mjs`: add `repoDir(env)` = `RF_REPO_DIR` || REPO_ROOT, and `isCloud(env)`. Tests: `test/{auth,webhooks,cloud}.test.mjs`, plus new cases in `test/collector.test.mjs`.

**`auth.mjs`** (pure + node:crypto):
- `hashPassword(pw, { salt? })` → `scrypt$…`. `verifyPassword(pw, stored)` uses timingSafeEqual; malformed → false.
- `signSession({ exp }, secret)` → `<b64url payload>.<b64url hmac-sha256>`. `verifySession(token, secret, now)` → boolean; bad sig, expired or malformed → false.
- Cookie `ops_session`: `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (30 days), plus `Secure` when cloud or `x-forwarded-proto: https`.
- `createRateLimiter({ max: 10, windowMs: 900000 })` → `{ hit(key, now) → allowed }`, keyed by client IP (first hop of `x-forwarded-for`, else the socket address).
- `parseCookies(header)`.
- `rf hash-password` (add to bin/rf.mjs): reads the password from stdin without echo where possible, prints only the hash.

**Server auth wiring:**
- Applies when `OPS_PASSWORD_HASH` is set (always in cloud; optional locally).
- Open without a session: `GET /login`, `POST /login`, `GET /api/health`, `POST /hooks/github`, `GET /app.css`. Every other route needs a valid session: HTML routes 302 to `/login`, API and SSE return 401.
- `POST /login`: form urlencoded field `password`, body ≤ 4 KB. Rate limit, then verify. Right → cookie + 303 `/`. Wrong → 303 `/login?e=1` with a generic message.
- `POST /logout` clears the cookie.
- With `--cloud`/`RF_CLOUD=1` and no `OPS_PASSWORD_HASH` or `OPS_SESSION_SECRET`, the server refuses to start (exit 1, clear message). Never serve the board unauthenticated online.
- Every response carries: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-frame-options: DENY`, `content-security-policy: default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'`. Make sure the existing page still works under this CSP (no inline scripts or styles; move any to the static files).
- Webhook body cap 1 MB.

**`webhooks.mjs`:**
- `verifyGithubSignature(rawBody, header, secret)`: `sha256=`, timingSafeEqual.
- `routeWebhook(eventName, payload)` → source names to refresh now:

| Event | Sources |
|---|---|
| `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `status` | `github` |
| `push` to repo `routeflow-specs` | `specs` |
| `push` to routeflow `refs/heads/master` | `github`, `branches`, `bugs`, `areas` |
| any other routeflow `push` | `branches` |
| `deployment_status` | `railway` |
| `ping`, anything else | none |

- `POST /hooks/github`: 401 on a bad or missing signature, 400 on bad JSON, else 202 at once. Then `collector.runOnce(name)` for each source, debounced 2 s per source.

**`cloud.mjs`:**
- `cloudBoot({ env, exec })` requires `GITHUB_TOKEN`.
- Clones, if missing:
  - routeflow-specs (full) into `specsDir()`;
  - routeflow with `git clone --filter=blob:none --no-checkout` into `<opsHome>/routeflow` (export `repoDirFor(env)`).
- Auth uses `git -c http.extraHeader="Authorization: Basic <b64 of x-access-token:TOKEN>"` on clone. Afterwards it is stored with `git config --local http.https://github.com/.extraheader …` inside these two tool-owned container clones only, so the token is never in a URL. Comment why.
- Sets `user.name "RouteFlow Ops Monitor"` and `user.email "ops-monitor@users.noreply.github.com"` in the specs clone.
- Never logs the token: export `redact(text)`, which strips `x-access-token…`, `Authorization: …` and `ghp_/github_pat_` strings, and use it on every logged error.
- Returns `{ repoDir, specsDir }`.

**Collector cloud mode** (edit `collector.mjs`):
- `github` source: when `GITHUB_TOKEN` is set, use `fetch("https://api.github.com/graphql", { method: "POST", headers: { authorization: "bearer " + token, "content-type": "application/json", "user-agent": "routeflow-ops-monitor" }, body: JSON.stringify({ query }) })`; else `gh api graphql`.
- `railway` source: when `RAILWAY_API_TOKEN` is set, POST `https://backboard.railway.com/graphql/v2` with header `Project-Access-Token: <token>`. Query `projectToken { projectId environmentId }`, then `project(id: …) { services { edges { node { name serviceInstances { edges { node { environmentId latestDeployment { status createdAt meta } } } } } } } }`, and map with the same output as `parseRailwayStatus` (services named `@routeflow/*`, production environment = the token's environment). Else use the CLI.
- Inject `fetch` for tests.
- Cloud intervals: github 120 s, specs 120 s, branches 300 s (fetch every run; it's the container's own clone), bugs 300 s, areas 600 s, railway 300 s. Webhooks make it real time; the polls are the backstop.

**Deploy files:**
- `Dockerfile` (build context = repo root): `node:20-alpine`, `apk add --no-cache git`, copy only `tools/ops-monitor/`, run as a non-root user, `ENV RF_CLOUD=1`, `CMD ["node", "tools/ops-monitor/server.mjs", "--cloud"]`.
- `railway.toml`: `[build] builder = "DOCKERFILE"`, `dockerfilePath = "tools/ops-monitor/Dockerfile"`, `watchPatterns = ["tools/ops-monitor/**"]`; `[deploy] healthcheckPath = "/api/health"`, `restartPolicyType = "ON_FAILURE"`, `numReplicas = 1` (one views writer).
- Railway reads one config file per service (path set in the service settings), so this file never affects the api/web services.

**`server.mjs --cloud`:**
- Binds `0.0.0.0:$PORT` and runs `cloudBoot`.
- Starts the collector with `repoRoot = repoDir` and cloud intervals.
- Views writer ON: the cloud service becomes the single writer of the generated views.
- `/api/health` returns `{ ok, generatedAt, sources: { name: ok } }` and nothing private.

**Tests:**
- hash/verify round trip, wrong password, malformed hash;
- session sign/verify, expired, tampered;
- rate limiter: 11th attempt blocked, then the window resets;
- login flow on a real server on port 0: no cookie → 302 /login; wrong password → 303 /login?e=1; right → cookie, then /api/snapshot 200; /sse 401 without a cookie;
- cloud env with no hash → start refused;
- webhook signature valid / invalid / missing;
- the routeWebhook table;
- redact() strips tokens;
- the CSP header is present on every response;
- collector github-by-fetch and railway-by-API parsing, with injected fetch and fixtures.

## P7: apple-design pass on the page (UI, UX, flow)
Files: `tools/ops-monitor/public/{index.html,app.js,app.css}`. P7 owns them; P6 owns `login.html`. Add `.login-*` classes to app.css for P6's page: a centered card, one password field, one button, an error line.

Read `~/.claude/skills/apple-design/SKILL.md` and apply it to the existing page. Keep every existing function and the textContent-only rendering. No new dependencies; no inline scripts or styles (the CSP forbids them).

**Purpose / simplicity.** The first screen answers three questions: is anything wrong, what is everyone doing, what's next.
- A top summary band: alarms by severity, lanes busy/silent, the next train and its ETA, freshness.
- Detail sits one level deeper.

**Typography.**
- Hierarchy from weight + size + leading.
- Size-specific tracking: display −0.02em, body 0, small +0.01em.
- `system-ui` font; `font-variant-numeric: tabular-nums` for counts, ages and shas.

**Materials and depth.**
- Translucent sticky header (`backdrop-filter`) with a scroll-edge fade instead of a hard border.
- `prefers-reduced-transparency`: solid fallback.
- `prefers-contrast: more`: solid borders.

**Motion and interaction.**
- Spatial consistency: the area filter/drawer enters and exits along the same path, anchored to the chip clicked.
- Press feedback on pointer-down (`:active` scale .97, 100 ms).
- Critically damped motion only, no bounce: nothing on this page is flung.
- `prefers-reduced-motion`: cross-fade only.

**Colour.** Never alone: severity carries a text label and an icon shape. Light and dark tokens adapt.

**Wayfinding.**
- A compact section nav (chips that jump to panels, sticky under the header).
- Every panel answers: where am I, and what's here.
- Direct labels: Drift, Releases, Lanes, Owner, Items, Bugs, PRs.

**Proof.** Screenshots at 1440, 768 and 390 wide, light and dark, from the built-in browser against `node tools/ops-monitor/server.mjs --fixture tools/ops-monitor/test/fixtures/snapshot-sample.json --port 4399`. No console errors and no horizontal scroll at 390. Kill only your own server PID; reset the viewport to desktop.
