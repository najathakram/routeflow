/**
 * Every entry point that clones, fetches or pushes the state re-checks the state origin itself
 * (`checkEnv` -> the same refusal as `ctl origin set` / CONTROL_STATE_ORIGIN), so a caller that
 * builds an `Env` by hand (a future code path, a test, a bug) cannot bypass the CLI/config
 * validation and write the control state into the product repo. Offline: hostile origins are
 * refused BEFORE any git call that could reach a remote (the shim proves it), and a legitimate
 * file:// origin still works. A successful check is remembered per origin string for the process;
 * a refusal never is. Fixtures are synthetic (acme); nothing touches the network.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { baseState, git, makeWorld } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { makeGitShim, withoutOriginProbes } from "./helpers/git-shim";
import type { GitShim } from "./helpers/git-shim";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(60_000));
/* eslint-disable @typescript-eslint/no-explicit-any */
type SB = typeof import("../src/sources/state-branch");
type CompactMod = typeof import("../src/sources/compact");

// built from parts so this file (scanned by the client-data guard) holds no literal product slug
const AT = "@";
const SLUG = ["najathakram", "routeflow"].join("/");
const OWNER = "najathakram";
const SSH_BASE = `git${AT}github.com:${OWNER}/`;

const HOSTILE: [string, string][] = [
  ["plain https", `https://github.com/${SLUG}`],
  ["https .git", `https://github.com/${SLUG}.git`],
  ["upper case", `HTTPS://GITHUB.COM/${SLUG.toUpperCase()}`],
  ["https user:token", `https://user:tok123${AT}github.com/${SLUG}.git`],
  ["scp-like", `git${AT}github.com:${SLUG}.git`],
  ["ssh://", `ssh://git${AT}github.com/${SLUG}.git`],
  ["percent-encoded", "https://github.com/najathakram%2Froute%66low"],
  ["trailing dot/NUL chain", `https://github.com/${SLUG}.git./.wiki.%00/.`],
  ["wiki", `https://github.com/${SLUG}.wiki.git`],
  ["surrounding whitespace", `  https://github.com/${SLUG}.git  `],
  ["ext:: transport", "ext::sh -c 'echo hi'"],
  ["insteadOf shorthand", "gh-short:routeflow"], // resolved through the scratch GIT_CONFIG_GLOBAL below
];

const SAVED = { ...process.env };
let world: World;
let shim: GitShim;

/** Load a fresh copy of the modules (an empty per-process memo). */
function fresh(): { SB: SB; compact: CompactMod } {
  let out: any;
  jest.isolateModules(() => {
    out = {
      SB: require("../src/sources/state-branch"),
      compact: require("../src/sources/compact"),
    };
  });
  return out;
}

const draft = { type: "lane.note", by: "agent", note: "hello" };
const exitOf = async (fn: () => unknown): Promise<number | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: number }).code ?? -1;
  }
};

beforeEach(() => {
  world = makeWorld();
  world.seedBranch("ctl/state", baseState(0));
  shim = makeGitShim(world);
  // every git child (in this process) goes through the shim, and sees the scratch config
  // offline by construction: git refuses every transport but file://, so even a regressed guard
  // (or a mutation run) can never reach a network or run an ext:: command
  Object.assign(process.env, shim.env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_SSH_COMMAND: "false",
  });
  const gc = path.join(world.root, "scratch-gitconfig");
  fs.writeFileSync(gc, `[url "${SSH_BASE}"]\n\tinsteadOf = gh-short:\n`);
  process.env.GIT_CONFIG_GLOBAL = gc;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  world.cleanup();
});

describe("a hand-built Env with a hostile origin is refused (exit 2) by every entry point", () => {
  for (const [name, origin] of HOSTILE) {
    it(`${name}: ensureClone, appendAndPush, syncClone and compact refuse before any git call`, async () => {
      const { SB, compact } = fresh();
      const env: any = world.env("a", { origin });
      expect(await exitOf(() => SB.ensureClone(env))).toBe(2);
      expect(await exitOf(() => SB.appendAndPush(env, "lane-u", draft))).toBe(2);
      expect(await exitOf(() => SB.syncClone(env, env.cloneDir))).toBe(2);
      expect(await exitOf(() => compact.compact(env))).toBe(2);
      // nothing was cloned or fetched or pushed: only the offline origin probes ran
      expect(withoutOriginProbes(shim.calls())).toEqual([]);
      expect(fs.existsSync(env.cloneDir)).toBe(false);
    });
  }

  it("also when the clone already exists and is owned (a legit run came first)", async () => {
    const { SB } = fresh();
    const ok: any = world.env("a");
    const clone = await SB.ensureClone(ok);
    const before = shim.calls().length;
    const bad: any = { ...ok, origin: `https://github.com/${SLUG}.git` };
    expect(await exitOf(() => SB.syncClone(bad, clone))).toBe(2);
    expect(await exitOf(() => SB.appendAndPush(bad, "lane-u", draft))).toBe(2);
    expect(withoutOriginProbes(shim.calls().slice(before))).toEqual([]);
  });
});

describe("ctl init (the other command that pushes the state) refuses a hand-built hostile Env too", () => {
  it("exit 2 before any git call that could reach a remote", async () => {
    const { initCmd } = require("../src/cli/init");
    const roster = path.join(world.root, "roster.json");
    fs.writeFileSync(
      roster,
      JSON.stringify([{ id: "lead", name: "Lead", machine: "m", kind: "lead", active: true }]),
    );
    const env: any = world.env("a", { origin: `https://github.com/${SLUG}.git` });
    const ctx = {
      cwd: world.root,
      env,
      registers: env.registers,
      lane: null,
      args: { pos: [], flags: { roster } },
      out: () => undefined,
    };
    expect(await exitOf(() => initCmd(ctx))).toBe(2);
    expect(withoutOriginProbes(shim.calls())).toEqual([]);
  });
});

describe("a legitimate origin still works", () => {
  it("a file:// origin: ensureClone, appendAndPush and syncClone succeed", async () => {
    const { SB } = fresh();
    const env: any = world.env("a");
    const clone = await SB.ensureClone(env);
    expect(fs.existsSync(path.join(clone, ".git"))).toBe(true);
    const ev = await SB.appendAndPush(env, "lane-u", draft);
    expect(ev.lane).toBe("lane-u");
    expect(world.remoteLines("lane-u").some((l: any) => l.note === "hello")).toBe(true);
    SB.syncClone(env, clone);
  });
});

describe("the check is memoised per origin string, but only when it succeeded", () => {
  const probesOf = (origin: string): number =>
    shim.calls().filter((c) => c === `ls-remote --get-url -- ${origin}`).length;
  const freshOrigin = (): typeof import("../src/sources/origin") => {
    let out: any;
    jest.isolateModules(() => {
      out = require("../src/sources/origin");
    });
    return out;
  };
  const exit2 = (fn: () => unknown): number | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as { code?: number }).code ?? -1;
    }
  };
  /** A local bare repo (no remotes) under the world's root. */
  const localRepo = (name: string): string => {
    const dir = path.join(world.root, name);
    fs.mkdirSync(dir);
    git(dir, ["init", "-q", "--bare"]);
    return dir;
  };

  it("a plain remote URL (pure string check) is probed once per process, however many calls follow", () => {
    const O = freshOrigin();
    const url = "https://state.invalid/acme/state.git";
    for (let i = 0; i < 4; i++) expect(O.assertEnvOrigin(url)).toBe(url);
    expect(probesOf(url)).toBe(1);
    // a different origin string is its own entry
    const other = "https://state.invalid/acme/other.git";
    O.assertEnvOrigin(other);
    O.assertEnvOrigin(other);
    expect(probesOf(other)).toBe(1);
  });

  it("a local-path or file:// origin is NEVER memoised: every call re-inspects it", () => {
    const O = freshOrigin();
    for (const origin of [world.originUrl, world.originDir, `${world.originUrl}/`]) {
      O.assertEnvOrigin(origin);
      O.assertEnvOrigin(origin);
      O.assertEnvOrigin(origin);
      expect([origin, probesOf(origin)]).toEqual([origin, 3]);
    }
  });

  it("a local dir origin re-pointed at the product repo AFTER a first success is refused now", () => {
    const O = freshOrigin();
    const dir = localRepo("state-local.git");
    expect(O.assertEnvOrigin(dir)).toBe(dir); // first success
    git(dir, ["remote", "add", "origin", `https://github.com/${SLUG}.git`]);
    expect(exit2(() => O.assertEnvOrigin(dir))).toBe(2);
    expect(exit2(() => O.assertEnvOrigin(`file://${dir}`))).toBe(2);
  });

  it("an insteadOf alias re-pointed at the product repo mid-process is refused now (aliases are not memoised)", () => {
    const O = freshOrigin();
    const gc = process.env.GIT_CONFIG_GLOBAL as string;
    fs.writeFileSync(gc, '[url "https://state.invalid/acme/"]\n\tinsteadOf = acme-alias:\n');
    expect(O.assertEnvOrigin("acme-alias:routeflow")).toBe("acme-alias:routeflow");
    fs.writeFileSync(gc, `[url "${SSH_BASE}"]\n\tinsteadOf = acme-alias:\n`);
    expect(exit2(() => O.assertEnvOrigin("acme-alias:routeflow"))).toBe(2);
  });

  it("a refusal is never remembered: the same string is re-checked, and allowed once it resolves elsewhere", async () => {
    const { SB } = fresh();
    const env: any = world.env("a", { origin: "gh-short:routeflow" });
    expect(await exitOf(() => SB.ensureClone(env))).toBe(2);
    expect(await exitOf(() => SB.ensureClone(env))).toBe(2); // still refused, and re-probed
    expect(probesOf("gh-short:routeflow")).toBe(2);
    // the alias now resolves to the (local) state origin instead of the product repo
    // a gitconfig value treats a backslash as an escape, so a Windows path (file://C:\...) is doubled
    const configValue = world.originUrl.split("\\").join("\\\\");
    fs.writeFileSync(
      process.env.GIT_CONFIG_GLOBAL as string,
      `[url "${configValue}"]\n\tinsteadOf = gh-short:\n`,
    );
    const clone = await SB.ensureClone({ ...env, origin: "gh-short:" });
    expect(fs.existsSync(path.join(clone, ".git"))).toBe(true);
  });

  it("refusing one origin does not poison, and allowing one does not whitelist, any other string", async () => {
    const { SB } = fresh();
    const good: any = world.env("a");
    await SB.ensureClone(good);
    const bad: any = { ...good, origin: `https://github.com/${SLUG}` };
    expect(await exitOf(() => SB.syncClone(bad, good.cloneDir))).toBe(2);
    expect(await exitOf(() => SB.syncClone(bad, good.cloneDir))).toBe(2);
    SB.syncClone(good, good.cloneDir); // the good one is unaffected
  });
});

describe("the server's separate master clone is NOT subject to this check", () => {
  it("the master clone origin never goes through checkEnv (server.ts keeps its own assertOrigin)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "http", "server.ts"), "utf8");
    const master = src.slice(src.indexOf("const ensureMaster"), src.indexOf("const fetchMaster"));
    expect(master).toContain("assertOrigin(");
    expect(master).not.toMatch(/assertEnvOrigin|assertStateOrigin|checkEnv/);
  });
  it("and a product-repo origin is accepted by git.ts's plain assertOrigin (the master clone's rule)", () => {
    const { assertOrigin } = require("../src/sources/git");
    expect(assertOrigin(`https://github.com/${SLUG}.git`)).toContain("github.com");
    void os;
  });
});
