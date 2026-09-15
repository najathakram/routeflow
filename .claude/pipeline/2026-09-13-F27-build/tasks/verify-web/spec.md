# verify-web spec — F27 estimates UI (fix round 4 ruling)

**Purpose:** the `specPath` the `ui-verify` driver must be given on re-run (fix-r4 finding #2).
Assertions map to build-plan acceptance criteria 6 and 8; nothing here is an ad-hoc observation.

## Target stack — isolated, NOT the shared `:3001` stack

The shared compose stack (`routeflow_web/api/postgres/redis`, `:3001/:3000/:5432/:6379`) is owned
by other worktrees (rf-F25 / rf-imp-E / repo root) and is never touched from this worktree
(fleet rule: one owner per item). This task runs against its own compose project:

| Service  | Container                | Host port | Image               |
| -------- | ------------------------ | --------- | ------------------- |
| web      | `routeflow_f27_web`      | `3101`    | `routeflow-web:f27` |
| api      | `routeflow_f27_api`      | `3100`    | `routeflow-api:f27` |
| postgres | `routeflow_f27_postgres` | `5433`    | (compose default)   |
| redis    | `routeflow_f27_redis`    | `6380`    | (compose default)   |
| migrate  | `routeflow_f27_migrate`  | —         | `routeflow-api:f27` |

Compose project name: `rf-f27-build`. Verified live 2026-09-13T09:50Z from this worktree:
`GET http://localhost:3101/` → 200, `GET http://localhost:3100/api/v1/health` → `{"status":"ok"}`.

### Recreating the stack (override file lives outside the repo — OS temp dir)

Write the following to `<scratchpad>/f27-override.yml`, then from the worktree root:

```
docker compose -p rf-f27-build -f docker-compose.yml -f <scratchpad>/f27-override.yml --profile app up -d --build
```

```yaml
services:
  postgres:
    container_name: routeflow_f27_postgres
    ports: !override
      - "5433:5432"
  redis:
    container_name: routeflow_f27_redis
    ports: !override
      - "6380:6379"
  migrate:
    image: routeflow-api:f27
    container_name: routeflow_f27_migrate
  api:
    image: routeflow-api:f27
    container_name: routeflow_f27_api
    environment:
      CORS_ORIGINS: http://localhost:3101,http://localhost:3100
    ports: !override
      - "3100:3000"
  web:
    build:
      args:
        NEXT_PUBLIC_API_URL: http://localhost:3100/api/v1
    image: routeflow-web:f27
    container_name: routeflow_f27_web
    ports: !override
      - "3101:3000"
```

`web`'s API URL is baked at build time — the override sets it to `:3100`, so the images must be
built with this override present (`--build`), never re-tagged from `routeflow-web:local`.
Seed / validate / test:db against this stack need the port substitutions
(`API_URL=http://localhost:3100`, `DATABASE_URL=...localhost:5433/...`, `REDIS_URL=...:6380`) — the
stock `npm run local:*` scripts assume `:3000/:5432/:6379` and would hit the OTHER owner's stack.

## Preconditions the driver must prove before any assertion

- `baseUrl = http://localhost:3101`, tenant `test`, operator `admin` (password from the seed
  runbook — `test` tenant only; no other tenant slug may appear in any request).
- The driver records the git SHA the images were built from (`git rev-parse HEAD` + `git status
--short` at build time). A dirty tree at build time is reported, not hidden.
- Page-loaded proof for EVERY screen: final URL + a visible heading text. An assertion list,
  console/network/a11y capture with zero entries and no page-loaded proof is a RED
  (`completed=false`), never a clean pass (fix-r4 finding #1).

## Assertions (each: URL seen + exact text seen; any mismatch is RED)

| id  | Criterion (build-plan #6/#8)            | Steps                                                              | Expected                                                                                                                                   |
| --- | --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Convert gating — DRAFT                  | Open `/estimates/<draft id>`                                       | 0 controls whose accessible name matches `/convert/i`                                                                                      |
| A2  | Convert gating — SENT                   | Open `/estimates/<sent id>` (use A4's estimate after mark-as-sent) | 0 controls matching `/convert/i`                                                                                                           |
| A3  | Convert gating — ACCEPTED               | Open `/estimates/<accepted id>`                                    | exactly 2 controls matching `/convert/i` (one predicate, two placements)                                                                   |
| A4  | Mark-as-sent copy claims no delivery    | On a DRAFT estimate click the control named `Mark as sent`         | toast contains `Estimate marked as sent` AND `No email was sent.`; no `Send` button remains                                                |
| A5  | B15-NAV landing URL                     | On an ACCEPTED estimate click Convert, confirm                     | final URL matches `^/invoices/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`; RED on `/invoices/undefined` or any non-UUID |
| A6  | issueDate persistence — list            | Create an estimate with issue date `2026-09-01`; open `/estimates` | the new row shows `Sep 1, 2026` (UTC-fixed; not Aug 31 / Sep 2 in any host TZ)                                                             |
| A7  | issueDate persistence — detail          | Open the new estimate's detail                                     | issue date shows `Sep 1, 2026`                                                                                                             |
| A8  | Convert failure surfaces server message | Convert an estimate already CONVERTED (via API, then reload UI)    | toast shows the server's `ConflictException` message, not a generic string                                                                 |

Viewports: `desktop` (1280×800) mandatory; `mobile` (375×812) for A1–A5 as a report, not a gate.

## Capture requirements (per screen, per viewport)

- `consoleErrors`: every `console.error` / uncaught exception — expected `[]` ONLY together with
  a page-loaded proof for that screen.
- `networkFailures`: every response ≥ 400 and every aborted request to `localhost:3100` — the
  A8 4xx is expected and must be listed (it proves capture works), everything else is RED.
- `a11y`: axe run on estimate list, estimate detail (DRAFT + ACCEPTED), invoice landing page;
  `serious`/`critical` violations are RED.
- One screenshot per assertion row, stored under `local-assets/` (never `docs/`).

## Evidence record

`ui-evidence.json` for the re-run must have `completed=true`, `specPath` pointing at this file,
`assertions[]` with one entry per A1–A8 carrying `{id, url, textSeen, pass}`, and
`baseUrl=http://localhost:3101`. The round-4 record (`completed=false`, `specPath=""`,
`assertions=[]`) is a truthful BLOCKED record for the shared `:3001` stack and stays as-is.
