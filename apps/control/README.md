# @routeflow/control

Delivery-program control service and `ctl` CLI. Zero runtime dependencies, no `@routeflow/*`
imports, deployed in isolation (`railway.toml` watches `apps/control/**` only).

- `npm run control` (repo root) — build if stale, then `ctl serve`.
- `npm run ctl -- <command>` — run the CLI.
- `npm test -w apps/control` — Jest specs under `test/**/*.spec.ts`.
- Health probe: `GET /api/health?public=1` returns `{"ok":true}`.

`src/main.ts` is a minimal boot stub; later work packages fill in the service.

The image builds from the root `package.json` and `package-lock.json`, which sit outside
`watchPatterns`, so a root lockfile change does not redeploy control.
