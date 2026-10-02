/**
 * Redirect safety for the NO-TOKEN path (the CLI, and any git child the server runs without a
 * token): `http.followRedirects=false` applies to every git child, not only the token-authenticated
 * ones. A GitHub rename alias or transfer redirect must fail loudly (git reports the 302) instead of
 * silently sending a CLI push to a different repo. Two real local servers on separate ports, real
 * git, real `git http-backend`; nothing leaves 127.0.0.1. The token-authenticated twin is
 * test/git-auth-redirect.spec.ts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startSmartHttp } from "./helpers/smart-http";
import type { SmartHttp, SmartHttpOpts } from "./helpers/smart-http";
import { runCli } from "./helpers/spawn-cli";
import { baseState, makeWorld } from "./helpers/temp-repo";
import { IS_WIN, realGitPath, scaled } from "./helpers/platform";
import { installWinFailGit } from "./helpers/win-git-shim";
import type { World } from "./helpers/temp-repo";

jest.setTimeout(scaled(90_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
const G = (): any => require("../src/sources/git");

const SAVED = { ...process.env };
const servers: SmartHttp[] = [];
const tmps: string[] = [];
let world: World | undefined;

const serve = async (opts: SmartHttpOpts = {}): Promise<SmartHttp> => {
  const s = await startSmartHttp(opts);
  servers.push(s);
  return s;
};
const emptyClone = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "git-redirect-nt-"));
  tmps.push(d);
  G().git(d, ["init", "-q"]);
  return d;
};

beforeEach(() => {
  process.env.GIT_ALLOW_PROTOCOL = "file:http:https";
  delete process.env.GIT_CONFIG_COUNT;
  G().setGitAuth(null); // NO token anywhere in this file
});
afterEach(async () => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  world = undefined;
});

describe("without a token a redirect still never leaves the configured host", () => {
  it("git fetch: A answers 302 -> B (another port): git fails with the 302, B sees ZERO requests", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    const clone = emptyClone();
    G().git(clone, ["remote", "add", "--", "origin", a.repoUrl]);
    const r = G().gitTry(clone, [
      "fetch",
      "-q",
      "--no-tags",
      "--end-of-options",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/302/);
    expect(a.seen.length).toBeGreaterThan(0);
    expect(b.seen).toEqual([]);
  });

  it("git clone (gitAnywhere, no cwd): the same, B sees ZERO requests", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "git-redirect-nt-")), "c");
    tmps.push(path.dirname(dir));
    const r = G().gitAnywhere(["clone", "-q", "--", a.repoUrl, dir]);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/302/);
    expect(b.seen).toEqual([]);
  });

  it("the real CLI process: a write (ctl note) against an origin that 302s to B exits 5, B sees ZERO requests", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    world = makeWorld();
    const r = await runCli(world, ["note", "hello"], {
      env: { CONTROL_STATE_ORIGIN: a.repoUrl, GIT_ALLOW_PROTOCOL: "file:http:https" },
    });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: 302/);
    expect(a.seen.length).toBeGreaterThan(0);
    expect(b.seen).toEqual([]);
  });

  it("the real CLI process: the advisory ctl next reports the 302 as UNAVAILABLE (exit 0), B sees ZERO requests", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    world = makeWorld();
    const r = await runCli(world, ["next"], {
      env: { CONTROL_STATE_ORIGIN: a.repoUrl, GIT_ALLOW_PROTOCOL: "file:http:https" },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/UNAVAILABLE.*error: 302/);
    expect(b.seen).toEqual([]);
  });

  it("a normal fetch from the configured server still works with redirects off", async () => {
    const a = await serve();
    const clone = emptyClone();
    G().git(clone, ["remote", "add", "--", "origin", a.repoUrl]);
    const r = G().gitTry(clone, [
      "fetch",
      "-q",
      "--no-tags",
      "--end-of-options",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ]);
    expect(r.err).toBe("");
    expect(r.ok).toBe(true);
    expect(G().git(clone, ["rev-parse", "refs/remotes/origin/main"]).trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });
});

const HINT = "the state repo moved or was renamed; run `ctl origin set <new url>`";

describe("a redirect (renamed or transferred state repo) tells the operator what to do", () => {
  it("clone: the real CLI exits 5 with the 301/302 and the `ctl origin set` hint", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    world = makeWorld();
    const r = await runCli(world, ["note", "hello"], {
      env: { CONTROL_STATE_ORIGIN: a.repoUrl, GIT_ALLOW_PROTOCOL: "file:http:https" },
    });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/clone failed: .*error: 302/);
    expect(r.stderr).toContain(HINT);
    expect(b.seen).toEqual([]);
  });

  it("fetch: git() throws CtlError(5) naming the 302 and the hint", async () => {
    const b = await serve();
    const a = await serve({ redirectTo: b.base });
    const clone = emptyClone();
    G().git(clone, ["remote", "add", "--", "origin", a.repoUrl]);
    let err: any;
    try {
      G().git(clone, ["fetch", "-q", "--end-of-options", "origin", "+refs/heads/main:refs/x"]);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe(5);
    expect(err.message).toMatch(/error: 302/);
    expect(err.message).toContain(HINT);
    expect(b.seen).toEqual([]);
  });

  it("push: a push failure that returned 301 carries the hint (git shimmed to fail the push that way)", async () => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(0));
    const dir = path.join(world.root, "push-shim");
    fs.mkdirSync(dir);
    const FAIL = "fatal: unable to access the repo: The requested URL returned error: 301";
    // POSIX: an sh `git` first on PATH. Windows cannot run that as `git`; its exe twin does the same.
    let shimEnv: Record<string, string> = {};
    if (IS_WIN) {
      shimEnv = installWinFailGit(dir, "push", FAIL);
    } else {
      const real = realGitPath();
      fs.writeFileSync(
        path.join(dir, "git"),
        [
          "#!/bin/sh",
          'for a in "$@"; do',
          '  if [ "$a" = push ]; then',
          `    echo '${FAIL}' >&2`,
          "    exit 1",
          "  fi",
          "done",
          `exec '${real}' "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    }
    const r = await runCli(world, ["note", "hello"], {
      env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, ...shimEnv },
    });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/returned error: 301/);
    expect(r.stderr).toContain(HINT);
  });

  it.each([
    ["301", true],
    ["302", true],
    ["307", true],
    ["308", true],
    ["403", false],
    ["404", false],
    ["500", false],
  ])("withMovedHint: `returned error: %s` -> hint %s", (code, hinted) => {
    const msg = `git fetch failed: fatal: The requested URL returned error: ${code}`;
    const out: string = G().withMovedHint(msg);
    expect(out.includes(HINT)).toBe(hinted);
    if (hinted) {
      // first line: the label, the code and the hint; git's own message is kept below it
      expect(out.split("\n")[0]).toBe(`git fetch failed: returned error: ${code} (hint: ${HINT})`);
      expect(out.endsWith(`\n${msg}`)).toBe(true);
    } else {
      expect(out).toBe(msg);
    }
  });
});
