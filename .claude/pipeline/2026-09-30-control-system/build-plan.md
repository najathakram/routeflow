# Build plan: Routeflow Development Control System — slice 1

> **Stage P7 — "how".** Authored 2026-09-30 by Fable 5.1. Status: `DRAFT`.
> **DERIVED from [test-plan.md](./test-plan.md).** Inputs: [discovery.md](./discovery.md) (why,
> evidence E1-E55, assumptions A1-A18), [spec.md](./spec.md) (R1-R35), [ux-spec.md](./ux-spec.md),
> [test-plan.md](./test-plan.md) (T1-T64). This file is the only context implementers get.
> Repo truth was read from `origin/master` @ `47f648ce` — **implementers must branch from a fresh
> `origin/master`**, never from the `chore/opus-5-5-routing` checkout (299 commits behind).

**Gate:** every package declares `satisfies:` / `provenBy:`. **Ground rule:** every path below
exists on master or is marked **(new)**.

---

## Evidence & assumptions

See [discovery.md](./discovery.md) §0 for E1-E55 and A1-A18. Claims that appear only here:

| # | Claim | Source | Kind |
|---|---|---|---|
| E56 | `apps/api/package.json` scripts: `build: nest build`, `lint: eslint "{src,apps,libs,test}/**/*.ts"`, `check-types: node scripts/check-types-ratchet.mjs`, `test: node scripts/run-unit-tests.mjs`; jest 30 + ts-jest 29 | `apps/api/package.json:9-19, 123-130` | code |
| E57 | api `tsconfig.json` uses `module/moduleResolution: nodenext`, `target ES2023`, `outDir ./dist`, excludes specs | `apps/api/tsconfig.json` | code |
| E58 | api `eslint.config.mjs` = `tseslint.config(eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier recommended)` with `dist/` and specs ignored | `apps/api/eslint.config.mjs:1-20` | code |
| E59 | Root scripts already use the `name: node <path>` shape (`bugs`, `plane:*`, `work:*`) — adding `control` and `ctl` follows it | root `package.json` | code |

| # | Assumption (this file) | What breaks | Check |
|---|---|---|---|
| A19 | `tsc` CJS output (`module: nodenext` with `"type"` unset → CommonJS `.js`) runs under `node dist/main.js` and ts-jest without ESM flags, as in api | Jest ESM pain | WP0 smoke: one spec + `node dist/main.js --version` |
| A20 | Alpine `apk add git openssh-client` is enough for `git clone` over SSH with a deploy key mounted from env | server cannot fetch | WP0 Dockerfile build locally: `docker build -f apps/control/Dockerfile .` then `docker run … node dist/main.js --check-git` |

---

## Objective

Give the owner one private always-on page that answers now / next / broken / shipping / wasted for
the whole fleet, computed from GitHub, Railway, the master registers and a per-lane event branch,
with zero model tokens in the loop; and give every lane a two-command interface (`ctl next`,
`ctl <verb>`) costing ≤ 150 tokens per status change.

**In scope:** `apps/control` service + CLI, `ctl/state` branch mechanics, inference (PRs,
branches, checks, deploys), waste rules, home page, write-back, hooks wiring, rule text.
**Out of scope:** spec §10.

---

## Constraints & conventions

- **Stack:** TypeScript + Node 24 `http`/`crypto`/`child_process`/`fetch`; **no framework, no
  DB, no `@routeflow/*` dependency** (R27). Copy `apps/api`'s `tsconfig.json` (E57) minus
  decorators/jsx; `eslint.config.mjs` (E58); Jest block (E47) with `artifact: "control"` only if
  A18 says the reporter is harmless — otherwise omit the campaign reporter.
- **Tests:** Jest via `npm test -w apps/control`; specs under `apps/control/test/**/*.spec.ts`
  (`rootDir` = workspace root, `testRegex: "test/.*\\.spec\\.ts$"`). No Vitest, no root runner.
- **Lint/format:** Prettier (double quotes, 100 cols, trailing commas); ESLint per workspace.
- **Patterns to copy:** lock dir + stale check `scripts/campaign/bugs.mjs:2029-2212`; atomic
  write `scripts/roadmap/render.mjs:159-163`; CLI arg parsing `render.mjs:546-557`; Dockerfile
  `apps/api/Dockerfile:1-30`; `railway.toml` `apps/api/railway.toml`; self-test-style fixture
  sweeping `scripts/roadmap/render.self-test.mjs:34-56`; trailer parsing
  `scripts/roadmap/from-git.mjs:28+` (`parseTrailers`, re-implemented in TS, 15 lines).
- **Design system:** ux-spec §1 tokens only (render.mjs CSS values + Ledger status pairs).
- **Must NOT change:** any file under `.claude/roadmap/`, `.claude/campaign/`, `apps/api`,
  `apps/web` (except the two new Playwright files), `packages/*`, `scripts/roadmap/*`,
  `.github/workflows/*`, `stop.mjs`.
- **Do-not-introduce:** Vitest, Biome, Supabase, Vercel, a second HTTP client, root ESLint,
  React/Next in `apps/control`, any CDN asset, any `packages/*` import.
- **Landmines:** `echo ====` in zsh expands `=cmd` (use quotes); the repo's `git show $VAR:path`
  mangling on this Mac (quote the literal); commitlint rejects uppercase subjects — commit subjects
  like `feat(control): …`; `lint-staged` reformats `.json`/`.md` on commit (verify the committed
  tree); Gate 2 requires a code-map entry for `apps/control` or the `Bookkeeping-Follow-Up:
  pending` trailer on HEAD; the size ratchet does not cover new files but `check-staged-file-size`
  blocks > 1 MiB (the golden HTML must stay small: fixture, not 817 bugs).

---

## Test packages (authored first; write tests only)

| TP | writes (all new) | tests |
|---|---|---|
| TP1 domain | `apps/control/test/{validate,transitions,fold,next,overlap,piggyback,adapters,releases}.spec.ts`, `test/helpers/clock.ts`, `test/fixtures/acme/registers/*.jsonl`, `test/fixtures/acme/state/events/*.jsonl` | T1-T4, T7-T10, T12-T17 |
| TP2 cli | `test/{cli,cli-next,cli-concurrency,denylist,compact,registers-untouched}.spec.ts`, `test/helpers/{temp-repo,spawn-cli}.ts` | T6, T11, T18-T23, T37, T55, T58, T63 |
| TP3 server | `test/{server,server-auth,server-write,server-security,server-sse,server-webhook}.spec.ts`, `test/helpers/start-server.ts` | T28, T29, T31-T34, T38-T41, T53, T54 |
| TP4 inference | `test/{prs,reconcile,waste,waste-relanded,github-budget}.spec.ts`, `test/fixtures/acme/github/*.json`, `test/fixtures/acme/railway/deployments.json` | T42-T52 |
| TP5 render | `test/{render,render.golden,render-states,contrast}.spec.ts`, `test/fixtures/acme/golden/index.html` (generated once via `UPDATE_GOLDEN=1` after WP6, reviewed) | T24-T27, T61, T62 |
| TP6 guards | `test/{workspace-wiring,railway-isolation,workflow-triggers,rule-text,stop-gates-unaffected,hooks-wiring,no-client-data}.spec.ts` | T5, T35, T36, T56, T57, T59, T60 |
| TP7 ui | `apps/web/e2e/control/control.capture.spec.ts`, `apps/web/playwright.control.config.ts` | T30 |

**Red gate:** `npm test -w apps/control -- --testPathPattern 'test/'` — every spec's first
assertion is "module defined" (guarded dynamic import), so all fail on assertions; T36/T57/T59
excluded by `--testPathIgnorePatterns 'stop-gates|workflow-triggers|no-client-data'` for the
red run only.

---

## Work packages

### WP0 — workspace + deploy scaffold
- **files (new):** `apps/control/package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `eslint.config.mjs`, `Dockerfile`, `railway.toml`, `README.md`, `src/main.ts` (boot stub),
  `bin/ctl.mjs` (launcher), `.claude/control/README.md`; **edits:** root `package.json` (add
  `"control": "node apps/control/bin/ctl.mjs serve"`, `"ctl": "node apps/control/bin/ctl.mjs"`),
  `.gitignore` (add `local-assets/control/` is already covered by `local-assets/`; add
  `.claude/control/.lane`)
- **satisfies:** R2, R27 · **provenBy:** T5, T56 · **effort:** low · **model:** Haiku `low` (mechanics)
- **brief:** package `@routeflow/control`, `"private": true`, scripts `build: tsc -p
  tsconfig.build.json`, `start: node dist/main.js`, `dev: node --watch dist/main.js`, `test: jest`,
  `lint: eslint "src/**/*.ts"`, `check-types: tsc --noEmit -p tsconfig.json`; devDeps `jest`,
  `ts-jest`, `@types/node`, `typescript`, `eslint` family exactly as api pins them (copy versions
  from `apps/api/package.json`); **no dependencies** at all. Dockerfile: copy api's two stages,
  replace workspace paths with `apps/control`, drop every `packages/*` COPY, add `RUN apk add
  --no-cache git openssh-client`, `CMD ["node","dist/main.js"]`; `railway.toml`:
  `watchPatterns = ["apps/control/**"]`, `healthcheckPath = "/api/health?public=1"` (unauth'd
  200 `{ok:true}` only — no data). Launcher `bin/ctl.mjs`: if `dist/cli/ctl.js` is missing or
  older than the newest `src/**` mtime, run `npx tsc -p apps/control/tsconfig.build.json` (stdio
  inherit), then `import()` it and call `main(process.argv.slice(2))`.

### WP1 — schema, validator, transitions, fold
- **files (new):** `apps/control/src/domain/{schema.ts,transitions.ts,validate.ts,fold.ts,types.ts}`
- **satisfies:** R1, R4, R5 · **provenBy:** T1-T4, T8-T11 · **dependsOn:** WP0 · **model:** Sonnet `high`
- **exact code — transition table and total order:**
```ts
// transitions.ts — the §2 matrix as data; the test carries its own copy (never import this into the spec)
export type Status = "proposed"|"planned"|"in-progress"|"blocked"|"code-complete"|"released"|"reconsider"|"dropped";
type Ev = "started"|"done"|"released"|"blocked"|"unblocked"|"reconsider"|"reopened"|"dropped";
const M: Record<Status, Partial<Record<Ev, Status | "prior">>> = {
  proposed:        { reconsider: "reconsider", dropped: "dropped" },
  planned:         { started: "in-progress", released: "released", blocked: "blocked", reconsider: "reconsider", dropped: "dropped" },
  "in-progress":   { started: "in-progress", done: "code-complete", released: "released", blocked: "blocked", reconsider: "reconsider", reopened: "planned", dropped: "dropped" },
  blocked:         { blocked: "blocked", unblocked: "prior", reconsider: "reconsider", reopened: "planned", dropped: "dropped" },
  "code-complete": { done: "code-complete", released: "released", reconsider: "reconsider", reopened: "planned", dropped: "dropped" },
  released:        { reopened: "planned" },
  reconsider:      { reopened: "planned", dropped: "dropped" },
  dropped:         {},
};
export function transition(from: Status, ev: Ev, prior?: Status): Status | null {
  const to = M[from][ev]; if (!to) return null; return to === "prior" ? (prior ?? "planned") : to;
}
// `released` via `started`/`planned` rows is legal ONLY for by:"infer"|"sync"|"server" events (fold checks `by`).

// fold.ts — total order (§4)
const rank = (by: string) => (by === "sync" || by === "server" || by === "infer" ? 1 : 0);
export const eventOrder = (a: Ev, b: Ev) =>
  a.ts.localeCompare(b.ts) || rank(a.by) - rank(b.by) || a.lane.localeCompare(b.lane) || a.seq - b.seq;
```
  Validator returns `{file, line, reason}[]`; per-type payload schemas are a literal table
  (`REQUIRED: Record<type, string[]>`, `OPTIONAL`, `EMITTERS: Record<type, LaneKind[]>`); a
  line > 1,024 B, an extra key, `seq !== prev + 1` (except the `segment` header), `ts < prevTs`,
  `lane !== fileLane`, `..`/`\` in any glob → error. `fold()` never throws on identified data;
  it pushes `warnings`. Every derived field is `{value, source, ref}`.

### WP2 — next, overlap, piggyback, release readiness
- **files (new):** `src/domain/{glob.ts,next.ts,overlap.ts,piggyback.ts,releases.ts}`
- **satisfies:** R6, R7, R8 (+ R13's readiness numbers) · **provenBy:** T12-T17 · **dependsOn:** WP1 · **model:** Sonnet `high`
- **exact code — glob and overlap:**
```ts
// glob.ts
export function globToRegex(glob: string): RegExp {
  if (/(^|\/)\.\.(\/|$)|\\/.test(glob)) throw new Error(`unsafe glob: ${glob}`);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // a bare directory prefix (no wildcard, not a file) matches everything under it
  if (!/[*?]/.test(glob) && !/\.[A-Za-z0-9]+$/.test(glob)) re += "(/.*)?";
  return new RegExp(`^${re}$`);
}
export const expand = (globs: string[], files: string[]) => {
  const res = globs.map(globToRegex); return new Set(files.filter((f) => res.some((r) => r.test(f))));
};
// overlap.ts
export function overlap(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return { shared: 0, coef: 0, level: "none" as const, paths: [] as string[] };
  const paths = [...a].filter((p) => b.has(p)).sort();
  const shared = paths.length, coef = shared / Math.min(a.size, b.size);
  const level = shared >= 3 && coef >= 0.5 ? "HOT" : shared >= 1 && coef >= 0.25 ? "WARN" : "none";
  return { shared, coef, level, paths };
}
```
  `nextEligible` sort key = `[PRIO[p], shipDateOrMax, IMPACT[c], EFFORT[e], -importance, natural(id)]`
  (natural: split `RF-` and compare numerically). Piggyback per spec §5.2 with `sensitive` last.
  `releases.ts` implements §5.9 with `AT_RISK_DUE_SOON_DAYS = 3`, `OPEN_RATIO = 0.25`.

### WP3 — git source, state branch push loop, denylist, compaction
- **files (new):** `src/sources/{git.ts,state-branch.ts,denylist.ts,compact.ts,lock.ts}`
- **satisfies:** R9 (append/push part), R11, R26, R29, R32 · **provenBy:** T18, T20, T23, T55, T58 · **dependsOn:** WP1 · **risk:** HIGH (data integrity; public-window exposure) · **model:** Sonnet `high`, review Opus `high`
- **exact code — append-and-push:**
```ts
// state-branch.ts
export async function appendAndPush(env: Env, lane: string, draft: Omit<Event, "seq" | "ts" | "lane">, mint?: (state: State) => string) {
  const clone = await ensureClone(env);                       // clone --single-branch --branch <state> --depth 50
  return withLock(join(clone, ".ctl.lock"), 30_000, async () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      git(clone, ["fetch", "--depth", "50", "origin", env.stateBranch]);
      git(clone, ["reset", "--hard", `origin/${env.stateBranch}`]);   // never merge, never stash
      const file = join(clone, "events", `${lane}.jsonl`);
      const prev = lastSeq(file);                                   // 0 when absent
      const state = foldDir(clone, env.registers);                  // snapshot + segments
      const ev: Event = { seq: prev + 1, ts: env.now(), lane, ...draft, ...(mint ? { id: mint(state) } : {}) };
      const line = JSON.stringify(ev);
      if (Buffer.byteLength(line) > 1024) throw new CtlError(3, "event line > 1024 bytes");
      const hit = denylistHit(line); if (hit) throw new CtlError(4, `refused: ${hit}`);
      const err = validateAgainst(state, ev); if (err) throw new CtlError(3, err);
      appendFileSync(file, line + "\n");
      git(clone, ["add", "-A"]);
      git(clone, ["-c", "user.name=ctl", "-c", "user.email=ctl@routeflow.local", "commit", "-q", "-m", `ctl(${lane}): #${ev.seq} ${ev.type} ${ev.task ?? ""}`.trim()]);
      const push = gitTry(clone, ["push", "-q", "origin", `HEAD:${env.stateBranch}`]);
      if (push.ok) return ev;
      if (!/non-fast-forward|fetch first|rejected/.test(push.err)) throw new CtlError(5, push.err);
      await sleep(500 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
    }
    park(clone, lane, draft); throw new CtlError(5, "push exhausted; event parked in pending/");
  });
}
```
  `lock.ts`: `mkdirSync(lockDir)` loop, stale if `mtime` older than 30 s (remove and retry), holder
  pid file inside, released in `finally` and on `exit`/`SIGINT` (copy the shape of `acquireLock` in
  `bugs.mjs:2029-2152`, not the code). `denylist.ts` loads
  `scripts/campaign/plane-denylist.json` at runtime (path from env `CONTROL_DENYLIST`, default
  the repo copy; in Docker the file is `COPY`'d) and adds `/https?:\/\//`. `compact.ts` per spec §8.
  `git.ts`: `execFileSync("git", args, { cwd, env: { ...process.env, GIT_SSH_COMMAND, GIT_TERMINAL_PROMPT: "0" } })`
  — **arguments always an array, never a shell string**; every id passed in is re-validated by
  regex before it reaches an arg (R17).

### WP4 — register adapters
- **files (new):** `src/domain/adapters.ts`, `src/sources/registers.ts`
- **satisfies:** R3, R14 (source tags) · **provenBy:** T6, T7, T27 (data side) · **dependsOn:** WP1 · **model:** Sonnet `medium`
- **brief:** read `.claude/roadmap/{features,deferred,releases}.jsonl`, `.claude/campaign/bugs.jsonl`,
  `.claude/campaign/status/*.jsonl` from the master clone (`git show origin/master:<path>` via
  `git.ts`, cached by master sha) or from `CONTROL_FIXTURE`. Own 12-line `loadJsonl` (do **not**
  import `scripts/roadmap/render.mjs` — it would drag `plane-client.mjs` into the Docker context;
  deviation from discovery §10 "extend by import", accepted). Mapping per spec §2/§3; the
  `location` path-token regex verbatim from spec §3. Never write.

### WP5 — GitHub + Railway sources, PR ledger, reconciliation, waste
- **files (new):** `src/sources/{github.ts,railway.ts,poller.ts}`, `src/domain/{prs.ts,reconcile.ts,waste.ts,trailers.ts}`
- **satisfies:** R22, R23, R24 (budget/backoff; webhook handler is WP7) · **provenBy:** T42-T52 · **dependsOn:** WP1, WP2, WP4 · **risk:** HIGH (silent mis-advance of status; false waste) · **model:** Sonnet `high`, review Opus `high`
- **exact code — W5 re-landed check and link precedence:**
```ts
// waste.ts (W5): closed-unmerged PR whose work never reached master
export function relanded(g: Git, base: string, head: string, master = "origin/master"): boolean {
  const ids = new Set(g.lines(["log", "--format=%H", `${base}..${head}`]).map((h) => g.patchId(h)));
  const onMaster = new Set(g.lines(["log", "--format=%H", "-n", "2000", master]).map((h) => g.patchId(h)));
  if ([...ids].some((id) => onMaster.has(id))) return true;          // cherry-picked
  const rangeId = g.patchIdOfDiff(base, head);                          // squash of the whole range
  return onMaster.has(rangeId);
}
// trailers.ts — precedence (§5.4)
const TRAILER = /^(Task|Bug|Feature|Defers|Lane|Closes):\s*(#?[A-Za-z0-9.-]+)\s*$/gm;
export function links(body: string, branch: string) {
  const out: Links = { task: null, bug: null, feature: null, defers: null, lane: null, issue: null };
  for (const m of body.matchAll(TRAILER)) { /* fill by key; first wins */ }
  if (!out.task)    out.task    = branch.match(/\bRF-\d+\b/)?.[0] ?? null;
  if (!out.bug)     out.bug     = branch.match(/\bB\d{1,4}\b/)?.[0] ?? null;
  if (!out.feature) out.feature = branch.match(/\bF-\d+\b/)?.[0] ?? null;
  return out;
}
```
  `github.ts`: GraphQL over `fetch` with the two queries of spec §5.6 (cheap list / per-PR
  detail), REST branches with `If-None-Match`, `rateLimit{remaining,resetAt,cost}` read on every
  response, back-off table `{1500: 60_000, 500: 300_000}`. `poller.ts`: 30 s tick, master fetch
  every 5th tick, Railway every 2nd, relax to 5 min while the webhook is fresh (< 10 min).
  `railway.ts`: A14 probe wrapped so failure → `deployed: unknown` with a source warning, and
  fallback to GitHub deployments (`deployment_status` Railway posts, E45 comment).
  `reconcile.ts` implements §5.7 as one table `FIELD_WINNER`. `prs.ts` appends ledger rows only on
  field change (compare to last row per PR).

### WP6 — renderer, client, styles
- **files (new):** `src/render/{page.ts,panels.ts,esc.ts}`, `src/render/assets/{client.js,styles.css}`
- **satisfies:** R12, R13, R14 (render side), R18 (client side), R33, R34 · **provenBy:** T24-T27, T61, T62, T30 · **dependsOn:** WP2, WP5 · **model:** Sonnet `high`
- **brief:** `renderPage(state, opts)` returns one HTML string; panels in ux-spec §3 order;
  tables as `<table>` with `scope`; `esc()` for every interpolation (T25); `<meta
  name="control-version">`; inline `<script src="/assets/client.js">` and `<link
  href="/assets/styles.css">` (same origin, CSP-safe; no inline handlers). `client.js` (vanilla,
  ≤ 400 lines): `EventSource("/api/stream")` → on `version` refetch `/api/state.json` (ETag) →
  re-render panels by replacing `innerHTML` of `[data-panel]` from the server-rendered fragments
  in `/api/state.json.fragments` (renderer emits fragments too, so the client never templates);
  write-back `fetch("/api/event", {headers: {"X-Control-Token": token}, body})` with
  `expectedVersion`; pending/failed/conflict states per ux-spec §5-6; toast with Undo posting the
  compensating event; drawer with focus trap; section jump list; `?` legend. `styles.css`: the
  ux-spec §1 tokens as `:root` vars + `@media (prefers-color-scheme: dark)`; grid breakpoints
  1400/900/480; `prefers-reduced-motion`.

### WP7 — HTTP server, auth, SSE, webhook, main
- **files (new):** `src/http/{server.ts,auth.ts,csrf.ts,sse.ts,ratelimit.ts,headers.ts,routes.ts}`, `src/main.ts` (replaces WP0's stub — WP0 owns only its creation; WP7 owns its final body), `src/config.ts`
- **satisfies:** R15, R16, R17, R21, R24 (webhook), R25 · **provenBy:** T28, T29, T31-T34, T38-T41, T53, T54 · **dependsOn:** WP3, WP5, WP6 · **risk:** HIGH (internet-facing write path) · **model:** Sonnet `high`, review Opus `high`
- **exact code — cookie and CSRF:**
```ts
// auth.ts
import { createHmac, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
const b64 = (b: Buffer) => b.toString("base64url");
export function hashPassword(pw: string, salt = randomBytes(16)) { return { salt, hash: scryptSync(pw, salt, 32) }; }
export function verifyPassword(pw: string, h: { salt: Buffer; hash: Buffer }) {
  const c = scryptSync(pw, h.salt, 32); return c.length === h.hash.length && timingSafeEqual(c, h.hash);
}
export function signSession(secret: string, now: number) {
  const payload = b64(Buffer.from(JSON.stringify({ iat: now, exp: now + 12 * 3600_000, nonce: b64(randomBytes(8)) })));
  return `${payload}.${b64(createHmac("sha256", secret).update(payload).digest())}`;
}
export function readSession(secret: string, cookie: string | undefined, now: number) {
  const [payload, sig] = (cookie ?? "").split("."); if (!payload || !sig) return null;
  const want = b64(createHmac("sha256", secret).update(payload).digest());
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const s = JSON.parse(Buffer.from(payload, "base64url").toString()); return s.exp > now ? s : null;
}
export const COOKIE = (v: string, secure: boolean) =>
  `ctl_session=${v}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/; Max-Age=43200`;
// csrf.ts — token derived from the session nonce, embedded in the page, required on every POST
export const csrfFor = (secret: string, nonce: string) => b64(createHmac("sha256", secret).update(`csrf:${nonce}`).digest());
export function checkWrite(req, session, servedOrigin, secret) {
  if (!session) return 401;
  if (req.headers.origin !== servedOrigin) return 403;
  if (req.headers["x-control-token"] !== csrfFor(secret, session.nonce)) return 403;
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return 415;
  return 0;
}
```
  `ratelimit.ts`: in-memory map ip → timestamps (15 min window, 5) + global (30); 429 with a
  2 s `setTimeout` before responding. `headers.ts`: the exact header set of spec §6 on every
  response. `routes.ts`: exact-match routing on `url.pathname` (no regex params); unknown → 404.
  `server.ts`: `http.createServer`, body reader with a 16 KB cap (destroy on overflow → 413),
  `POST /api/event` → `checkWrite` → JSON parse → type ∈ OWNER_TYPES → `validateAgainst(state)`
  → `expectedVersion === state.version` else 409 → `appendAndPush(env, "owner", …)` → refold →
  `sse.broadcast("version")`. `GET /api/health`: auth'd full report; `?public=1` → `{ok:true}` only
  (Railway healthcheck). `main.ts`: `loadConfig()` (exit 1 naming any missing var unless
  `CONTROL_LOCAL=1`), write the deploy key from `CONTROL_DEPLOY_KEY_B64` to a `0600` temp file
  for `GIT_SSH_COMMAND`, start poller, listen (`127.0.0.1` local / `0.0.0.0` otherwise), SIGTERM →
  close SSE, stop poller, `server.close()`, exit 0.

### WP8 — the `ctl` CLI
- **files (new):** `src/cli/{ctl.ts,commands.ts,format.ts}` (+ WP0's `bin/ctl.mjs` is owned by WP0)
- **satisfies:** R9 (commands), R10, R20, R35, R31's `ctl handoff`/`sync` verbs · **provenBy:** T11, T18-T22, T37, T63 · **dependsOn:** WP2, WP3, WP4 · **model:** Sonnet `high`
- **brief:** commands per spec §7; lane resolution `--lane` > `CTL_LANE` > `.claude/control/.lane`;
  `next` output format (≤ 30 lines / 1,536 B, `format.ts` truncates titles to 48 chars and caps
  each list); `bug` shells to `node scripts/campaign/bugs.mjs file …` with the arguments passed
  through (array form) and parses `filed B\d+`; `sync --since <sha>` = `git log --first-parent
  --format=%H%n%B%x00 <sha>..origin/master` → `links()` → `task.released`/`bug.fixed` events not
  already present (idempotent by `(type, task|bug, sha)`); `pr-body <task>` prints
  `Task: RF-n\nLane: <lane>\n` (+ `Bug:`/`Feature:` from `ref`); exit codes 2/3/4/5 per spec R9;
  `serve` subcommand = `main.ts` with `CONTROL_LOCAL=1` (so `npm run control` needs no second entry).

### WP9 — rule text and hooks wiring
- **files (edit):** `CLAUDE.md`, `.claude/roadmap/README.md`, `.claude/commands/orient.md`,
  `.claude/commands/handoff.md`, `.claude/settings.json`, `.claude/skills/dev-pipeline/scripts/closeout.mjs`
  (add `--task <id>` → spawn `npm run ctl -- done <id> --pr <n>` after the handoff card; swallow
  failure with a printed MANUAL line); `.claude/control/README.md` is WP0's — WP9 fills its body
  (WP0 creates it with a one-line stub; WP9 depends on WP0)
- **satisfies:** R19, R31 · **provenBy:** T35, T60 · **dependsOn:** WP0, WP8 · **effort:** low · **model:** Haiku `low`
- **brief:** paste spec §8 paragraphs **verbatim**; orient step 9: "If `apps/control/bin/ctl.mjs`
  exists, run `npm run ctl -- next --lane $CTL_LANE` (or `--lane <your lane>`) and print it
  verbatim (≤ 30 lines)"; handoff template line `- Control: <lane> · current <id> · next <id>
  (from \`npm run ctl -- next\`)` + final step "run `npm run ctl -- handoff --card <path>`";
  settings SessionStart adds `{ "type": "command", "command": "node apps/control/bin/ctl.mjs next --quiet" }`
  (exit 0 always, prints nothing when no lane is configured).

### UI1 — ui-verify (T30)
- **type:** `ui-verify` · **dependsOn:** WP7, TP7 · **url:** `http://127.0.0.1:4317/` ·
  **startCommand:** `npm run build -w apps/control && CONTROL_LOCAL=1 CONTROL_FIXTURE=apps/control/test/fixtures/acme node apps/control/dist/main.js` ·
  **flows/viewports/checks:** test-plan §8 · run: `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4317 SKIP_E2E_SEED=true npx playwright test -c playwright.control.config.ts` from `apps/web`
  (config copies `playwright.native-parity.config.ts`'s shape — A8 probe first: `git ls-tree origin/master apps/web | grep playwright`).
  Before capturing, run the dataviz validator on the severity/status palette:
  `node "<dataviz skill dir>/scripts/validate_palette.js" "#B42318,#A4400B,#8A6100,#5C6B7A" --mode light` (and dark) — a FAIL re-steps the fg in `styles.css` (WP6 owner).

### Package map

| WP | satisfies | provenBy | dependsOn | wave | model / effort | risk |
|---|---|---|---|---|---|---|
| WP0 | R2, R27 | T5, T56 | — | 1 | Haiku low | — |
| WP1 | R1, R4, R5 | T1-T4, T8-T11 | WP0 | 2 | Sonnet high | — |
| WP4 | R3, R14 | T6, T7, T27 | WP1 | 3 | Sonnet medium | — |
| WP2 | R6, R7, R8 | T12-T17 | WP1 | 3 | Sonnet high | — |
| WP3 | R9, R11, R26, R29, R32 | T18, T20, T23, T55, T58 | WP1 | 3 | Sonnet high + Opus review | HIGH |
| WP5 | R22, R23, R24 | T42-T52 | WP1, WP2, WP4 | 4 | Sonnet high + Opus review | HIGH |
| WP8 | R9, R10, R20, R35 | T11, T18-T22, T37, T63 | WP2, WP3, WP4 | 4 | Sonnet high | — |
| WP6 | R12, R13, R18, R33, R34 | T24-T27, T61, T62 | WP2, WP5 | 5 | Sonnet high | — |
| WP7 | R15, R16, R17, R21, R24, R25 | T28-T34, T38-T41, T53, T54 | WP3, WP5, WP6 | 6 | Sonnet high + Opus review | HIGH |
| WP9 | R19, R31 | T35, T60 | WP0, WP8 | 5 | Haiku low | — |
| UI1 | R13, R18, R33, R34 | T30 | WP7, TP7 | 7 | Sonnet high (driver) | — |

**Derivation checks**

| Check | Result | Note |
|---|---|---|
| 1 — every package proves ≥ 1 test | pass | — |
| 2 — every test claimed | pass (T36, T57, T59 → TP6 guards, claimed by WP0/WP9 as pins; T64 manual, claimed by the runbook below) | pins are excluded from the red gate by name |
| 3 — every requirement satisfied or fenced | pass | R28 is proven by T57 (pin) and satisfied by *not* editing workflows (WP scope fence) — recorded here rather than in a package |

---

## Acceptance criteria

1. `R9/R20` — `npm run ctl -- done RF-1` (lane configured) prints one line ≤ 200 B, exits 0, and the remote `ctl/state` gains exactly one line with `seq = last+1`.
2. `R10` — `npm run ctl -- next --lane lane-u` ≤ 30 lines and ≤ 1,536 B on the acme fixture and on the real branch.
3. `R16/R21` — a `POST /api/event` without the session cookie, with a foreign `Origin`, or with a wrong token is rejected with the stated code and appends nothing (verified by the remote tip).
4. `R22` — merging a fixture PR that carries `Task: RF-2` shows RF-2 `code-complete · inferred from #7` with no event written.
5. `R23` — the acme fixture shows exactly the expected waste items (one per rule) and `waste.ack` hides one.
6. `R27/R28` — `railway.toml` watch pattern is `apps/control/**` only; no workflow has a `push` trigger.
7. `R3` — after a full server run in local mode, `git status` on the registers is clean.
8. `R29` — an event containing an email or a uuid-shaped tenant id is refused and never pushed.
9. Deploy day — first boot with real env: `/api/health` green for master, state, GitHub, Railway (T64, owner runbook).

---

## Verification commands (all exist on master or are created by WP0)

Per round:
```bash
npm run check-types -w apps/control
npm run lint -w apps/control
npm test -w apps/control
```
Final:
```bash
npm run verify            # root chain incl. verify-turbo (scoped to apps/control on a branch)
npm run build -w apps/control
docker build -f apps/control/Dockerfile .    # A20; local only, not in CI
```

---

## Risks & rollback

| Risk | L | Blast | Mitigation / reviewer watch |
|---|---|---|---|
| Write path abused from the internet | low | events branch polluted (public window) | cookie+Origin+token+type allow-list+denylist; Opus review of WP7; no data beyond ids/notes ever accepted |
| Inference mis-advances a task | med | owner acts on a wrong status | reported wins for decisions (§5.7); every inferred value badged; T44-T47 |
| Waste false positives → panel ignored | med | the panel dies | thresholds tested at ±1; `waste.ack`; per-rule counts on the panel so noise is visible |
| GitHub rate limit exhausted | low | stale PR data | back-off + health chip + webhook |
| `ctl` push storms during landing windows | low | retries | 6 attempts, ≤ 16 s total, parked pending file |
| Railway service cost drift | low | $ | A16; owner reads usage after a week |
| Public window exposes `ctl/state` | certain, brief | ids/titles/notes readable | denylist on every line; notes ≤ 80 chars; no PR bodies stored; PR titles are already public then |

- **Rollback:** revert the PR; delete the Railway service; leave `ctl/state` (inert data) or
  delete the branch. No migration, no flag.
- **Deploy day:** nothing changes for api/web (R27, T56); lanes keep working without `ctl`
  until their next session reads the CLAUDE.md section.
- **Observability:** `/api/health`, server logs (no secrets), the footer sources bar.

---

## Critique (stage P8)

**C1 — Strongest objection.** *"You now have a Railway service, a git branch as a database, a
poller, a webhook, an auth layer and a CLI — for one owner. This is a platform, not a slice."*
**Answer:** each piece is the cheapest thing that satisfies a ruling the owner made explicitly
(A: hosted+private → auth; B: push-only state → branch+push loop; C: infer → poller). What the
plan refuses: no DB (git is the ledger), no framework, no React, no queue, no second service,
no Actions. The domain core (WP1/2/4/5) is pure functions with fixtures and would survive a
later change of host or transport unchanged. Size is ~3.5k lines of TS incl. tests; the fleet
spends more than that per week on coordination prose.

**C2 — Pre-mortem (six months on).**
- *Lanes stopped running `ctl`; the board showed last week's "current".* Allowed by: relying on
  reported events for `current`. **Changed:** heartbeat from pushes (§5.7 row 5) makes silence
  visible within 24 h; `ctl next` is the session's first command by CLAUDE.md rule, and the
  SessionStart hook prints it, so a lane cannot orient without touching the system.
- *Stale data looked fresh.* Allowed by: no per-source timestamps. **Changed:** footer sources bar
  with 2/10-minute amber/red, `⟳ old` badges on inferred chips (ux-spec §5).
- *Overlap false positives (every lane touches `orders.service.ts`) made the owner ignore
  warnings.* Allowed by: shared-count-only scoring. **Changed:** overlap coefficient + counts,
  real diffs first, HOT needs ≥ 3 files; the panel shows paths so the owner can see "it's the
  giant file again" — and R7 stays *warn, never prohibit*.
- *Plane, the GitHub board and control disagreed; nobody knew which to trust.* **Changed:**
  precedence table (§5.7) + source badges; Plane/board are explicitly *not* sources in slice 1
  (Q4), and the README says which wins.
- *Windows/Mac glob mismatch.* **Changed:** globs are forward-slash only (validator), files from
  `git ls-files` (always `/`), no `path.join` on globs.
- *An owner write clobbered a lane's concurrent push.* **Changed:** per-lane files; owner writes
  only `events/owner.jsonl`; push loop rebases on the tip.
- *Rendering 561 KB of bugs on every tick was slow.* **Changed:** registers cached by master sha
  (refetched every 5th tick), fold is incremental per version; A10 probe.
- *The public CI window leaked something via `ctl/state`.* **Changed:** denylist on every line,
  no bodies, no URLs, notes capped; R29/T58.
- *The deploy key or PAT leaked in a log.* **Changed:** config never logged; health shows booleans;
  key written to a `0600` temp file; Opus review lens "secrets in output".
- *Login brute-forced during a public window.* **Changed:** rate limit + 12 h sessions + scrypt;
  the password is one env var the owner can rotate in Railway in a minute.

**C3 — Riskiest assumption and the experiment.**

| Riskiest | Cost if wrong | Cheapest test | Before building? |
|---|---|---|---|
| A11 — Railway services are branch-bound to master, so `ctl/state` pushes deploy nothing | api/web rebuilds on every lane event (minutes of build, possible mid-window regressions) | owner opens each service → Settings → Source: branch = master (1 min); or push one empty commit to a throwaway branch and watch | **yes — Q8, before WP3 is merged** |
| A12 — token scopes | server cannot push write-back | first live boot `/api/health` | at WP7 |
| A17 — patch-id adequacy | W5 false positives | T49 fixture | in TP2 |

**C4 — Most expensive requirement to get wrong.** `R22` (inference/reconciliation): every panel
above the fold reads its numbers. Confirmed before WP5 by the recorded fixture `prs.json`
(TP4) whose expected ledger rows are hand-written, and by the six-row §5.7 table each having a
test.

**C5 — What the plan forgot (walked).**

| Class | Missing? | Now covered |
|---|---|---|
| Callers/mirrors | `render.mjs` stays; `bugs.mjs render` untouched; `from-git.mjs` logic duplicated in TS (15 lines) — accepted, noted in WP8 | WP8 |
| Migrations/backfills | none (no DB); PR-ledger backfill once at first boot | WP5 |
| Permissions/boundary | single owner; emitter rules per event type; local mode loopback only | WP1, WP7 |
| Unspecified states | logged-out, rate-limited, SSE dropped, local mode added | ux-spec §5 |
| Reverse of every action | undo = compensating event; `task.reopened`; `waste.ack` has `until`; `pr.superseded` reversible by a new event; compaction reversible by reading `ctl/archive` | spec §1.3 |
| Existing data on deploy day | registers untouched; `ctl/state` starts empty except `lane.registered` seed events (WP9 runbook) | WP9 |
| Docs/code-map/lessons | code-map entries for `apps/control` + this run's lesson in the Option B follow-up PR | landing coordinator |
| **Forgotten and added:** the first `lane.registered` seed — who runs it | the owner runbook: `npm run ctl -- lane register …` ×9 from the lead machine, or `ctl seed --from-fixture lanes.json` | WP8 (`seed` verb) |
| **Forgotten and added:** `apps/control` in the code map + `verify-scope` "feeds every workspace" list | check `scripts/lib/verify-scope.mjs` at WP0 (A18-adjacent) | WP0 |

**C6 — Untestable as written.** `R13`'s "in seconds" was rewritten into panel presence (T26/T30)
and the header rule (≤ 1 colored word); `R20`'s "tokens" into byte caps (T18/T21). None remain.

**Revisions made by this critique:** heartbeat-from-push; sources bar thresholds; overlap
coefficient + paths; precedence table; forward-slash validator; owner-only file; registers
cache; denylist on every line; `seed` verb + runbook; verify-scope check in WP0.
**Verdict:** `REVISED — 10 edits`.

---

## Stage log

| Stage | Ran? | Stop condition | Fired? | Note |
|---|---|---|---|---|
| P0 Frame | yes | trivial | no | major, ui:true; owner rounds 2-3 folded in |
| P1 Ground | yes | nothing verifiable | no | 59 evidence rows, 20 assumptions |
| P2 Interview | yes (batched) | severe unanswered | no — defaults carried (Q1-Q10) | planner cannot ask; list in the final report |
| P3 Discovery | yes | no measurable signal | no | 6 signals |
| P4 Spec | yes | intent-only requirement | no | 35 requirements |
| P5 UX | yes | unjustified token/component | no | 2 new severity pairs, justified + T62-gated; design-critique verdict REVISED-6 |
| P6 Test plan | yes | untestable requirement | no | 64 tests (3 pins, 1 manual) |
| P7 Build plan | yes | derivation check failed | no | 10 WPs + UI1 |
| P8 Critique | yes | unanswered failure mode | no | 10 revisions |

---

## Pipeline args (P9)

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-30-control-system/build-plan.md',
  discoveryPath: '.claude/pipeline/2026-09-30-control-system/discovery.md',
  specPath: '.claude/pipeline/2026-09-30-control-system/spec.md',
  uxSpecPath: '.claude/pipeline/2026-09-30-control-system/ux-spec.md',
  testPlanPath: '.claude/pipeline/2026-09-30-control-system/test-plan.md',
  designSystemPath: '.claude/pipeline/design-system.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '<ISO at launch>',
  runDir: '.claude/pipeline/2026-09-30-control-system',
  scale: 'major', mode: 'feature', profile: 'standard',
  workdir: '<fresh worktree off origin/master, e.g. .claude/worktrees/control-system>',
  context: 'apps/control: private Railway dashboard + ctl CLI over a ctl/state event branch; zero-token inference from GitHub/Railway',
  formatCommand: 'npx prettier --write apps/control .claude/control CLAUDE.md .claude/roadmap/README.md .claude/commands',
  tasks: [
    { id: 'WP0', title: 'workspace + deploy scaffold', files: ['apps/control/package.json','apps/control/tsconfig.json','apps/control/tsconfig.build.json','apps/control/eslint.config.mjs','apps/control/Dockerfile','apps/control/railway.toml','apps/control/README.md','apps/control/bin/ctl.mjs','apps/control/src/main.ts','.claude/control/README.md','package.json','.gitignore'],
      tests: ['apps/control/test/workspace-wiring.spec.ts','apps/control/test/railway-isolation.spec.ts','apps/control/test/workflow-triggers.spec.ts','apps/control/test/no-client-data.spec.ts'],
      brief: 'satisfies R2,R27; provenBy T5,T56,T57(pin),T59(pin). Copy api tsconfig/eslint/jest shapes (E47/E56-E58); no dependencies; Dockerfile per WP0 brief; railway watchPatterns apps/control/** only; root scripts control + ctl; launcher auto-builds. Probe A18/A19/A20 and verify-scope first.', dependsOn: [], model: 'claude-haiku-4-5', effort: 'low' },
    { id: 'WP1', title: 'schema, validator, transitions, fold', files: ['apps/control/src/domain/schema.ts','apps/control/src/domain/transitions.ts','apps/control/src/domain/validate.ts','apps/control/src/domain/fold.ts','apps/control/src/domain/types.ts'],
      tests: ['apps/control/test/validate.spec.ts','apps/control/test/transitions.spec.ts','apps/control/test/fold.spec.ts','apps/control/test/helpers/clock.ts','apps/control/test/fixtures/acme/registers/features.jsonl','apps/control/test/fixtures/acme/registers/deferred.jsonl','apps/control/test/fixtures/acme/registers/releases.jsonl','apps/control/test/fixtures/acme/registers/bugs.jsonl','apps/control/test/fixtures/acme/state/events/lead.jsonl','apps/control/test/fixtures/acme/state/events/lane-u.jsonl','apps/control/test/fixtures/acme/state/events/r-ui.jsonl','apps/control/test/fixtures/acme/state/events/lane-b.jsonl','apps/control/test/fixtures/acme/state/events/owner.jsonl'],
      brief: 'satisfies R1,R4,R5; provenBy T1-T4,T8-T11. Transition matrix + eventOrder exactly as in build-plan WP1; payload tables; warnings never throws; {value,source,ref} on derived fields. Fixture data synthetic (acme).', dependsOn: ['WP0'], model: 'claude-sonnet-5', effort: 'high' },
    { id: 'WP4', title: 'register adapters', files: ['apps/control/src/domain/adapters.ts','apps/control/src/sources/registers.ts'],
      tests: ['apps/control/test/adapters.spec.ts','apps/control/test/registers-untouched.spec.ts'],
      brief: 'satisfies R3,R14; provenBy T6,T7,T27. Own loadJsonl; mapping per spec §2/§3; location-path regex verbatim; never write; cache by master sha.', dependsOn: ['WP1'], model: 'claude-sonnet-5', effort: 'medium' },
    { id: 'WP2', title: 'next, overlap, piggyback, readiness', files: ['apps/control/src/domain/glob.ts','apps/control/src/domain/next.ts','apps/control/src/domain/overlap.ts','apps/control/src/domain/piggyback.ts','apps/control/src/domain/releases.ts'],
      tests: ['apps/control/test/next.spec.ts','apps/control/test/overlap.spec.ts','apps/control/test/piggyback.spec.ts','apps/control/test/releases.spec.ts'],
      brief: 'satisfies R6,R7,R8; provenBy T12-T17. globToRegex/expand/overlap verbatim from build-plan WP2; T12 expected order [RF-7,RF-2,RF-5,RF-9,RF-1]; sensitive last; readiness thresholds 3 d / 0.25.', dependsOn: ['WP1'], model: 'claude-sonnet-5', effort: 'high' },
    { id: 'WP3', title: 'git source, state-branch push loop, denylist, compaction', files: ['apps/control/src/sources/git.ts','apps/control/src/sources/state-branch.ts','apps/control/src/sources/denylist.ts','apps/control/src/sources/compact.ts','apps/control/src/sources/lock.ts'],
      tests: ['apps/control/test/cli-concurrency.spec.ts','apps/control/test/denylist.spec.ts','apps/control/test/compact.spec.ts','apps/control/test/helpers/temp-repo.ts'],
      brief: 'satisfies R9(append/push),R11,R26,R29,R32; provenBy T18,T20,T23,T55,T58. appendAndPush verbatim from build-plan WP3; git args always arrays; lock dir stale 30 s; denylist from plane-denylist.json + URL; compaction to ctl/archive with segment header.', dependsOn: ['WP1'], risk: 'HIGH', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'WP5', title: 'GitHub/Railway sources, PR ledger, reconcile, waste', files: ['apps/control/src/sources/github.ts','apps/control/src/sources/railway.ts','apps/control/src/sources/poller.ts','apps/control/src/domain/prs.ts','apps/control/src/domain/reconcile.ts','apps/control/src/domain/waste.ts','apps/control/src/domain/trailers.ts'],
      tests: ['apps/control/test/prs.spec.ts','apps/control/test/reconcile.spec.ts','apps/control/test/waste.spec.ts','apps/control/test/waste-relanded.spec.ts','apps/control/test/github-budget.spec.ts','apps/control/test/fixtures/acme/github/prs.json','apps/control/test/fixtures/acme/github/prs-files.json','apps/control/test/fixtures/acme/github/branches.json','apps/control/test/fixtures/acme/railway/deployments.json'],
      brief: 'satisfies R22,R23,R24; provenBy T42-T52. Two-query GraphQL budget (§5.6), ETag REST, back-off table; links()/relanded() verbatim from build-plan WP5; §5.7 FIELD_WINNER table; W1-W10 thresholds; ledger rows on change only; Railway probe with GitHub-deployments fallback.', dependsOn: ['WP1','WP2','WP4'], risk: 'HIGH', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'WP8', title: 'ctl CLI', files: ['apps/control/src/cli/ctl.ts','apps/control/src/cli/commands.ts','apps/control/src/cli/format.ts'],
      tests: ['apps/control/test/cli.spec.ts','apps/control/test/cli-next.spec.ts','apps/control/test/helpers/spawn-cli.ts'],
      brief: 'satisfies R9,R10,R20,R35; provenBy T11,T18-T22,T37,T63. Verbs per spec §7 incl. seed/lane register/sync/pr-body/handoff/serve; caps 30 lines/1536 B; exit codes 2/3/4/5; bugs.mjs delegation in array form.', dependsOn: ['WP2','WP3','WP4'], model: 'claude-sonnet-5', effort: 'high' },
    { id: 'WP6', title: 'renderer, client, styles', files: ['apps/control/src/render/page.ts','apps/control/src/render/panels.ts','apps/control/src/render/esc.ts','apps/control/src/render/assets/client.js','apps/control/src/render/assets/styles.css'],
      tests: ['apps/control/test/render.spec.ts','apps/control/test/render.golden.spec.ts','apps/control/test/render-states.spec.ts','apps/control/test/contrast.spec.ts','apps/control/test/fixtures/acme/golden/index.html'],
      brief: 'satisfies R12,R13,R14,R18,R33,R34; provenBy T24-T27,T61,T62. Panels in ux-spec §3 order; tokens ux-spec §1; fragments in state.json; client per WP6 brief (confirmed writes, undo, drawer, SSE); golden generated once with UPDATE_GOLDEN=1 and reviewed against ux-spec §4.', dependsOn: ['WP2','WP5'], model: 'claude-sonnet-5', effort: 'high' },
    { id: 'WP9', title: 'rule text + hooks wiring', files: ['CLAUDE.md','.claude/roadmap/README.md','.claude/commands/orient.md','.claude/commands/handoff.md','.claude/settings.json','.claude/skills/dev-pipeline/scripts/closeout.mjs'],
      tests: ['apps/control/test/rule-text.spec.ts','apps/control/test/hooks-wiring.spec.ts','apps/control/test/stop-gates-unaffected.spec.ts'],
      brief: 'satisfies R19,R31; provenBy T35,T60,T36(pin). Paste spec §8 verbatim; orient step 9; handoff Control line; SessionStart hook; closeout --task. Docs-only edits; keep CLAUDE.md ≤ 25 KB.', dependsOn: ['WP0','WP8'], model: 'claude-haiku-4-5', effort: 'low' },
    { id: 'WP7', title: 'HTTP server, auth, SSE, webhook, main', files: ['apps/control/src/http/server.ts','apps/control/src/http/auth.ts','apps/control/src/http/csrf.ts','apps/control/src/http/sse.ts','apps/control/src/http/ratelimit.ts','apps/control/src/http/headers.ts','apps/control/src/http/routes.ts','apps/control/src/config.ts'],
      tests: ['apps/control/test/server.spec.ts','apps/control/test/server-auth.spec.ts','apps/control/test/server-write.spec.ts','apps/control/test/server-security.spec.ts','apps/control/test/server-sse.spec.ts','apps/control/test/server-webhook.spec.ts','apps/control/test/helpers/start-server.ts'],
      brief: 'satisfies R15,R16,R17,R21,R24(webhook),R25; provenBy T28-T34,T38-T41,T53,T54. auth/csrf code verbatim from build-plan WP7; exact-match routing; 16 KB body cap; owner-only types; expectedVersion 409; health public=1 minimal; SIGTERM drain. WP7 also finalizes src/main.ts body (created by WP0).', dependsOn: ['WP3','WP5','WP6'], risk: 'HIGH', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'UI1', title: 'verify the command center at 3 viewports × 2 schemes', type: 'ui-verify', files: [], tests: ['apps/web/e2e/control/control.capture.spec.ts','apps/web/playwright.control.config.ts'], dependsOn: ['WP7'],
      url: 'http://127.0.0.1:4317', startCommand: 'npm run build -w apps/control && CONTROL_LOCAL=1 CONTROL_FIXTURE=apps/control/test/fixtures/acme node apps/control/dist/main.js',
      flows: ['load: 12 panel headings, no console errors, scrollWidth<=innerWidth','drawer open on RF-1, Esc closes, focus restored','priority change confirmed only after response; Undo restores','FAIL_NEXT_WRITE=1 shows inline error, old value','CONFLICT_NEXT_WRITE=1 reloads with toast','header lines: <=1 colored word each','capture PNG per viewport/scheme to local-assets/proofs/<date>/control/'],
      viewports: ['desktop','tablet','mobile'], checks: ['console-errors','network-failures','a11y','design-system'],
      brief: 'T30 per test-plan §8; run dataviz validate_palette.js on the severity palette (light+dark) before capturing; probe A8 (native-parity config) first.', model: 'claude-sonnet-5', effort: 'high' },
  ],
  verifyCommands: { perRound: ['npm run check-types -w apps/control','npm run lint -w apps/control','npm test -w apps/control'], final: ['npm run verify','npm run build -w apps/control'] },
}
```

**Reviewer routing (model-routing skill):** Opus 5.5 `high` correctness lens on WP3, WP5, WP7
(HIGH: integrity, inference, internet-facing write path) over a Sonnet-built review pack ≤ 40 KB;
Sonnet 5 `high` reviews everything else; Haiku 4.5 `low` runs baseline gates, briefs and the
red check; Fable rules only on plan changes. Nothing inherits the session's effort.

**Owner runbook after merge (deploy day, T64):** create the Railway service from
`apps/control` (branch master, root context), set env (`CONTROL_PASSWORD`, `CONTROL_SESSION_SECRET`,
`CONTROL_GITHUB_TOKEN`, `CONTROL_DEPLOY_KEY_B64`, `CONTROL_REPO`, optional Railway/webhook vars),
add the read-only deploy key to the repo, add rulesets (`ctl/state`, `ctl/archive`: no
force-push/delete), create the orphan branch (`git checkout --orphan ctl/state && git rm -rf . &&
mkdir events && … && git push origin ctl/state`), run `npm run ctl -- seed` from the lead
machine (registers the nine lanes), open `/api/health`, then `npm run ctl -- note "hello"` from
one lane and watch the timeline.

## Coverage matrix summary (R → T → WP)

R1-R5 → T1-T11 → WP1 · R6-R8 → T12-T17 → WP2 · R3/R14 → T6,T7,T27 → WP4 · R9/R11/R26/R29/R32 → T18,T20,T23,T55,T58 → WP3 · R22-R24 → T42-T52 → WP5 · R9/R10/R20/R35 → T11,T18-T22,T37,T63 → WP8 · R12/R13/R18/R33/R34 → T24-T27,T61,T62,T30 → WP6+UI1 · R15-R17/R21/R25 → T28-T34,T38-T41,T53,T54 → WP7 · R2/R27/R28 → T5,T56,T57 → WP0 · R19/R31 → T35,T36,T60 → WP9 · manual T64 → runbook.
