/**
 * Server-token PR, HTTPS auth for git children: the token rides in git's env config
 * (GIT_CONFIG_*), scoped to one base URL, and never in argv, a URL or .git/config.
 * Local throwaway repos only (file://); nothing touches the network.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installGitShim } from "./helpers/git-argv-shim";
import type { GitShim } from "./helpers/git-argv-shim";

/* eslint-disable @typescript-eslint/no-explicit-any */
const G = (): any => require("../src/sources/git");

const TOKEN = "tok-FAKE-gitauth-0123456789";
const B64 = Buffer.from("x-access-token:" + TOKEN).toString("base64");
const HEADER = `Authorization: Basic ${B64}`;
const KEY = "http.https://github.com/.extraheader";
const FOLLOW = "http.https://github.com/.followRedirects";
// the generic entry every git child gets, token or not: a rename alias or transfer redirect must
// fail loudly instead of silently sending a push to a different repo
const GENERIC = "http.followRedirects";

const SAVED = { ...process.env };
let shim: GitShim | undefined;
const tmps: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "git-auth-"));
  tmps.push(d);
  return d;
};

afterEach(() => {
  try {
    G().setGitAuth?.(null);
  } catch {
    /* module may not export it yet (RED) */
  }
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  shim?.cleanup();
  shim = undefined;
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("gitAuthEnv", () => {
  it("returns git env config scoped to the https://github.com/ base", () => {
    expect(G().gitAuthEnv(TOKEN)).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: KEY,
      GIT_CONFIG_VALUE_0: HEADER,
      GIT_CONFIG_KEY_1: FOLLOW,
      GIT_CONFIG_VALUE_1: "false",
    });
  });
  it("a URL-scoped followRedirects=true in any other config cannot beat ours (env config wins)", () => {
    const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctl-gitcfg-")), "gitconfig");
    tmps.push(path.dirname(cfg));
    fs.writeFileSync(cfg, '[http "https://github.com/"]\n\tfollowRedirects = true\n');
    const run = (extra: Record<string, string>): string =>
      execFileSync(
        "git",
        ["config", "--get-urlmatch", "http.followRedirects", "https://github.com/acme/app.git"],
        {
          env: { PATH: process.env.PATH ?? "", GIT_CONFIG_GLOBAL: cfg, ...extra },
          encoding: "utf8",
        },
      ).trim();
    expect(run({})).toBe("true"); // the scratch config really does say true
    expect(run(G().gitAuthEnv(TOKEN))).toBe("false"); // ours is applied last and wins
  });
  it("takes a custom base", () => {
    const e = G().gitAuthEnv(TOKEN, "http://127.0.0.1:9/");
    expect(e.GIT_CONFIG_KEY_0).toBe("http.http://127.0.0.1:9/.extraheader");
  });
  it("is Basic x-access-token:<token>, base64", () => {
    const v: string = G().gitAuthEnv(TOKEN).GIT_CONFIG_VALUE_0;
    const b64 = v.replace("Authorization: Basic ", "");
    expect(Buffer.from(b64, "base64").toString()).toBe("x-access-token:" + TOKEN);
  });
});

describe("childEnv with setGitAuth", () => {
  it("carries the GIT_CONFIG_* entries but never a CONTROL_* variable", () => {
    process.env.CONTROL_SECRET_PROBE = "leak-me-please";
    process.env.CONTROL_GITHUB_TOKEN = TOKEN;
    G().setGitAuth(TOKEN);
    delete process.env.GIT_CONFIG_COUNT;
    const env = G().childEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe(KEY);
    expect(env.GIT_CONFIG_VALUE_0).toBe(HEADER);
    expect(env.GIT_CONFIG_KEY_1).toBe(FOLLOW);
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
    expect(env.GIT_CONFIG_KEY_2).toBe(GENERIC);
    expect(env.GIT_CONFIG_VALUE_2).toBe("false");
    expect(Object.keys(env).filter((k) => k.startsWith("CONTROL_"))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain("leak-me-please");
  });
  it("without auth set (or after setGitAuth(null)) there is no header, only the two no-redirect entries", () => {
    delete process.env.GIT_CONFIG_COUNT;
    const only = (env: Record<string, string>): void => {
      expect(env.GIT_CONFIG_COUNT).toBe("2");
      expect(env.GIT_CONFIG_KEY_0).toBe(FOLLOW);
      expect(env.GIT_CONFIG_VALUE_0).toBe("false");
      expect(env.GIT_CONFIG_KEY_1).toBe(GENERIC);
      expect(env.GIT_CONFIG_VALUE_1).toBe("false");
      expect(env.GIT_CONFIG_KEY_2).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("extraheader");
    };
    only(G().childEnv());
    G().setGitAuth(TOKEN);
    G().setGitAuth(null);
    only(G().childEnv());
  });
  it("without auth, an inherited GIT_CONFIG_COUNT is kept and the two no-redirect entries go after it", () => {
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "zed";
    process.env.GIT_CONFIG_KEY_1 = "core.abbrev";
    process.env.GIT_CONFIG_VALUE_1 = "9";
    const env = G().childEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_1).toBe("9");
    expect(env.GIT_CONFIG_KEY_2).toBe(FOLLOW);
    expect(env.GIT_CONFIG_VALUE_2).toBe("false");
    expect(env.GIT_CONFIG_KEY_3).toBe(GENERIC);
    expect(env.GIT_CONFIG_VALUE_3).toBe("false");
    expect(env.GIT_CONFIG_KEY_4).toBeUndefined();
  });
  it("with a token on a custom base: the header pair, that base's no-redirect entry, then github.com's and the generic one", () => {
    delete process.env.GIT_CONFIG_COUNT;
    G().setGitAuth(TOKEN, "http://127.0.0.1:9/");
    const env = G().childEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("4");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.http://127.0.0.1:9/.extraheader");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.http://127.0.0.1:9/.followRedirects");
    expect(env.GIT_CONFIG_KEY_2).toBe(FOLLOW);
    expect(env.GIT_CONFIG_KEY_3).toBe(GENERIC);
    for (const i of [1, 2, 3]) expect(env[`GIT_CONFIG_VALUE_${i}`]).toBe("false");
  });
  it("without auth, a CONTROL_* variable still never reaches the child", () => {
    process.env.CONTROL_SECRET_PROBE = "leak-me-please";
    const env = G().childEnv();
    expect(Object.keys(env).filter((k) => k.startsWith("CONTROL_"))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain("leak-me-please");
  });
  it("appends after an existing GIT_CONFIG_COUNT instead of clobbering it", () => {
    process.env.GIT_CONFIG_COUNT = "2";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "zed";
    process.env.GIT_CONFIG_KEY_1 = "core.abbrev";
    process.env.GIT_CONFIG_VALUE_1 = "9";
    G().setGitAuth(TOKEN);
    const env = G().childEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("5");
    expect(env.GIT_CONFIG_KEY_0).toBe("user.name");
    expect(env.GIT_CONFIG_VALUE_1).toBe("9");
    expect(env.GIT_CONFIG_KEY_2).toBe(KEY);
    expect(env.GIT_CONFIG_VALUE_2).toBe(HEADER);
    expect(env.GIT_CONFIG_KEY_3).toBe(FOLLOW);
    expect(env.GIT_CONFIG_VALUE_3).toBe("false");
    expect(env.GIT_CONFIG_KEY_4).toBe(GENERIC);
    expect(env.GIT_CONFIG_VALUE_4).toBe("false");
  });
  it("treats a junk GIT_CONFIG_COUNT as zero", () => {
    process.env.GIT_CONFIG_COUNT = "banana";
    G().setGitAuth(TOKEN);
    const env = G().childEnv();
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe(KEY);
    expect(env.GIT_CONFIG_KEY_1).toBe(FOLLOW);
    expect(env.GIT_CONFIG_KEY_2).toBe(GENERIC);
  });
});

describe("a real git child", () => {
  it("sees the header via `git config --get`, and an inherited setting alongside it", () => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "user.name";
    process.env.GIT_CONFIG_VALUE_0 = "zed";
    G().setGitAuth(TOKEN);
    const r = G().gitTry(tmp(), ["config", "--get", KEY]);
    expect(r.ok).toBe(true);
    expect(r.out.trim()).toBe(HEADER);
    expect(G().gitTry(tmp(), ["config", "--get", "user.name"]).out.trim()).toBe("zed");
  });
  it("opts.env still wins over the auth entries", () => {
    G().setGitAuth(TOKEN);
    const r = G().gitTry(tmp(), ["config", "--get", KEY], { env: { GIT_CONFIG_COUNT: "0" } });
    expect(r.ok).toBe(false);
    expect(r.out.trim()).toBe("");
  });
  it("with no auth set the header is absent", () => {
    delete process.env.GIT_CONFIG_COUNT;
    expect(G().gitTry(tmp(), ["config", "--get", KEY]).ok).toBe(false);
  });
  it("with no auth set every git child still has redirects off (git itself reports false)", () => {
    delete process.env.GIT_CONFIG_COUNT;
    const r = G().gitTry(tmp(), [
      "config",
      "--get-urlmatch",
      GENERIC,
      "https://example.test/x.git",
    ]);
    expect(r.ok).toBe(true);
    expect(r.out.trim()).toBe("false");
    // and gitAnywhere (the clone and origin probes) gets it too
    const any = G().gitAnywhere([
      "config",
      "--get-urlmatch",
      GENERIC,
      "https://example.test/x.git",
    ]);
    expect(any.out.trim()).toBe("false");
  });
  it("the generic entry beats a global followRedirects=true, with or without a token", () => {
    const cfg = path.join(tmp(), "gitconfig");
    fs.writeFileSync(cfg, "[http]\n\tfollowRedirects = true\n");
    process.env.GIT_CONFIG_GLOBAL = cfg;
    delete process.env.GIT_CONFIG_COUNT;
    const url = "https://example.test/x.git";
    expect(G().gitTry(tmp(), ["config", "--get-urlmatch", GENERIC, url]).out.trim()).toBe("false");
    G().setGitAuth(TOKEN);
    expect(G().gitTry(tmp(), ["config", "--get-urlmatch", GENERIC, url]).out.trim()).toBe("false");
  });
  it("a user's URL-scoped followRedirects=true for github.com loses too (the generic entry alone does not beat it)", () => {
    const cfg = path.join(tmp(), "gitconfig");
    fs.writeFileSync(
      cfg,
      '[http "https://github.com/"]\n\tfollowRedirects = true\n[http "https://github.com"]\n\tfollowRedirects = true\n',
    );
    process.env.GIT_CONFIG_GLOBAL = cfg;
    delete process.env.GIT_CONFIG_COUNT;
    const url = "https://github.com/acme/app.git";
    const ask = (): string =>
      G().gitTry(tmp(), ["config", "--get-urlmatch", GENERIC, url]).out.trim();
    expect(ask()).toBe("false"); // no token
    G().setGitAuth(TOKEN);
    expect(ask()).toBe("false"); // with a token
  });
  it("documented limit: a user setting scoped to a MORE SPECIFIC path (https://github.com/acme/) still wins", () => {
    const cfg = path.join(tmp(), "gitconfig");
    fs.writeFileSync(cfg, '[http "https://github.com/acme/"]\n\tfollowRedirects = true\n');
    process.env.GIT_CONFIG_GLOBAL = cfg;
    delete process.env.GIT_CONFIG_COUNT;
    const r = G().gitTry(tmp(), [
      "config",
      "--get-urlmatch",
      GENERIC,
      "https://github.com/acme/app.git",
    ]);
    expect(r.out.trim()).toBe("true"); // the honest limit named in git.ts's doc comment
  });
  it("the token is in no argv, and not in .git/config after init + fetch from a file:// repo", () => {
    shim = installGitShim();
    process.env.PATH = `${shim.dir}${path.delimiter}${SAVED.PATH ?? ""}`;
    Object.assign(process.env, shim.env); // Windows: the exe's log path and real git (empty on POSIX)
    G().setGitAuth(TOKEN);

    const origin = tmp();
    G().git(origin, ["init", "-q", "--initial-branch=main"]);
    fs.writeFileSync(path.join(origin, "a.txt"), "hello\n");
    const id = ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false"];
    G().git(origin, [...id, "add", "-A"]);
    G().git(origin, [...id, "commit", "-q", "-m", "seed"]);

    const clone = tmp();
    G().git(clone, ["init", "-q"]);
    G().git(clone, ["remote", "add", "--", "origin", `file://${origin}`]);
    G().git(clone, [
      "fetch",
      "-q",
      "--end-of-options",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    // and the proof the fetch really ran, with auth in the env of the child:
    expect(G().git(clone, ["rev-parse", "refs/remotes/origin/main"]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );

    expect(shim.argvs().length).toBeGreaterThan(3);
    expect(shim.rawLog()).not.toContain(TOKEN);
    expect(shim.rawLog()).not.toContain(B64);

    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(path.join(clone, ".git"))) {
      const text = fs.readFileSync(f).toString("latin1");
      expect([f, text.includes(TOKEN), text.includes(B64)]).toEqual([f, false, false]);
    }
    expect(fs.readFileSync(path.join(clone, ".git", "config"), "utf8")).not.toMatch(/extraheader/i);
  });
  it("the shim itself works: it records argv and runs the real git", () => {
    shim = installGitShim();
    process.env.PATH = `${shim.dir}${path.delimiter}${SAVED.PATH ?? ""}`;
    Object.assign(process.env, shim.env); // Windows: the exe's log path and real git (empty on POSIX)
    const out = execFileSync("git", ["--version"], { encoding: "utf8", env: { ...process.env } });
    expect(out).toMatch(/^git version/);
    expect(shim.argvs()).toEqual([["--version"]]);
  });
});
