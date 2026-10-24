/**
 * Server-token PR, review F1: the token must never reach a different host after a redirect.
 * `http.<base>.extraheader` is scoped to the base, but git switches its base URL after a
 * followed redirect and then sends later requests (the upload-pack POST) with the header to the
 * new host. The fix is `http.followRedirects=false` next to the header. Two real local servers
 * (separate ports), real git, real `git http-backend`; nothing leaves 127.0.0.1.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startSmartHttp } from "./helpers/smart-http";
import type { SmartHttp, SmartHttpOpts } from "./helpers/smart-http";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(60_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const G = (): any => require("../src/sources/git");

const TOKEN = "tok-FAKE-redirect-0123456789";
const B64 = Buffer.from("x-access-token:" + TOKEN).toString("base64");
const SAVED = { ...process.env };
const servers: SmartHttp[] = [];
const tmps: string[] = [];

const serve = async (opts: SmartHttpOpts = {}): Promise<SmartHttp> => {
  const s = await startSmartHttp(opts);
  servers.push(s);
  return s;
};
const emptyClone = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "git-redirect-"));
  tmps.push(d);
  G().git(d, ["init", "-q"]);
  return d;
};
const fetchFrom = (clone: string, url: string): { ok: boolean; err: string } => {
  G().git(clone, ["remote", "add", "--", "origin", url]);
  return G().gitTry(clone, [
    "fetch",
    "-q",
    "--no-tags",
    "--end-of-options",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
};

beforeEach(() => {
  process.env.GIT_ALLOW_PROTOCOL = "file:http:https";
});
afterEach(async () => {
  G().setGitAuth(null);
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("a redirect never carries the token to another host", () => {
  it("A answers 302 -> B (another port): git fails, B receives ZERO requests", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    G().setGitAuth(TOKEN, `${a.base}/`);
    const r = fetchFrom(emptyClone(), a.repoUrl);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/302/);
    expect(a.seen.length).toBeGreaterThan(0);
    expect(b.seen).toEqual([]);
  });

  it("A answers 302 -> another host name on the same port: no request is made to it", async () => {
    const a = await serve({ redirectTo: "@localhost" });
    G().setGitAuth(TOKEN, `${a.base}/`);
    const r = fetchFrom(emptyClone(), a.repoUrl);
    expect(r.ok).toBe(false);
    expect(a.seen.filter((q) => !q.host.startsWith("127.0.0.1"))).toEqual([]);
    // the only request is the one to the configured base, answered with the redirect
    expect(a.seen).toHaveLength(1);
  });

  it("the token (in any form) appears on no request to B even when B is a working git server", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    G().setGitAuth(TOKEN, `${a.base}/`);
    fetchFrom(emptyClone(), a.repoUrl);
    expect(JSON.stringify(b.seen)).not.toContain(B64);
    expect(JSON.stringify(b.seen)).not.toContain(TOKEN);
    expect(b.seen.filter((q) => q.authorization !== undefined)).toEqual([]);
  });

  it("a normal fetch from the configured base still works, and carries the header", async () => {
    const a = await serve();
    G().setGitAuth(TOKEN, `${a.base}/`);
    const clone = emptyClone();
    const r = fetchFrom(clone, a.repoUrl);
    expect(r.err).toBe("");
    expect(r.ok).toBe(true);
    expect(G().git(clone, ["rev-parse", "refs/remotes/origin/main"]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(a.seen.length).toBeGreaterThan(1);
    expect(a.seen.every((q) => q.authorization === `Basic ${B64}`)).toBe(true);
  });

  it("opts.env can still switch redirects back on (the env entries are only defaults)", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    G().setGitAuth(TOKEN, `${a.base}/`);
    const clone = emptyClone();
    G().git(clone, ["remote", "add", "--", "origin", a.repoUrl]);
    const r = G().gitTry(clone, ["ls-remote", "--end-of-options", "origin"], {
      env: { GIT_CONFIG_COUNT: "0" },
    });
    // with the auth entries overridden away git follows the redirect: B is reached
    void r;
    expect(b.seen.length).toBeGreaterThan(0);
  });
});
