/**
 * The control HTTP server (spec section 6): login, the page, state.json, SSE, write-back, the
 * GitHub webhook and health. One process, one in-memory snapshot rebuilt from the state-branch
 * clone plus the latest GitHub / Railway reads; every mutation goes through `appendAndPush`.
 */
import { createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { Config } from "../config";
import * as F from "../domain/fold";
import { loadRegisters } from "../sources/registers";
import type { Registers } from "../sources/registers";
import type { LedgerRow, PRFile } from "../domain/prs";
import {
  ENVELOPE_OPTIONAL,
  LANE_ID_RE,
  OPTIONAL,
  REQUIRED,
  TASK_ID_RE,
  TMP_ID_RE,
  checkField,
  isEventType,
} from "../domain/schema";
import type { ControlState } from "../domain/types";
import { relandedFor, repoGit } from "../domain/waste";
import type { WastePR } from "../domain/waste";
import { banners, ctx as renderCtx, headerLines, renderFragments } from "../render/panels";
import type { Fragments } from "../render/panels";
import { renderPage } from "../render/page";
import * as C from "../sources/compact";
import { denylistAvailable } from "../sources/denylist";
import { CtlError, assertOrigin, cloneTimeoutMs, gitTry } from "../sources/git";
import type { Env } from "../sources/git";
import { withLock } from "../sources/lock";
import { runTick } from "../sources/poller";
import type { TickDeps } from "../sources/poller";
import { createGithubDeployments, createRailwayProbe, readDeployState } from "../sources/railway";
import type { Deploys } from "../sources/railway";
import * as S from "../sources/state-branch";
import { assemble, cleanPrs, parseWatchPatterns } from "./assemble";
import type { ServedState } from "./assemble";
import {
  CLEAR_COOKIE,
  COOKIE,
  hashPassword,
  loginPage,
  readSession,
  sessionCookie,
  signSession,
  verifyPassword,
} from "./auth";
import type { Session } from "./auth";
import { checkWrite, csrfFor, safeEqual } from "./csrf";
import { applyHeaders } from "./headers";
import { createLimiter } from "./ratelimit";
import {
  loadAssets,
  match,
  newTable,
  parseTarget,
  readBody,
  redirect,
  route,
  send,
  sendJson,
  streamBody,
} from "./routes";
import type { Target } from "./routes";
import { createSse } from "./sse";
import { appendLedger, readLedger } from "./ledger";

export interface ControlDeps {
  config: Config;
  /** State-branch env; `registers` is replaced by what the server loads. */
  env: Env;
  github: TickDeps["github"];
  /** HTTP client for Railway / GitHub deployments (injected so tests never touch the network). */
  fetch?: typeof fetch;
  /** What a verified webhook schedules; defaults to a tick that also fetches master. */
  refresh?: () => Promise<void>;
  rateLimitDelayMs?: number;
  pingMs?: number;
  masterDir?: string;
  /** Origin of the master clone (the product repo); defaults to `env.origin` (fixtures, tests). */
  masterOrigin?: string;
  log?: (line: string) => void;
}

export interface ControlApp {
  listen(o?: { host?: string; port?: number }): Promise<{ port: number }>;
  close(): Promise<void>;
  tick(): Promise<void>;
  state(): ControlState;
  sseCount(): number;
  /** Ledger rows queued for the next persisted push (capped at the ledger cap). Introspection for tests. */
  pendingLedgerRows(): number;
  startPolling(): void;
}

/** Owner-allowed event types (spec section 6, write-back). */
export const OWNER_TYPES: ReadonlySet<string> = new Set([
  "task.created",
  "task.adopted",
  "task.priority",
  "task.release",
  "task.lane",
  "task.next",
  "task.reconsider",
  "task.reopened",
  "task.areas",
  "task.dropped",
  "release.created",
  "release.moved",
  "pr.superseded",
  "waste.ack",
  "lane.registered",
  "lane.note",
]);

const BODY_LIMIT = 16 * 1024;
const LOGIN_LIMIT = 4 * 1024;
/** Row 684: the 403 sign-in page's message (fixed copy, never request data). */
export const BLOCKED_SIGN_IN =
  "This sign-in was blocked because the request didn't come from this page. Reload the page and try again.";
const WEBHOOK_LIMIT = 1024 * 1024;
const MAX_WARNINGS = 20;
const HOOK_MIN_MS = 10_000;
const LEDGER_CAP = 5_000;
const SIG_RE = /^sha256=([0-9a-f]{64})$/;
const HOST_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/** A timer that never keeps the process alive (it only ever races something else). */
const sleep = (ms: number): Promise<void> => new Promise((r) => void setTimeout(r, ms).unref());
const oneLine = (s: string, n = 200): string => s.replace(/\s+/g, " ").trim().slice(0, n);

interface Snapshot {
  state: ServedState;
  now: string;
  fragments: Fragments;
  header: string[];
  banners: string;
  json: string;
  etag: string;
}

function nextRfId(state: ControlState): string {
  let max = 0;
  for (const id of Object.keys(state.tasks)) {
    const m = /^RF-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `RF-${max + 1}`;
}

export function createControlServer(deps: ControlDeps): ControlApp {
  const cfg = deps.config;
  const env: Env = { ...deps.env, registers: { tasks: [], releases: [] } };
  if (!cfg.local && (cfg.password === undefined || cfg.sessionSecret === undefined)) {
    throw new Error("control: password and session secret are required unless CONTROL_LOCAL=1");
  }
  const onRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_PROJECT_ID,
  );
  if (cfg.local && onRailway) {
    throw new Error("CONTROL_LOCAL=1 is refused on Railway (it disables login)");
  }
  if (!cfg.local) {
    if ((cfg.password ?? "").length < 16)
      throw new Error("CONTROL_PASSWORD must be at least 16 characters");
    if (!cfg.publicOrigin && !cfg.fixtureDir) {
      throw new Error("CONTROL_PUBLIC_URL is required (the origin writes are checked against)");
    }
    if (cfg.fixtureDir && onRailway) throw new Error("CONTROL_FIXTURE is refused on Railway");
  }
  if (!denylistAvailable()) {
    throw new Error("the denylist (scripts/campaign/plane-denylist.json) failed to load");
  }
  const secret = cfg.sessionSecret ?? randomBytes(32).toString("hex");
  const pwHash = cfg.password !== undefined ? hashPassword(cfg.password) : null;
  const secure = !cfg.local;
  const LOCAL_SESSION: Session = { iat: 0, exp: Number.MAX_SAFE_INTEGER, nonce: "local" };
  const log = deps.log ?? ((): void => undefined);
  // Git sends the token as `Authorization: Basic base64("x-access-token:<token>")` and can echo
  // that header or a `remote:` body into an error, so the Basic forms are secrets too. The longest
  // form comes first so a full header is replaced whole.
  const basicOf = (t: string): string => Buffer.from(`x-access-token:${t}`).toString("base64");
  const secrets = [
    cfg.password,
    cfg.sessionSecret,
    cfg.webhookSecret,
    cfg.githubToken,
    cfg.railwayToken,
  ]
    .filter((s): s is string => typeof s === "string" && s.length >= 6)
    .flatMap((s) =>
      s === cfg.githubToken ? [`Authorization: Basic ${basicOf(s)}`, basicOf(s), s] : [s],
    );
  const redact = (m: string): string => secrets.reduce((acc, s) => acc.split(s).join("***"), m);
  /** Redact FIRST, then cut: a cut prefix of a secret no longer matches the secret. */
  const safeLine = (s: string, n = 200): string => oneLine(redact(s), n);
  const errText = (e: unknown): string => safeLine(e instanceof Error ? e.message : String(e));
  /** Rethrow with a redacted message (the poller cuts messages to length before we see them). */
  const scrubbed = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw new Error(redact(e instanceof Error ? e.message : String(e)));
    }
  };

  const limiter = createLimiter();
  const sse = createSse({ pingMs: deps.pingMs });
  const assets = loadAssets();
  const masterDir = deps.masterDir ?? path.join(path.dirname(path.resolve(env.cloneDir)), "master");

  /* ---------------------------------------------------------------- mutable server state */
  let snap: Snapshot | null = null;
  let cloneDir: string | null = null;
  let tickCount = 0;
  let nextMs = 30_000;
  let webhookAt: string | null = null;
  let webhookPending = false;
  let poll: { prs: unknown[]; branches: unknown[]; files: Record<string, PRFile[]> } | null = null;
  let githubOkAt: string | null = null;
  let railwayOkAt: string | null = null;
  let deploys: Deploys | null = null;
  let masterSha: string | null = null;
  let masterOkAt: string | null = null;
  let stateOkAt: string | null = null;
  let stateError: string | null = null;
  let tickWarnings: string[] = [];
  let compactWarning: string | null = null;
  let regsWarnings: string[] = [];
  let ledger: LedgerRow[] = [];
  let pendingRows: LedgerRow[] = [];
  let ledgerLoaded = false;
  const pulls = new Map<number, { ok: boolean; tick: number; why: string }>();
  let masterGit: ReturnType<typeof repoGit> | null = null;
  let wpCache: { key: string; wp: { api?: string[]; web?: string[] } } | null = null;
  let compacting = false;
  let closing = false;
  let polling = false;
  let pollTimer: NodeJS.Timeout | null = null;
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    const done = (): void => void inflight.delete(p);
    p.then(done, done);
    return p;
  };

  /** One-at-a-time section over the state clone and the snapshot. */
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => undefined);
    return run;
  };

  /* ---------------------------------------------------------------- sources */
  const syncState = async (): Promise<void> => {
    const clone = await S.ensureClone(env);
    cloneDir = clone;
    await withLock(S.lockDirOf(clone), 30_000, () => {
      S.syncClone(env, clone);
    });
    stateOkAt = env.now();
  };

  const ensureMaster = (): boolean => {
    if (fs.existsSync(path.join(masterDir, ".git"))) {
      // a clone left by an older boot keeps its old origin (e.g. ssh); the configured one wins
      if (deps.masterOrigin !== undefined) {
        try {
          const want = assertOrigin(deps.masterOrigin);
          const cur = gitTry(masterDir, ["remote", "get-url", "origin"]);
          if (!cur.ok || cur.out.trim() !== want) {
            const set = gitTry(masterDir, [
              "remote",
              cur.ok ? "set-url" : "add",
              "--",
              "origin",
              want,
            ]);
            return set.ok;
          }
        } catch {
          /* a bad masterOrigin leaves the clone as it was */
        }
      }
      return true;
    }
    try {
      const origin = assertOrigin(deps.masterOrigin ?? env.origin);
      fs.mkdirSync(masterDir, { recursive: true });
      const a = gitTry(masterDir, ["init", "-q"]);
      const b = gitTry(masterDir, ["remote", "add", "--", "origin", origin]);
      return a.ok && b.ok;
    } catch {
      return false;
    }
  };

  const fetchMaster = (): void => {
    if (!ensureMaster()) throw new Error("master clone could not be created");
    const r = gitTry(
      masterDir,
      [
        "fetch",
        "-q",
        "--no-tags",
        "--end-of-options",
        "origin",
        "+refs/heads/master:refs/remotes/origin/master",
      ],
      { timeoutMs: cloneTimeoutMs() },
    );
    if (!r.ok) {
      if (cfg.fixtureDir) return; // a fixture origin has no master branch: expected, not a warning
      throw new Error(safeLine(r.err || "fetch failed", 160));
    }
    const sha = gitTry(masterDir, [
      "rev-parse",
      "--verify",
      "-q",
      "--end-of-options",
      "refs/remotes/origin/master^{commit}",
    ]);
    if (sha.ok && /^[0-9a-f]{40}$/.test(sha.out.trim())) {
      masterSha = sha.out.trim();
      masterOkAt = env.now();
    }
  };

  /** refs/pull/N/head for closed-unmerged PRs, so W5 (re-landed) can see their commits. */
  const fetchPulls = (raw: unknown[]): void => {
    const nums = cleanPrs(raw)
      .filter((n) => String(n.state).toUpperCase() === "CLOSED" && !n.mergedAt)
      .map((n) => n.number as number)
      .sort((a, b) => a - b);
    if (nums.length === 0 || !ensureMaster()) return;
    let budget = 5;
    for (const n of nums) {
      const prev = pulls.get(n);
      if (prev?.ok) continue;
      if (prev && tickCount - prev.tick < 10) continue; // back off a failing fetch
      if (budget-- <= 0) break;
      const r = gitTry(
        masterDir,
        [
          "fetch",
          "-q",
          "--no-tags",
          "--end-of-options",
          "origin",
          `+refs/pull/${n}/head:refs/ctl/pull/${n}`,
        ],
        { timeoutMs: cloneTimeoutMs() },
      );
      pulls.set(n, {
        ok: r.ok,
        tick: tickCount,
        why: r.ok ? "" : safeLine(r.err || "fetch failed", 100),
      });
    }
  };

  const readRailway = async (): Promise<unknown> => {
    let read: Awaited<ReturnType<typeof readDeployState>>;
    if (cfg.fixtureDir) {
      read = await readDeployState(() =>
        Promise.resolve(
          JSON.parse(
            fs.readFileSync(path.join(cfg.fixtureDir ?? "", "railway", "deployments.json"), "utf8"),
          ) as unknown,
        ),
      );
    } else if (cfg.railwayToken && cfg.railwayProjectId) {
      const [owner, repo] = (cfg.repo ?? "/").split("/");
      read = await readDeployState(
        createRailwayProbe({
          token: cfg.railwayToken,
          projectId: cfg.railwayProjectId,
          environmentId: cfg.railwayEnvironmentId,
          fetch: deps.fetch,
        }),
        cfg.githubToken && owner && repo
          ? createGithubDeployments({ token: cfg.githubToken, owner, repo, fetch: deps.fetch })
          : undefined,
      );
    } else {
      return null;
    }
    if (read.state) {
      deploys = read.state;
      railwayOkAt = env.now();
    }
    return read;
  };

  const watchPatterns = (): { api?: string[]; web?: string[] } => {
    const key = masterSha ?? "-";
    if (wpCache?.key === key) return wpCache.wp;
    const out: { api?: string[]; web?: string[] } = {};
    for (const svc of ["api", "web"] as const) {
      let text: string | null = null;
      if (masterSha) {
        const r = gitTry(masterDir, [
          "show",
          "--end-of-options",
          `${masterSha}:apps/${svc}/railway.toml`,
        ]);
        if (r.ok) text = r.out;
      }
      if (text === null && !masterSha) {
        try {
          text = fs.readFileSync(path.join(REPO_ROOT, "apps", svc, "railway.toml"), "utf8");
        } catch {
          /* not in this image: use the default */
        }
      }
      out[svc] = (text !== null ? parseWatchPatterns(text) : undefined) ?? [
        `apps/${svc}/**`,
        "packages/**",
      ];
    }
    wpCache = { key, wp: out };
    return out;
  };

  const loadRegs = (): Registers => {
    if (cfg.fixtureDir) return loadRegisters({ fixtureDir: cfg.fixtureDir });
    if (masterSha) return loadRegisters({ repoDir: masterDir, sha: masterSha });
    return {
      tasks: [],
      releases: [],
      registerTasks: [],
      warnings: ["registers: master not fetched yet"],
    };
  };

  /* ---------------------------------------------------------------- snapshot */
  const sourceWarnings = (): string[] => {
    const all = [...tickWarnings, ...regsWarnings];
    for (const [n, p] of [...pulls].sort((a, b) => a[0] - b[0])) {
      if (!p.ok) all.push(`refs/pull/${n}/head not fetched (#${n}): ${p.why}`);
    }
    if (compactWarning) all.push(compactWarning);
    if (stateError) all.push(`state: ${stateError}`);
    return [...new Set(all.map((w) => safeLine(w)))].slice(0, MAX_WARNINGS);
  };

  /** Re-fold the clone with the cached GitHub / Railway reads. Local only: no network. Returns true when the served version moved. */
  const recompute = (): boolean => {
    if (cloneDir === null) return false;
    const now = env.now();
    try {
      if (!ledgerLoaded) {
        ledger = readLedger(cloneDir);
        ledgerLoaded = true;
      }
      const tree = S.readTree(cloneDir);
      const regs = loadRegs();
      regsWarnings = regs.warnings.map((w) => safeLine(w, 160));
      env.registers = { tasks: regs.tasks, releases: regs.releases };
      const base = { tasks: regs.tasks, releases: regs.releases };
      const events = S.liveEvents(tree);
      const acc = F.foldEvents(tree.snap?.acc ?? null, base, events);
      const reportedAt = F.reportedStatusAt(events);
      const wp = watchPatterns();
      const projected = F.project(
        acc,
        base,
        { inferred: { reportedAt, watchPatterns: wp } },
        deploys,
        now,
      );
      let head: { lane: string; seq: number; ts: string } | null = null;
      for (const [lane, evs] of Object.entries(events)) {
        for (const e of evs) {
          if (
            typeof e.ts === "string" &&
            (head === null || e.ts > head.ts || (e.ts === head.ts && lane > head.lane))
          ) {
            head = { lane, seq: e.seq, ts: e.ts };
          }
        }
      }
      masterGit ??= repoGit(masterDir);
      const reland = relandedFor(masterGit);
      const out = assemble({
        projected,
        now,
        poll,
        deploys,
        repoDir: masterSha ? masterDir : undefined,
        reportedAt,
        watchPatterns: wp,
        ledger,
        relanded: (pr: WastePR) => (pulls.get(pr.pr)?.ok === true ? reland(pr) : true),
        sensitive: new Set(regs.tasks.filter((t) => t.sensitive === true).map((t) => t.id)),
        facts: {
          githubOkAt,
          rateRemaining: deps.github.state.rateLimit.remaining,
          railwayOkAt,
          masterSha,
          stateHead: head ? { lane: head.lane, seq: head.seq } : null,
          warnings: sourceWarnings(),
        },
      });
      ledger = [...ledger, ...out.ledgerAdds].slice(-LEDGER_CAP);
      // capped like the ledger (oldest dropped) so a push that keeps failing, or never runs
      // (write-back off), cannot grow memory without bound
      pendingRows = [...pendingRows, ...out.ledgerAdds].slice(-LEDGER_CAP);
      stateError = null;
      const opts = { now, local: cfg.local, writeback: cfg.writeback };
      const fragments = renderFragments(out.state, opts);
      const rc = renderCtx(out.state, opts);
      const header = headerLines(rc).map((l) => l.s);
      const bn = banners(rc).s;
      const body = { state: out.state, fragments, header, banners: bn, version: out.state.version };
      const changed = snap?.state.version !== out.state.version;
      snap = {
        state: out.state,
        now,
        fragments,
        header,
        banners: bn,
        json: JSON.stringify(body),
        etag: `"${out.state.version}"`,
      };
      return changed;
    } catch (e) {
      stateError = errText(e);
      return false;
    }
  };

  const commit = (): void => {
    if (recompute() && snap) sse.broadcast(snap.state.version);
  };

  /** Compaction when due (lead-only path), plus the snapshot-size warning. Never throws. */
  const maybeCompact = async (): Promise<void> => {
    const clone = cloneDir;
    if (clone === null || closing) return;
    let due = false;
    try {
      // compaction pushes the state branch and the archive ref: never with write-back off
      due = cfg.writeback && C.compactDue(clone);
    } catch {
      due = false;
    }
    let warn: string | null = null;
    if (due && !compacting) {
      compacting = true;
      try {
        const r = await C.compact(env);
        warn = r.snapshotWarning ?? C.snapshotWarning(clone);
      } catch (e) {
        warn = `compact: ${errText(e)}`;
      } finally {
        compacting = false;
      }
    } else {
      try {
        warn = C.snapshotWarning(clone);
      } catch {
        warn = null;
      }
    }
    const moved = warn !== compactWarning || due;
    compactWarning = warn;
    if (moved) await locked(() => Promise.resolve(commit()));
  };

  /* ---------------------------------------------------------------- ticks */
  const tick = async (o: { webhook?: boolean } = {}): Promise<void> => {
    tickCount++;
    const webhook = o.webhook === true || webhookPending;
    webhookPending = false;
    const res = await runTick(
      {
        github: deps.github,
        fetchState: () => scrubbed(() => locked(syncState)),
        fetchMaster: () => scrubbed(() => locked(() => Promise.resolve(fetchMaster()))),
        railway: readRailway,
        lastWebhookAt: () => webhookAt,
        now: () => env.now(),
      },
      tickCount,
      { webhook },
    );
    tickWarnings = res.warnings.map((w) => redact(w));
    nextMs = res.nextMs;
    if (res.github) {
      poll = { prs: res.github.prs, branches: res.github.branches, files: res.github.files };
      if (
        res.github.rateLimited !== true &&
        !(res.github.warnings ?? []).some((w) => w.startsWith("github:"))
      ) {
        githubOkAt = env.now();
      }
    }
    if (poll) fetchPulls(poll.prs);
    await locked(async () => {
      if (cloneDir === null) {
        try {
          await syncState();
        } catch (e) {
          stateError = errText(e);
        }
      }
      commit();
      // the ledger commit is a git push: only with write-back on (the read-only token would
      // fail every tick, and the dashboard keeps serving the in-memory rows either way)
      if (cfg.writeback && pendingRows.length > 0) {
        const batch = pendingRows;
        try {
          await appendLedger(env, batch);
          pendingRows = pendingRows.slice(batch.length);
        } catch (e) {
          tickWarnings = [...tickWarnings, `ledger: ${errText(e)}`]; // kept pending, retried next tick
        }
      }
    });
    await maybeCompact();
  };

  let refreshing: Promise<void> | null = null;
  let again = false;
  const scheduleRefresh = (): void => {
    if (closing) return;
    if (refreshing) {
      again = true;
      return;
    }
    const fn = deps.refresh ?? ((): Promise<void> => tick({ webhook: true }));
    refreshing = track(
      (async () => {
        do {
          again = false;
          try {
            await fn();
          } catch (e) {
            log(`refresh failed: ${errText(e)}`);
          }
        } while (again && !closing);
      })().finally(() => {
        refreshing = null;
      }),
    );
  };

  const startPolling = (): void => {
    if (polling) return;
    polling = true;
    const loop = (): void => {
      void tick()
        .catch((e: unknown) => log(`tick failed: ${errText(e)}`))
        .finally(() => {
          if (polling && !closing) pollTimer = setTimeout(loop, nextMs);
        });
    };
    loop();
  };

  /* ---------------------------------------------------------------- readiness */
  let readyDone = false;
  let readyResolve: () => void = () => undefined;
  const ready: Promise<void> = new Promise<void>((resolve) => {
    readyResolve = (): void => {
      readyDone = true;
      resolve();
    };
  });
  const waitReady = async (): Promise<void> => {
    if (!readyDone) await Promise.race([ready, sleep(10_000)]);
  };
  const begin = (): void => {
    void track(
      locked(async () => {
        try {
          await syncState();
        } catch (e) {
          stateError = errText(e);
        }
        commit();
      }),
    ).finally(() => readyResolve());
  };

  /* ---------------------------------------------------------------- request helpers */
  const sessionOf = (req: http.IncomingMessage): Session | null =>
    cfg.local ? LOCAL_SESSION : readSession(secret, sessionCookie(req), Date.now());

  let boundPort = 0;
  /** Local mode serves only its own loopback names (a rebinding page cannot reach it). */
  const localHostOk = (req: http.IncomingMessage): boolean => {
    const host = req.headers.host;
    return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;
  };
  const servedOrigin = (req: http.IncomingMessage): string | null => {
    if (cfg.local) return localHostOk(req) ? `http://${req.headers.host ?? ""}` : null;
    if (cfg.publicOrigin) return cfg.publicOrigin;
    const host = req.headers.host;
    if (typeof host !== "string" || !HOST_RE.test(host)) return null;
    const xfp = req.headers["x-forwarded-proto"];
    const first = (typeof xfp === "string" ? xfp.split(",")[0].trim().toLowerCase() : "") || "";
    const proto =
      first === "https" || first === "http"
        ? first
        : req.socket && "encrypted" in req.socket
          ? "https"
          : "http";
    return `${proto}://${host}`;
  };

  const clientIp = (req: http.IncomingMessage): string => {
    const xff = req.headers["x-forwarded-for"];
    if (!cfg.local && typeof xff === "string") {
      const last = xff.split(",").pop()?.trim() ?? "";
      if (/^[0-9A-Fa-f:.]{3,45}$/.test(last)) return last; // the proxy-appended (rightmost) hop
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const unauth = (res: http.ServerResponse): void => sendJson(res, 401, { error: "unauthorized" });
  /**
   * Form POST origin check (login, logout). Row 684, the Ops Monitor's rule: a browser that marks the request
   * cross-site or same-site is refused; `Origin: null` (a privacy-mode or opaque origin) is accepted only when the
   * browser also says `Sec-Fetch-Site: same-origin`; any other Origin must equal the served origin. A client that
   * sends neither header is a non-browser one; SameSite=Strict covers browsers.
   */
  const originOk = (req: http.IncomingMessage): boolean => {
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site" || site === "same-site") return false;
    const o = req.headers.origin;
    if (o === undefined) return true;
    if (o === "null") return site === "same-origin";
    const want = servedOrigin(req);
    return typeof o === "string" && want !== null && safeEqual(o, want);
  };
  /** The refusal a browser user sees: the sign-in page with a plain reason, so a retry is one click. */
  const refuseForm = (res: http.ServerResponse) =>
    send(res, 403, loginPage(BLOCKED_SIGN_IN), "text/html; charset=utf-8");

  /* ---------------------------------------------------------------- handlers */
  const table = newTable();

  route(table, "GET", "/robots.txt", (_q, res) => {
    send(res, 200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8");
  });

  for (const url of ["/assets/client.js", "/assets/styles.css"]) {
    route(table, "GET", url, (_q, res) => {
      const a = Object.hasOwn(assets, url) ? assets[url] : undefined;
      if (!a) return sendJson(res, 404, { error: "not_found" });
      send(res, 200, a.body, a.type);
    });
  }

  route(table, "GET", "/login", (req, res) => {
    if (cfg.local || sessionOf(req)) return redirect(res, "/");
    send(res, 200, loginPage(null), "text/html; charset=utf-8");
  });

  route(table, "POST", "/login", async (req, res) => {
    if (cfg.local || pwHash === null) return redirect(res, "/");
    const ip = clientIp(req);
    if (limiter.blocked(ip)) {
      log(`login blocked ip=${ip}`);
      await sleep(deps.rateLimitDelayMs ?? 2000);
      return send(
        res,
        429,
        loginPage("Too many attempts. Try again later."),
        "text/html; charset=utf-8",
      );
    }
    if (!originOk(req)) return refuseForm(res);
    limiter.fail(ip); // count the attempt now, before the body arrives (no slow-body burst)
    const body = await readBody(req, LOGIN_LIMIT);
    if (!body.ok) return sendJson(res, 413, { error: "too_large" });
    const given = new URLSearchParams(body.buf.toString("utf8")).get("password") ?? "";
    if (!verifyPassword(given, pwHash)) {
      log(`login failed ip=${ip}`);
      return send(res, 401, loginPage("Wrong password."), "text/html; charset=utf-8");
    }
    limiter.forgive(ip);
    log(`login ok ip=${ip}`);
    redirect(res, "/", { "Set-Cookie": COOKIE(signSession(secret, Date.now()), secure) }, 303);
  });

  route(table, "POST", "/logout", (req, res) => {
    if (!cfg.local && !sessionOf(req)) return unauth(res);
    if (!originOk(req)) return refuseForm(res);
    redirect(res, "/login", { "Set-Cookie": CLEAR_COOKIE(secure) }, 303);
  });

  route(table, "GET", "/", async (req, res) => {
    const session = sessionOf(req);
    if (!session) return redirect(res, "/login");
    await waitReady();
    const csrf = csrfFor(secret, session.nonce);
    const html = snap
      ? renderPage(snap.state, { now: snap.now, local: cfg.local, csrf, writeback: cfg.writeback })
      : renderPage(
          {},
          { now: env.now(), local: cfg.local, csrf, loading: true, writeback: cfg.writeback },
        );
    send(res, 200, html, "text/html; charset=utf-8");
  });

  route(table, "GET", "/api/state.json", async (req, res) => {
    if (!sessionOf(req)) return unauth(res);
    await waitReady();
    if (!snap) return sendJson(res, 503, { error: "state_unavailable" });
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.split(",").some((t) => t.trim() === snap?.etag)) {
      res.writeHead(304, { ETag: snap.etag });
      return void res.end();
    }
    send(res, 200, snap.json, "application/json; charset=utf-8", { ETag: snap.etag });
  });

  route(table, "GET", "/api/stream", (req, res) => {
    if (!sessionOf(req)) return unauth(res);
    if (closing) return sendJson(res, 503, { error: "shutting_down" });
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    if (!sse.add(res)) sendJson(res, 429, { error: "too_many_streams" });
  });

  route(table, "GET", "/api/health", async (req, res, t) => {
    if (t.query.get("public") === "1") return sendJson(res, 200, { ok: true });
    if (!sessionOf(req)) return unauth(res);
    await waitReady();
    const rl = deps.github.state.rateLimit;
    sendJson(res, 200, {
      ok: stateError === null && snap !== null,
      version: snap?.state.version ?? null,
      now: env.now(),
      tick: tickCount,
      streams: sse.count(),
      sources: {
        github: { lastOk: githubOkAt, rateRemaining: rl.remaining, resetAt: rl.resetAt ?? null },
        railway: { lastOk: railwayOkAt },
        master: { sha: masterSha ? masterSha.slice(0, 7) : null, lastOk: masterOkAt },
        state: { lastOk: stateOkAt, error: stateError },
        webhook: { lastAt: webhookAt },
      },
      warnings: sourceWarnings(),
    });
  });

  const deliveries: string[] = [];
  let lastHookRun = 0;
  let hookTimer: NodeJS.Timeout | null = null;
  route(table, "POST", "/api/github-webhook", async (req, res) => {
    // refuse before reading a byte: no secret, or a signature that cannot possibly match
    const sig = req.headers["x-hub-signature-256"];
    const m = typeof sig === "string" ? SIG_RE.exec(sig) : null;
    if (!m || !cfg.webhookSecret) {
      return sendJson(res, 401, { error: "bad_signature" }, { Connection: "close" });
    }
    // the handler needs no body field: hash the bytes as they arrive and keep none of them
    const mac = createHmac("sha256", cfg.webhookSecret);
    const body = await streamBody(req, WEBHOOK_LIMIT, (c) => void mac.update(c));
    // A REJECTED delivery closes its connection (like the early refusal above): Node destroys the
    // socket once the response flushes, so bytes the client sends afterwards (the leftover of a
    // half-sent or oversized upload) are never parsed as a NEW request, which answered the client a
    // bare 400 (HPE_INVALID_METHOD) ahead of the real 401/413 on macOS (B950)
    if (!body.ok) return sendJson(res, 413, { error: "too_large" }, { Connection: "close" });
    const want = mac.digest("hex");
    if (!safeEqual(want, m[1])) {
      return sendJson(res, 401, { error: "bad_signature" }, { Connection: "close" });
    }
    const id = req.headers["x-github-delivery"];
    if (typeof id === "string" && id !== "") {
      if (deliveries.includes(id)) return sendJson(res, 202, { accepted: true, duplicate: true });
      deliveries.push(id.slice(0, 80));
      if (deliveries.length > 500) deliveries.shift();
    }
    if (req.headers["x-github-event"] !== "ping") {
      webhookAt = env.now();
      webhookPending = true;
      const wait = lastHookRun + HOOK_MIN_MS - Date.now();
      if (wait <= 0) {
        lastHookRun = Date.now();
        scheduleRefresh();
      } else if (!hookTimer && !closing) {
        hookTimer = setTimeout(() => {
          hookTimer = null;
          lastHookRun = Date.now();
          scheduleRefresh();
        }, wait);
        hookTimer.unref();
      }
    }
    sendJson(res, 202, { accepted: true });
  });

  route(table, "POST", "/api/event", async (req, res) => {
    const session = sessionOf(req);
    const origin = servedOrigin(req);
    const bad = checkWrite(req, session, origin ?? "", secret);
    if (bad !== 0 || origin === null)
      return sendJson(res, bad === 0 ? 403 : bad, { error: "refused" });
    // after the session/Origin/CSRF checks (an unauthenticated caller learns nothing), before the
    // body is read or the state clone is touched: a closed write path writes and fetches nothing
    if (!cfg.writeback) return sendJson(res, 403, { error: "writeback_off" });
    if (closing) return sendJson(res, 503, { error: "shutting_down" });
    const body = await readBody(req, BODY_LIMIT);
    if (!body.ok) return sendJson(res, 413, { error: "too_large" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.buf.toString("utf8"));
    } catch {
      return sendJson(res, 400, { error: "bad_json" });
    }
    const checked = shapeEvent(parsed);
    if ("error" in checked) return sendJson(res, 422, { error: "invalid", reason: checked.error });
    await waitReady();
    const out = await track(writeEvent(checked.draft, checked.expectedVersion));
    if ("status" in out) return sendJson(res, out.status, out.body);
    sendJson(res, 200, out);
    void track(maybeCompact());
  });

  /** Owner event from a flat body: allowed type, allowed keys, per-field schema, nothing else. */
  function shapeEvent(v: unknown): { draft: S.Draft; expectedVersion: string } | { error: string } {
    if (v === null || typeof v !== "object" || Array.isArray(v))
      return { error: "body must be an object" };
    const o = v as Record<string, unknown>;
    const type = o.type;
    if (typeof type !== "string" || !OWNER_TYPES.has(type) || !isEventType(type)) {
      return { error: "type not allowed" };
    }
    if (typeof o.expectedVersion !== "string" || o.expectedVersion === "") {
      return { error: "expectedVersion required" };
    }
    const minted = type === "task.created";
    const required = REQUIRED[type].filter((k) => !(minted && k === "id"));
    const allowed = new Set<string>([...required, ...OPTIONAL[type], ...ENVELOPE_OPTIONAL]);
    const draft: Record<string, unknown> = { type, by: "owner" };
    for (const k of Object.keys(o)) {
      if (k === "type" || k === "expectedVersion") continue;
      if (!Object.hasOwn(o, k) || !allowed.has(k))
        return { error: `unknown field ${oneLine(k, 40)}` };
      draft[k] = o[k];
    }
    for (const k of required) if (!(k in draft)) return { error: `missing ${k}` };
    for (const k of Object.keys(draft)) {
      if (k === "type" || k === "by") continue;
      const why = checkField(type, k, draft[k], "owner");
      if (why) return { error: `${k} ${why}` };
    }
    for (const k of ["task", "targetLane", "toLane", "laneId"]) {
      const x = draft[k];
      if (typeof x === "string" && k === "task" && !(TASK_ID_RE.test(x) || TMP_ID_RE.test(x))) {
        return { error: "bad task id" };
      }
      if (typeof x === "string" && k !== "task" && !LANE_ID_RE.test(x))
        return { error: `bad ${k}` };
    }
    return { draft: draft as S.Draft, expectedVersion: o.expectedVersion };
  }

  function writeEvent(
    draft: S.Draft,
    expectedVersion: string,
  ): Promise<{ seq: number; version: string } | { status: number; body: unknown }> {
    return locked(async () => {
      try {
        await syncState(); // compare against the newest tip, not the last tick
      } catch (e) {
        stateError = errText(e);
      }
      commit();
      const cur = snap;
      if (!cur) return { status: 503, body: { error: "state_unavailable" } };
      if (!safeEqual(expectedVersion, cur.state.version)) {
        return { status: 409, body: { conflict: true, version: cur.state.version } };
      }
      try {
        const ev = await S.appendAndPush(
          env,
          "owner",
          draft,
          draft.type === "task.created" ? nextRfId : undefined,
        );
        commit();
        return { seq: ev.seq, version: snap?.state.version ?? cur.state.version };
      } catch (e) {
        if (e instanceof CtlError && (e.code === 3 || e.code === 4)) {
          return { status: 422, body: { error: "invalid", reason: errText(e) } };
        }
        log(`write failed: ${errText(e)}`);
        return {
          status: 503,
          body: {
            error: "state_branch_unavailable",
            note: "the change was queued and will apply when the branch is reachable",
          },
        };
      }
    });
  }

  /* ---------------------------------------------------------------- server */
  const server = http.createServer((req, res) => {
    applyHeaders(res);
    if (cfg.local && !localHostOk(req)) return sendJson(res, 421, { error: "misdirected" });
    const t: Target | null = parseTarget(req.url);
    if (t === null) return sendJson(res, 404, { error: "not_found" });
    const m = match(table, req.method ?? "", t.pathname);
    if (m.kind === "notFound") return sendJson(res, 404, { error: "not_found" });
    if (m.kind === "method")
      return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: m.allow });
    Promise.resolve()
      .then(() => m.handler(req, res, t))
      .catch((e: unknown) => {
        log(`handler failed: ${errText(e)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal" });
        else res.destroy();
      });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 256;

  let closed: Promise<void> | null = null;
  const app: ControlApp = {
    listen(o = {}) {
      const host = cfg.local ? "127.0.0.1" : (o.host ?? cfg.host);
      const port = o.port ?? cfg.port;
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          const a = server.address();
          boundPort = typeof a === "object" && a ? a.port : port;
          begin();
          resolve({ port: typeof a === "object" && a ? a.port : port });
        });
      });
    },
    close() {
      closed ??= (async () => {
        closing = true;
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
        if (hookTimer) clearTimeout(hookTimer);
        sse.closeAll();
        const stopped = new Promise<void>((r) => {
          if (!server.listening) return r();
          server.close(() => r());
        });
        server.closeIdleConnections();
        await Promise.race([Promise.allSettled([...inflight]), sleep(4_000)]);
        server.closeAllConnections();
        await Promise.race([stopped, sleep(900)]);
      })();
      return closed;
    },
    tick: () => track(tick()),
    state() {
      if (!snap) throw new Error("state not ready");
      return snap.state as unknown as ControlState;
    },
    sseCount: () => sse.count(),
    pendingLedgerRows: () => pendingRows.length,
    startPolling,
  };
  return app;
}
