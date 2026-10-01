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
  loadable denylist, and when `CONTROL_LOCAL=1` is set on Railway. Git over SSH uses a pinned GitHub
  host key (`StrictHostKeyChecking=yes`) and never inherits `CONTROL_*` variables.
