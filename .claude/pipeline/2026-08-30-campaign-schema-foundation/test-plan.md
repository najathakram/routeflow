# F01 · Schema foundation — test plan

**Status: EXECUTED.** A schema-only batch has a deliberately thin test surface: the artifacts
that prove it are the migration replay and the compiler, not new unit tests — there is no new
behavior to pin. (A spec asserting "column X exists" would be a tautology against the generated
client and could never go red under any plausible mutation except deleting the migration itself,
which T2 already catches.)

| T#  | Level            | Proves                                                                          | Oracle                                           | Why not vacuous                                                                                                                                                                                                 |
| --- | ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | typecheck        | R4 — the unique-key rename ripples nowhere else                                 | `npx tsc -p tsconfig.build.json --noEmit` exit 0 | It failed BEFORE the call-site fix (5 × TS2561, then TS2739 on DEFAULTS) and passed after — observed red→green this session                                                                                     |
| T2  | migration replay | R1/R2/R3 — the full history including `20260908000000` applies from zero        | CI `db-migrations.yml` (fresh Postgres) green    | The job replays every migration; a syntactically broken or non-additive-ordering migration fails it. Mutation: reorder the DROP INDEX after the CREATE UNIQUE INDEX with the old index name kept — replay fails |
| T3  | jest (existing)  | R3/R4 behavior — `updateSettings`/`reserveNext` still address the year-0 series | `npx jest numbering` 14/14 passed                | The suite went red on the rename (upsert `where` shape pinned by the spec) and green only after the call sites AND the expectation moved together                                                               |

Run artifacts: T3 rides in the full api jest pass (`.campaign/runs/api.json` when the batch gate
runs); T2's artifact is the CI job on this PR. No `REG-B###` obligations exist — F01's ledger
shard is empty by design (no bug IDs are closed by columns alone).

**Vacuity note per the campaign plan:** `prisma-mock.ts` pass-through concerns don't apply — no
tenancy behavior changes here; the only behavioral surface is NumberingService, covered by its
real fake-store spec (14 tests, including the collision guard).
