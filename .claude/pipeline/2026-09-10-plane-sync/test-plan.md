# Test plan — Plane BUGS mirror (S4)

Status: IMPLEMENTED (fix-round 1 2026-09-11 added T20/T17b to TP1 and T12c/T12d plus the
temp-dir sweep pin to TP2). Author: Fable 5.1, 2026-09-10. Harness: standalone Node self-tests (repo
convention — no Jest project collects `scripts/**`). Every test uses a fake Plane server
(`node:http`, ephemeral port, `PLANE_BASE_URL=http://127.0.0.1:<port>`) that records requests and
serves canned projects/states/items, and a temp registry directory (`PLANE_SYNC_REGISTRY_DIR`)
seeded with a minimal `bugs.jsonl`, `status/F01.jsonl`, `board.json`. Oracles are concrete request
sequences and payload fields, never "no throw".

## TP1 — `scripts/campaign/plane-sync.self-test.mjs`

| T#  | R#  | Given                                                                     | When                       | Then (oracle)                                                                                                                                                                                                            |
| --- | --- | ------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | R1  | registry has B01 (queued, F01→issue 532); Plane has no items              | `runSync()`                | exactly one POST to `/work-items/` with `external_source:"routeflow-registry"`, `external_id:"B01"`, name `B01 · <title>`, state = Backlog id, priority `low`, description contains `#532`, `tier: T1`, `registry-hash:` |
| T2  | R4  | same registry; Plane already holds the item with the same `registry-hash` | `runSync()`                | zero POST/PATCH requests; summary `0 created, 0 updated`                                                                                                                                                                 |
| T3  | R2  | B01 ledger row becomes `done`, pr 601, proof `REG-B01 …`                  | `runSync()`                | one PATCH to that item with state = Live id and description containing `pr: #601` and `REG-B01`                                                                                                                          |
| T4  | R2  | B01 `regressed`                                                           | `runSync()`                | PATCH state = Backlog id; description contains `regressed`                                                                                                                                                               |
| T5  | R2  | B01 `refuted`                                                             | `runSync()`                | PATCH state = Cancelled id                                                                                                                                                                                               |
| T6  | R1  | Plane holds an item `external_id:"B99"` with no registry row              | `runSync()`                | no DELETE, no PATCH for B99; stderr mentions `B99 has no registry row (left as is)`                                                                                                                                      |
| T7  | R5  | `PLANE_API_KEY` unset                                                     | CLI run                    | exit 0, no network request received, stderr `Plane mirror: skipped (no PLANE_API_KEY)`                                                                                                                                   |
| T8  | R5  | fake server answers 429 once (`x-ratelimit-reset` = now+1) then 201       | `runSync()`                | the POST is retried once; final summary `1 created`                                                                                                                                                                      |
| T9  | R6  | drift present                                                             | `--dry-run` then `--check` | dry-run: zero writes, stdout lists `CREATE B01`; check: zero writes, exit 1; digest file NOT written by either                                                                                                           |
| T10 | R4  | after a successful run, registry unchanged                                | `--if-digest-changed`      | exit 0 with zero network requests (not even the projects GET)                                                                                                                                                            |
| T11 | R5  | tracked files                                                             | static                     | no `[0-9a-f]{8}-[0-9a-f]{4}-…` uuid literal in `scripts/campaign/plane-sync.mjs` or `.claude/hooks/stop.mjs`; no `PLANE_API_KEY=` literal                                                                                |

Vacuity guards: T2 asserts the recorded request log has length 3 (projects, states, items list) —
not merely "no error"; T7 asserts `server.requests.length === 0`.

## TP2 — `.claude/hooks/stop.gate5.spec.mjs`

| T#   | R#  | Given                                                                                                     | When            | Then                                                                                                    |
| ---- | --- | --------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| T12a | R7  | throwaway repo with `scripts/campaign/plane-sync.mjs` + `.claude/campaign/bugs.jsonl` modified, key unset | `node stop.mjs` | exit 0; stderr contains `Plane mirror: skipped (no PLANE_API_KEY)`                                      |
| T12b | R7  | same + fake server + key set                                                                              | `node stop.mjs` | exit 0; stderr contains `Plane mirror: 1 created, 0 updated`; the 25 s budget is reported, not asserted |

## Red gate

Both spec files are new. `scripts/campaign/plane-sync.mjs` exists on the pre-implementation tree
as a signature-only stub returning inert values (`undefined` / `[]` / `""` /
`{ created: 0, updated: 0 }`), so the module resolves and every oracle fails on its own expected
value rather than on a module-not-found crash: the recorded run was `exit 1, 15 ok / 40 FAIL`.
The 15 passing checks were all absence assertions (zero requests, no digest file, an absent source
literal) that a do-nothing stub satisfies by inaction; each has since been folded into a composite
oracle carrying its block's positive control. Re-measured against the same inert stub plus a
pre-Gate-5 `stop.mjs`: `exit 1, 2 ok / 61 FAIL` — the only two survivors are the source-hygiene
guards (`no raw NUL byte in plane-sync.mjs`, `no synchronous spawn of SCRIPT_PATH in this file`),
which assert text properties of the files themselves and claim no behavior. The
behavioral bar is unreachable for a create-the-script feature (the damage-report run recorded the
same); accepted, and the final gate + acceptance criteria are the proof. Commands: `node scripts/campaign/plane-sync.self-test.mjs`; `node .claude/hooks/stop.gate5.spec.mjs`.
