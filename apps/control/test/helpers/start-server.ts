/**
 * WP7 harness: boots the control HTTP server in-process on port 0 against throwaway local git
 * (helpers/temp-repo.ts), the acme fixture, and a stubbed GitHub (no network).
 *
 * ASSUMED INTERFACES (chosen by the test author; see the WP7 test report):
 *   src/config.ts        loadConfig(env: Record<string,string|undefined>): Config
 *                        Config = { local, host, port, password?, sessionSecret?, webhookSecret?,
 *                                   fixtureDir?, repo? }; throws an Error naming each missing var
 *                        (non-local); local default host 127.0.0.1 port 4317, else 0.0.0.0.
 *   src/http/server.ts   createControlServer(deps): ControlApp
 *     deps = { config, env /* state-branch Env *\/, github /* TickDeps["github"] *\/, fetch,
 *              refresh?(): Promise<void> /* what a webhook schedules *\/,
 *              rateLimitDelayMs?, pingMs? }
 *     ControlApp = { listen({host?,port?}): Promise<{port}>, close(): Promise<void>, tick():
 *                    Promise<void>, state(): ControlState, sseCount(): number }
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { makeWorld, STATE_BRANCH } from "./temp-repo";
import type { World } from "./temp-repo";
import { NOW } from "./clock";

export const FIXTURE = path.join(__dirname, "..", "fixtures", "acme");
export const PASSWORD = "correct horse battery staple";
export const SESSION_SECRET = "s".repeat(40);
export const WEBHOOK_SECRET = "whsec-test-0123456789";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json(): any;
}

export function rawRequest(
  port: number,
  method: string,
  p: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          });
        });
        res.on("error", reject);
      },
    );
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

export interface Session {
  cookie: string;
  csrf: string;
  origin: string;
  /** Headers for a valid JSON write. */
  write(extra?: Record<string, string>): Record<string, string>;
}

export interface Harness {
  app: any;
  port: number;
  origin: string;
  world: World;
  config: any;
  deps: any;
  refreshCalls: number;
  fetchCalls: number;
  req(
    method: string,
    p: string,
    o?: { headers?: Record<string, string>; body?: string | Buffer },
  ): Promise<Res>;
  /** Log in (non-local) and read the CSRF token from the served page. */
  session(): Promise<Session>;
  /** POST /api/event with a valid session; `over` overrides headers/body parts. */
  postEvent(
    s: Session,
    body: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Res>;
  stateJson(s: Session): Promise<any>;
  ownerLines(): any[];
  close(): Promise<void>;
}

export interface StartOpts {
  local?: boolean;
  /** Opt in to the web write path (CONTROL_WRITEBACK=on). Default off, like production. */
  writeback?: boolean;
  /** An exact CONTROL_WRITEBACK value to set instead (the spelling tests). */
  writebackValue?: string;
  webhook?: boolean;
  rateLimitDelayMs?: number;
  pingMs?: number;
  depsOver?: Record<string, unknown>;
}

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(FIXTURE, rel), "utf8"));

/** Seed the temp origin's ctl/state from the fixture's events dir. */
export function seedFromFixture(world: World): void {
  const dir = path.join(FIXTURE, "state", "events");
  const files: Record<string, string> = { "README.md": "state branch (fixture seed)\n" };
  for (const n of fs.readdirSync(dir))
    files[`events/${n}`] = fs.readFileSync(path.join(dir, n), "utf8");
  world.seedBranch(STATE_BRANCH, files);
}

export async function startServer(opts: StartOpts = {}): Promise<Harness> {
  const world = makeWorld();
  let loadConfig: any, createControlServer: any;
  try {
    ({ loadConfig } = require("../../src/config"));
    ({ createControlServer } = require("../../src/http/server"));
  } catch (e) {
    world.cleanup();
    throw e;
  }
  seedFromFixture(world);
  const envVars: Record<string, string> = {
    CONTROL_FIXTURE: FIXTURE,
    CONTROL_PORT: "0",
    CONTROL_REPO: "acme/acme",
    ...(opts.local
      ? { CONTROL_LOCAL: "1" }
      : {
          CONTROL_PASSWORD: PASSWORD,
          CONTROL_SESSION_SECRET: SESSION_SECRET,
          CONTROL_GITHUB_TOKEN: "ghp_test_token",
          CONTROL_STATE_REPO: "acme/acme-control-state",
        }),
    ...(opts.webhook ? { CONTROL_WEBHOOK_SECRET: WEBHOOK_SECRET } : {}),
    ...(opts.writebackValue !== undefined
      ? { CONTROL_WRITEBACK: opts.writebackValue }
      : opts.writeback
        ? { CONTROL_WRITEBACK: "on" }
        : {}),
  };
  const config = loadConfig(envVars);
  const h: Harness = {
    app: null,
    port: 0,
    origin: "",
    world,
    config,
    deps: null,
    refreshCalls: 0,
    fetchCalls: 0,
    req: (m, p, o) => rawRequest(h.port, m, p, o),
    async session() {
      let cookie = "";
      if (!opts.local) {
        const login = await h.req("POST", "/login", {
          headers: { "content-type": "application/x-www-form-urlencoded", origin: h.origin },
          body: `password=${encodeURIComponent(PASSWORD)}`,
        });
        const sc = ([] as string[]).concat(login.headers["set-cookie"] ?? []);
        cookie = sc.map((c) => c.split(";")[0]).find((c) => c.startsWith("ctl_session=")) ?? "";
        if (!cookie) throw new Error(`login produced no session cookie (status ${login.status})`);
      }
      const page = await h.req("GET", "/", { headers: cookie ? { cookie } : {} });
      const m = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text);
      if (!m || !m[1]) throw new Error(`page carries no csrf token (status ${page.status})`);
      const sc2 = ([] as string[]).concat(page.headers["set-cookie"] ?? []);
      const c2 = sc2.map((c) => c.split(";")[0]).find((c) => c.startsWith("ctl_session="));
      cookie = c2 ?? cookie;
      return {
        cookie,
        csrf: m[1],
        origin: h.origin,
        write: (extra = {}) => ({
          ...(cookie ? { cookie } : {}),
          origin: h.origin,
          "x-control-token": m[1],
          "content-type": "application/json",
          ...extra,
        }),
      };
    },
    postEvent: (s, body, headers) =>
      h.req("POST", "/api/event", { headers: s.write(headers), body: JSON.stringify(body) }),
    async stateJson(s) {
      const r = await h.req("GET", "/api/state.json", {
        headers: s.cookie ? { cookie: s.cookie } : {},
      });
      if (r.status !== 200) throw new Error(`state.json ${r.status}`);
      return r.json();
    },
    ownerLines: () => world.remoteLines("owner"),
    async close() {
      try {
        await h.app?.close();
      } finally {
        world.cleanup();
      }
    },
  };
  const deps = {
    config,
    env: world.env("server", {
      now: () => NOW,
    }),
    github: {
      poll: async () => ({
        prs: readJson("github/prs.json"),
        branches: readJson("github/branches.json"),
        files: readJson("github/prs-files.json"),
      }),
      state: { rateLimit: { remaining: 4000, resetAt: null } },
    },
    fetch: async () => {
      h.fetchCalls++;
      throw new Error("network is stubbed in tests");
    },
    refresh: async () => {
      h.refreshCalls++;
    },
    rateLimitDelayMs: opts.rateLimitDelayMs ?? 0,
    pingMs: opts.pingMs,
    ...(opts.depsOver ?? {}),
  };
  h.deps = deps;
  h.app = createControlServer(deps);
  const { port } = await h.app.listen({ host: "127.0.0.1", port: 0 });
  h.port = port;
  h.origin = `http://127.0.0.1:${port}`;
  return h;
}

/** Read an SSE stream until `done(text)` or `ms` elapse. */
export function openSse(
  port: number,
  headers: Record<string, string>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text(): string;
  waitFor(re: RegExp, ms: number): Promise<boolean>;
  destroy(): void;
}> {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: "127.0.0.1", port, path: "/api/stream", headers, agent: false },
      (res) => {
        let buf = "";
        const waiters: Array<() => void> = [];
        res.setEncoding("utf8");
        res.on("data", (c) => {
          buf += c;
          waiters.slice().forEach((w) => w());
        });
        res.on("error", () => undefined);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => buf,
          waitFor: (re, ms) =>
            new Promise((ok) => {
              if (re.test(buf)) return ok(true);
              const t = setTimeout(() => {
                waiters.splice(waiters.indexOf(chk), 1);
                ok(false);
              }, ms);
              const chk = () => {
                if (re.test(buf)) {
                  clearTimeout(t);
                  waiters.splice(waiters.indexOf(chk), 1);
                  ok(true);
                }
              };
              waiters.push(chk);
            }),
          destroy: () => r.destroy(),
        });
      },
    );
    r.on("error", reject);
  });
}
