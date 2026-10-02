# Route hit counter (dead-weight W3)

Counts how often each API route template is called, to find the routes nobody calls. Counts only: a route
template and a number per UTC day. No tenant, user, IP, URL, query, header or body is ever recorded.

## What it counts

- A global interceptor (`apps/api/src/route-hits`) counts each matched `METHOD /api/v1/<template>`
  **after** the route guards, so it counts **authenticated/allowed** calls. A call refused by a guard
  (401/403) or throttled is **not** counted. A handler that throws **is** counted (the count happens
  before the handler runs). A request that matched no route never reaches an interceptor.
- `record()` is an in-memory increment (bounded to 2,000 distinct keys; extra keys are dropped and counted
  in a `__DROPPED__` field). A timer flushes every 10 s with one Redis pipeline (`HINCRBY` into
  `rf:route-hits:<UTC date>`, `EXPIRE` 45 days). Nothing on the request path awaits or touches Redis.
- Each replica flushes independently; `HINCRBY` is additive, so the daily totals add up. A replica loses at
  most ~10 s of counts on a crash or shutdown. Counts around UTC midnight can land in the next day's bucket.
- If Redis is not persistent, a Redis restart resets the day's bucket. A day with no bucket is
  **unobserved**, never "zero".
- Kill switch: `ROUTE_HITS_ENABLED=false`. It is ON by default except under Jest.

## The report (read-only, owner-run)

```bash
REDIS_URL=redis://… node apps/api/scripts/report-zero-call-routes.mjs --days 14
```

It reads the 111 routes the dead-weight audit found with no in-repo caller
(`apps/api/scripts/data/no-caller-routes.json`) and prints those with **zero** calls over the window, with the
audit's dead-confidence. It issues only `HGETALL`. If fewer than `--days` days were observed it says zero is
**not conclusive**. Zero in 14 days is evidence for the high-confidence routes; a monthly or old-mobile-build
caller needs a longer window. `--self-test` runs offline.

`no-caller-routes.spec.ts` fails if a listed route disappears from the controllers, so regenerate the list when
a route is removed.
