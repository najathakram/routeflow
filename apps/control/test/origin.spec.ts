/**
 * B938: the state remote is configurable (default none) and every resolved origin is refused when it
 * points at the product repo itself (that repo goes public during CI windows). Covers the refuse /
 * allow URL matrix, redaction, resolution order, the `ctl origin` verbs and the NONE behaviour of
 * `next`, `next --hook` and a write verb. All fixtures are synthetic: `acme`, file:// bare repos
 * under the OS temp dir; nothing here touches the network.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  NO_STATE_REMOTE,
  assertStateOrigin,
  isRouteflowOrigin,
  redactUrl,
  removeOriginFile,
  resolveStateOrigin,
  writeOriginFile,
} from "../src/sources/origin";
import { CtlError } from "../src/sources/git";
import { makeWorld, baseState, git } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { makeGitShim, withoutOriginProbes } from "./helpers/git-shim";
import { runCli } from "./helpers/spawn-cli";
import { expectMode, scaled } from "./helpers/platform";

jest.setTimeout(scaled(30_000));

// built from parts so this file (scanned by the client-data guard) never holds a literal
// `user:token@host` or `git@host` shape
const AT = "@";
const SLUG = ["najathakram", "routeflow"].join("/");
const U = SLUG.toUpperCase();

const REFUSE: [string, string][] = [
  ["https", `https://github.com/${SLUG}`],
  ["https .git", `https://github.com/${SLUG}.git`],
  ["https .git/", `https://github.com/${SLUG}.git/`],
  ["https trailing slash", `https://github.com/${SLUG}/`],
  ["https many trailing slashes", `https://github.com/${SLUG}///`],
  ["http", `http://github.com/${SLUG}.git`],
  ["https user:token", `https://user:tok123${AT}github.com/${SLUG}.git`],
  ["https user only", `https://user${AT}github.com/${SLUG}`],
  ["https www host", `https://www.github.com/${SLUG}`],
  ["https explicit port", `https://github.com:443/${SLUG}.git`],
  ["https other host", `https://git.example.test/${SLUG}`],
  ["scp-like", `git${AT}github.com:${SLUG}.git`],
  ["scp-like no .git", `git${AT}github.com:${SLUG}`],
  ["scp-like trailing slash", `git${AT}github.com:${SLUG}.git/`],
  ["scp-like ssh host alias", `git${AT}some-alias:${SLUG}.git`],
  ["scp-like alias no user", `some-alias:${SLUG}`],
  ["ssh://", `ssh://git${AT}github.com/${SLUG}.git`],
  ["ssh:// with port 22", `ssh://git${AT}github.com:22/${SLUG}.git`],
  ["ssh:// ssh.github.com:443", `ssh://git${AT}ssh.github.com:443/${SLUG}.git`],
  ["git+ssh://", `git+ssh://git${AT}github.com/${SLUG}.git`],
  ["git://", `git://github.com/${SLUG}.git`],
  ["mixed case", "https://github.com/NajathAkram/RouteFlow.git"],
  ["upper case", `HTTPS://GITHUB.COM/${U}`],
  ["upper case .GIT", `https://github.com/${SLUG}.GIT`],
  ["percent-encoded slash and letter", "https://github.com/najathakram%2Froute%66low"],
  ["fully percent-encoded", "https://github.com/%6Eajathakram/%72outeflow.git"],
  ["double percent-encoded", "https://github.com/najathakram%252Frouteflow"],
  ["query string", `https://github.com/${SLUG}.git?x=1`],
  ["fragment", `https://github.com/${SLUG}#main`],
  ["repeated .git", `https://github.com/${SLUG}.git.git`],
  ["dot segment", "https://github.com/najathakram/./routeflow"],
  ["dot-dot segment", "https://github.com/najathakram/other/../routeflow"],
  ["double slash inside", "https://github.com/najathakram//routeflow"],
  ["backslash separator", "https://github.com/najathakram\\routeflow"],
  ["surrounding whitespace", `  https://github.com/${SLUG}.git  `],
  ["trailing newline", `https://github.com/${SLUG}.git\n`],
  ["wiki .wiki.git", `https://github.com/${SLUG}.wiki.git`],
  ["wiki scp-like", `git${AT}github.com:${SLUG}.wiki.git`],
  ["wiki .wiki", `https://github.com/${SLUG}.wiki`],
  ["wiki .git.wiki", `https://github.com/${SLUG}.git.wiki`],
  ["wiki repeated", `https://github.com/${SLUG}.wiki.wiki.git/`],
  ["https /.git", `https://github.com/${SLUG}/.git`],
  ["https /.git/", `https://github.com/${SLUG}/.git/`],
  ["alias /.git", `alias:${SLUG}/.git`],
  ["/.git/.git", `https://github.com/${SLUG}/.git/.git`],
  ["space before owner", `weird transport ${SLUG}`],
  // a trailing "." (config.ts refuses it for CONTROL_STATE_REPO) and control characters, in any
  // mix with `/`, `.git` and `.wiki`; a percent-encoded `.` or NUL decodes to the same thing
  ["trailing dot", `https://github.com/${SLUG}.`],
  ["trailing dots", `https://github.com/${SLUG}...`],
  ["trailing .git.", `https://github.com/${SLUG}.git.`],
  ["trailing .git..", `https://github.com/${SLUG}.git..`],
  ["trailing %00", `https://github.com/${SLUG}%00`],
  ["trailing .git%00", `https://github.com/${SLUG}.git%00`],
  ["trailing %2e", `https://github.com/${SLUG}%2e`],
  ["trailing .git%2e", `https://github.com/${SLUG}.git%2E`],
  ["trailing %252e (double encoded)", `https://github.com/${SLUG}%252e`],
  ["trailing %00 then slash", `https://github.com/${SLUG}%00/`],
  ["trailing control char (%01, %1f, %7f)", `https://github.com/${SLUG}%01%1f%7f`],
  ["trailing %00 after a dot after .git", `https://github.com/${SLUG}.git.%00`],
  [
    "mixed chain of dots, NULs, slashes and suffixes",
    `https://github.com/${SLUG}.git./.wiki.%00/.`,
  ],
  ["scp-like trailing dot", `git${AT}github.com:${SLUG}.`],
  ["scp-like .git.", `git${AT}github.com:${SLUG}.git.`],
  ["wiki trailing dot", `https://github.com/${SLUG}.wiki.`],
];

const ALLOW: [string, string][] = [
  ["control-state sibling", "https://github.com/najathakram/routeflow-control-state"],
  ["control-state sibling .git", "https://github.com/najathakram/routeflow-control-state.git"],
  ["routeflow2", "https://github.com/najathakram/routeflow2"],
  ["routeflow2 scp-like", `git${AT}github.com:najathakram/routeflow2.git`],
  ["other owner", "https://github.com/other/routeflow"],
  ["other owner scp-like", `git${AT}github.com:other/routeflow.git`],
  ["prefixed repo name", "https://github.com/najathakram/my-routeflow"],
  ["owner prefix", "https://github.com/xnajathakram/routeflow"],
  ["owner suffix", "https://github.com/najathakram-org/routeflow"],
  ["pages repo", "https://github.com/najathakram/routeflow.github.io"],
  ["trailing dash", "https://github.com/najathakram/routeflow-"],
  ["owner only in host", "https://najathakram.example.test/routeflow"],
  ["owner only in userinfo", `https://najathakram${AT}git.example.test/acme/state`],
  ["acme state repo", `git${AT}github.com:acme/state.git`],
  ["acme https", "https://github.com/acme/ctl-state.git"],
  ["file URL", "file:///tmp/x/routeflow-state.git"],
  ["file URL acme", "file:///tmp/does-not-exist-acme/state.git"],
  ["absolute path", "/tmp/does-not-exist-acme/state.git"],
  ["relative path", "../does-not-exist-acme/state.git"],
  ["owner look-alike (dash prefix)", "https://github.com/my-najathakram/routeflow"],
  ["owner look-alike (bare)", "xnajathakram/routeflow"],
  ["owner look-alike scp-like", `git${AT}github.com:my-najathakram/routeflow.git`],
  ["wiki of a sibling", `git${AT}github.com:najathakram/routeflow-control-state.wiki.git`],
  ["routeflow-wiki repo", "https://github.com/najathakram/routeflow-wiki"],
  ["sibling with a trailing dot", "https://github.com/najathakram/routeflow-control-state."],
  ["sibling .git. with a trailing %00", "https://github.com/najathakram/routeflow2.git.%00"],
  ["pages repo with a trailing dot", "https://github.com/najathakram/routeflow.github.io."],
  ["owner look-alike with a trailing dot", "https://github.com/my-najathakram/routeflow."],
];

describe("isRouteflowOrigin: refuse matrix (string forms)", () => {
  it("has at least 40 table cases", () => {
    expect(REFUSE.length + ALLOW.length).toBeGreaterThanOrEqual(40);
  });
  it.each(REFUSE)("refuses %s", (_label, url) => {
    expect(isRouteflowOrigin(url)).toBe(true);
  });
  it.each(ALLOW)("allows %s", (_label, url) => {
    expect(isRouteflowOrigin(url)).toBe(false);
  });
});

const TRANSPORTS: [string, string][] = [
  ["ext:: with the slug", `ext::ssh git${AT}github.com %S ${SLUG}.git`],
  ["ext:: with the slug, quoted", `ext::ssh git${AT}github.com %S '${SLUG}'`],
  ["ext:: with an unrelated command", "ext::sh -c true"],
  ["fd::", "fd::7"],
  ["EXT:: upper case", `EXT::ssh git${AT}github.com %S ${SLUG}.git`],
  ["leading space", ` ext::sh -c true`],
];

describe("assertStateOrigin refuses the ext:: and fd:: transports outright", () => {
  it.each(TRANSPORTS)("exit 2 for %s", (_label, url) => {
    expect.assertions(3);
    try {
      assertStateOrigin(url);
    } catch (e) {
      expect(e).toBeInstanceOf(CtlError);
      expect((e as CtlError).code).toBe(2);
      expect((e as CtlError).message).toMatch(/transports are not allowed/);
    }
  });
});

describe("assertStateOrigin", () => {
  it.each(REFUSE)("throws exit 2 for %s", (_label, url) => {
    expect.assertions(3);
    try {
      assertStateOrigin(url);
    } catch (e) {
      expect(e).toBeInstanceOf(CtlError);
      expect((e as CtlError).code).toBe(2);
      expect((e as CtlError).message).toMatch(
        /^refusing state remote .*: the state must not live in /,
      );
    }
  });
  it.each(ALLOW)("returns %s unchanged (trimmed)", (_label, url) => {
    expect(assertStateOrigin(url)).toBe(url.trim());
  });
  it("the refusal message names the reason and carries no credentials", () => {
    const url = `https://user:tok-secret-9${AT}github.com/${SLUG}.git`;
    let msg = "";
    try {
      assertStateOrigin(url);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      `refusing state remote https://github.com/${SLUG}.git: the state must not live in ${SLUG} (the repo goes public during CI windows)`,
    );
    expect(msg).not.toContain("tok-secret-9");
    expect(msg).not.toContain("user:");
  });
  it("the refusal message carries no query string or fragment secret", () => {
    for (const tail of ["?token=SECRET-q-1", "#SECRET-q-1", ".git?a=1&token=SECRET-q-1"]) {
      let msg = "";
      try {
        assertStateOrigin(`https://github.com/${SLUG}${tail}`);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/^refusing state remote /);
      expect(msg).not.toContain("SECRET-q-1");
    }
  });
  it("rejects empty, option-like and NUL origins with exit 2", () => {
    for (const bad of ["", "   ", "--upload-pack=x", "file:///tmp/a\0b"]) {
      expect(() => assertStateOrigin(bad)).toThrow(CtlError);
    }
  });
});

describe("assertStateOrigin: a local repo whose remotes point at the product repo", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-origin-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const repoWith = (name: string, config: [string, string][], bare = false): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, ["init", "-q", ...(bare ? ["--bare"] : [])]);
    for (const [k, v] of config) git(dir, ["config", k, v]);
    return dir;
  };
  const code = (url: string): number | null => {
    try {
      assertStateOrigin(url);
      return null;
    } catch (e) {
      return e instanceof CtlError ? e.code : -1;
    }
  };

  it("refuses a path (and its file:// form) whose origin remote is the product repo", () => {
    const dir = repoWith("work", [["remote.origin.url", `https://github.com/${SLUG}.git`]]);
    expect(code(dir)).toBe(2);
    expect(code(`file://${dir}`)).toBe(2);
  });
  it("refuses a bare repo and any remote name, and a push URL", () => {
    const bare = repoWith(
      "bare.git",
      [["remote.upstream.url", `git${AT}github.com:${SLUG}.git`]],
      true,
    );
    expect(code(bare)).toBe(2);
    const pushOnly = repoWith("pushy", [
      ["remote.origin.url", "https://github.com/acme/state.git"],
      ["remote.origin.pushurl", `https://github.com/${SLUG}`],
    ]);
    expect(code(pushOnly)).toBe(2);
  });
  it("refuses when ANY of several remotes matches", () => {
    const dir = repoWith("multi", [
      ["remote.a.url", "https://github.com/acme/state.git"],
      ["remote.b.url", "https://github.com/acme/other.git"],
      ["remote.c.url", `https://github.com/${SLUG}.git`],
    ]);
    expect(code(dir)).toBe(2);
  });
  it("allows a repo whose remotes are look-alikes, a repo with no remote, a non-repo dir, a missing path", () => {
    const ok = repoWith("ok", [
      ["remote.origin.url", "https://github.com/najathakram/routeflow-control-state.git"],
    ]);
    expect(code(ok)).toBeNull();
    expect(code(repoWith("none", []))).toBeNull();
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(code(plain)).toBeNull();
    expect(code(path.join(root, "missing"))).toBeNull();
    expect(code(`file://${path.join(root, "missing")}`)).toBeNull();
  });
});

/** Run `fn` with GIT_CONFIG_GLOBAL pointing at a scratch config (never the real ~/.gitconfig). */
function withGlobalConfig<T>(dir: string, text: string, fn: () => T): T {
  const file = path.join(dir, "scratch-gitconfig");
  fs.writeFileSync(file, text);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }
}
const codeOf = (url: string): number | null => {
  try {
    assertStateOrigin(url);
    return null;
  } catch (e) {
    return e instanceof CtlError ? e.code : -1;
  }
};
const FORBIDDEN_BASE = `https://github.com/${["najathakram", ""].join("/")}`;
const ssh = (owner: string): string => `git${AT}github.com:${owner}/`;

describe("assertStateOrigin resolves the origin through git config (insteadOf / pushInsteadOf)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-origin-gc-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const gc = (text: string, url: string): number | null =>
    withGlobalConfig(root, text, () => codeOf(url));

  it("refuses an alias whose url.<base>.insteadOf resolves to the product repo", () => {
    const cfg = `[url "${ssh("najathakram")}"]\n\tinsteadOf = gh:\n`;
    expect(gc(cfg, "gh:routeflow")).toBe(2);
    expect(gc(cfg, "gh:routeflow.git")).toBe(2);
    expect(gc(cfg, "gh:routeflow.wiki.git")).toBe(2);
  });
  it("refuses an https-base insteadOf too, and allows an alias that resolves elsewhere", () => {
    const cfg = `[url "${FORBIDDEN_BASE}"]\n\tinsteadOf = acme-gh/\n[url "${ssh("acme")}"]\n\tinsteadOf = acme:\n`;
    expect(gc(cfg, "acme-gh/routeflow")).toBe(2);
    expect(gc(cfg, "acme:state")).toBeNull();
    expect(gc(cfg, "acme:routeflow")).toBeNull();
  });
  it("refuses when url.<base>.pushInsteadOf rewrites the push URL to the product repo", () => {
    const cfg = `[url "${ssh("najathakram")}"]\n\tpushInsteadOf = https://push.example.test/\n`;
    expect(gc(cfg, "https://push.example.test/routeflow")).toBe(2);
    expect(gc(cfg, "https://push.example.test/state")).toBeNull(); // -> a different repo under the same owner
  });
  it("pushInsteadOf uses the LONGEST matching prefix, like git", () => {
    // `gh2:sub/` alone would rewrite to the product repo; the longer `gh2:sub/r` wins and does not
    const short = `[url "${ssh("najathakram")}"]\n\tpushInsteadOf = gh2:sub/\n`;
    const long = `[url "${ssh("acme")}"]\n\tpushInsteadOf = gh2:sub/r\n`;
    expect(gc(short + long, "gh2:sub/routeflow")).toBeNull();
    expect(gc(long + short, "gh2:sub/routeflow")).toBeNull();
    expect(gc(short, "gh2:sub/routeflow")).toBe(2);
    expect(gc(short + long, "gh2:sub/state")).toBeNull();
  });
  it("a git that cannot be run falls back to the string check without crashing", () => {
    const prev = process.env.PATH;
    process.env.PATH = path.join(root, "no-such-bin");
    try {
      expect(codeOf("file:///tmp/does-not-exist-acme/state.git")).toBeNull();
      expect(codeOf(`https://github.com/${SLUG}.git`)).toBe(2);
    } finally {
      process.env.PATH = prev;
    }
  });
  it("`ctl origin set` and a write verb refuse an alias that resolves to the product repo", async () => {
    const world = makeWorld();
    try {
      const gcFile = path.join(world.root, "gc");
      fs.writeFileSync(gcFile, `[url "${ssh("najathakram")}"]\n\tinsteadOf = gh:\n`);
      const cfg = path.join(world.root, "cfg");
      const env = { CONTROL_STATE_ORIGIN: "", CONTROL_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: gcFile };
      const set = await runCli(world, ["origin", "set", "gh:routeflow"], { env });
      expect(set.code).toBe(2);
      expect(set.stderr).toMatch(/refusing state remote gh:routeflow/);
      expect(fs.existsSync(path.join(cfg, "origin"))).toBe(false);
      const note = await runCli(world, ["note", "x", "--origin", "gh:routeflow"], { env });
      expect(note.code).toBe(2);
    } finally {
      world.cleanup();
    }
  });
});

describe("assertStateOrigin: every remote git resolves in a local repo, recursively", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-origin-lr-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const BAD = `https://github.com/${SLUG}.git`;
  const repo = (name: string): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    git(dir, ["init", "-q"]);
    return dir;
  };
  const commit = (dir: string): void => {
    git(dir, ["commit", "-q", "--allow-empty", "-m", "c"]);
  };

  it("refuses a repo-local url.<base>.insteadOf that rewrites a remote to the product repo", () => {
    const dir = repo("io");
    git(dir, ["config", `url.${FORBIDDEN_BASE}.insteadOf`, "acme:"]);
    git(dir, ["config", "remote.origin.url", "acme:routeflow"]);
    expect(codeOf(dir)).toBe(2);
    expect(codeOf(`file://${dir}`)).toBe(2);
  });
  it("refuses a repo-local pushInsteadOf that rewrites the push URL", () => {
    const dir = repo("pio");
    git(dir, ["config", `url.${FORBIDDEN_BASE}.pushInsteadOf`, "acme:"]);
    git(dir, ["config", "remote.origin.url", "acme:routeflow"]);
    expect(codeOf(dir)).toBe(2);
  });
  it("refuses a remote that comes from an include.path file", () => {
    const dir = repo("inc");
    const extra = path.join(root, "extra.cfg");
    fs.writeFileSync(extra, `[remote "inc"]\n\turl = ${BAD}\n`);
    git(dir, ["config", "include.path", extra]);
    expect(codeOf(dir)).toBe(2);
  });
  it("refuses a remote that lives in config.worktree of a linked worktree", () => {
    const main = repo("main");
    commit(main);
    git(main, ["config", "extensions.worktreeConfig", "true"]);
    const wt = path.join(root, "wt");
    git(main, ["worktree", "add", "-q", wt]);
    git(wt, ["config", "--worktree", "remote.wtremote.url", BAD]);
    expect(codeOf(wt)).toBe(2);
    expect(codeOf(main)).toBeNull(); // the main checkout does not see it
  });
  it("refuses a legacy .git/remotes/<name> file", () => {
    const dir = repo("legacy");
    fs.mkdirSync(path.join(dir, ".git", "remotes"));
    fs.writeFileSync(path.join(dir, ".git", "remotes", "leg"), `URL: ${BAD}\n`);
    expect(codeOf(dir)).toBe(2);
  });
  it("refuses a legacy .git/branches/<name> file", () => {
    const dir = repo("legacy-br");
    fs.mkdirSync(path.join(dir, ".git", "branches"));
    fs.writeFileSync(path.join(dir, ".git", "branches", "brn"), `${BAD}\n`);
    expect(codeOf(dir)).toBe(2);
  });
  it("refuses a clone of a local clone of the product repo (two levels)", () => {
    const a = repo("a");
    git(a, ["config", "remote.origin.url", BAD]);
    const b = path.join(root, "b");
    git(root, ["clone", "-q", a, b]);
    const c = path.join(root, "c");
    git(root, ["clone", "-q", b, c]);
    expect(codeOf(c)).toBe(2);
    expect(codeOf(`file://${c}`)).toBe(2);
    expect(codeOf(b)).toBe(2);
  });
  it("allows a clone chain whose root is harmless, and survives a remote cycle", () => {
    const a = repo("a");
    git(a, ["config", "remote.origin.url", "https://github.com/acme/state.git"]);
    const b = path.join(root, "b");
    git(root, ["clone", "-q", a, b]);
    expect(codeOf(b)).toBeNull();
    const x = repo("x");
    const y = repo("y");
    git(x, ["remote", "add", "peer", y]);
    git(y, ["remote", "add", "peer", x]);
    expect(codeOf(x)).toBeNull();
  });
});

describe("redactUrl", () => {
  it.each([
    [
      `https://user:tok123${AT}host.example.test/acme/state.git`,
      "https://host.example.test/acme/state.git",
    ],
    [
      `https://tok123${AT}host.example.test/acme/state.git`,
      "https://host.example.test/acme/state.git",
    ],
    [
      `ssh://git${AT}host.example.test:22/acme/state.git`,
      "ssh://host.example.test:22/acme/state.git",
    ],
    [`git${AT}host.example.test:acme/state.git`, `git${AT}host.example.test:acme/state.git`],
    [
      `user:tok123${AT}host.example.test:acme/state.git`,
      `user${AT}host.example.test:acme/state.git`,
    ],
    ["file:///tmp/acme/state.git", "file:///tmp/acme/state.git"],
    ["/tmp/acme/state.git", "/tmp/acme/state.git"],
    [
      "https://host.example.test/acme/state.git?token=tok123",
      "https://host.example.test/acme/state.git?<redacted>",
    ],
    [
      "https://host.example.test/acme/state.git#tok123",
      "https://host.example.test/acme/state.git?<redacted>",
    ],
    [
      `https://u:p${AT}host.example.test/acme/s.git?a=1&token=tok123#tok123`,
      "https://host.example.test/acme/s.git?<redacted>",
    ],
    [
      `git${AT}host.example.test:acme/s.git?token=tok123`,
      `git${AT}host.example.test:acme/s.git?<redacted>`,
    ],
    ["/tmp/acme/s.git?token=tok123", "/tmp/acme/s.git?<redacted>"],
  ])("%s -> %s", (input, want) => {
    const out = redactUrl(input);
    expect(out).toBe(want);
    expect(out).not.toContain("tok123");
  });
});

describe("resolveStateOrigin: env beats file beats none", () => {
  let cfg: string;
  beforeEach(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-cfg-"));
  });
  afterEach(() => fs.rmSync(cfg, { recursive: true, force: true }));
  const ENV_URL = "file:///tmp/acme-env/state.git";
  const FILE_URL = "file:///tmp/acme-file/state.git";
  const FLAG_URL = "file:///tmp/acme-flag/state.git";
  const writeFile = (text: string): void => fs.writeFileSync(path.join(cfg, "origin"), text);

  it("none when neither is set", () => {
    expect(resolveStateOrigin({ env: { CONTROL_CONFIG_DIR: cfg } })).toEqual({
      origin: null,
      source: "none",
    });
  });
  it("file: first non-empty, non-# line, trimmed", () => {
    writeFile(`\n# a comment\n   \n  ${FILE_URL}  \nfile:///tmp/second\n`);
    expect(resolveStateOrigin({ env: { CONTROL_CONFIG_DIR: cfg } })).toEqual({
      origin: FILE_URL,
      source: "file",
    });
  });
  it("a file with only comments and blanks is none", () => {
    writeFile("# nothing\n\n");
    expect(resolveStateOrigin({ env: { CONTROL_CONFIG_DIR: cfg } }).source).toBe("none");
  });
  it("env beats the file", () => {
    writeFile(FILE_URL + "\n");
    expect(
      resolveStateOrigin({ env: { CONTROL_CONFIG_DIR: cfg, CONTROL_STATE_ORIGIN: ENV_URL } }),
    ).toEqual({ origin: ENV_URL, source: "env" });
  });
  it("an empty env value falls through to the file", () => {
    writeFile(FILE_URL + "\n");
    expect(
      resolveStateOrigin({ env: { CONTROL_CONFIG_DIR: cfg, CONTROL_STATE_ORIGIN: "" } }).source,
    ).toBe("file");
  });
  it("the --origin flag beats env and file", () => {
    writeFile(FILE_URL + "\n");
    expect(
      resolveStateOrigin({
        flag: FLAG_URL,
        env: { CONTROL_CONFIG_DIR: cfg, CONTROL_STATE_ORIGIN: ENV_URL },
      }),
    ).toEqual({ origin: FLAG_URL, source: "flag" });
  });
  it("every source goes through the refusal rule", () => {
    const bad = `https://github.com/${SLUG}.git`;
    writeFile(bad + "\n");
    const refuse = (o: Parameters<typeof resolveStateOrigin>[0]) => {
      try {
        resolveStateOrigin(o);
        return null;
      } catch (e) {
        return (e as CtlError).code;
      }
    };
    expect(refuse({ env: { CONTROL_CONFIG_DIR: cfg } })).toBe(2);
    expect(refuse({ env: { CONTROL_CONFIG_DIR: cfg, CONTROL_STATE_ORIGIN: bad } })).toBe(2);
    expect(refuse({ flag: bad, env: { CONTROL_CONFIG_DIR: cfg } })).toBe(2);
  });
  it("falls back to XDG_CONFIG_HOME/routeflow-control/origin when CONTROL_CONFIG_DIR is unset", () => {
    fs.mkdirSync(path.join(cfg, "routeflow-control"));
    fs.writeFileSync(path.join(cfg, "routeflow-control", "origin"), FILE_URL + "\n");
    expect(resolveStateOrigin({ env: { XDG_CONFIG_HOME: cfg } })).toEqual({
      origin: FILE_URL,
      source: "file",
    });
  });
  it("NO_STATE_REMOTE names the fix", () => {
    expect(NO_STATE_REMOTE).toBe("no state remote configured — run `ctl origin set <url>`");
  });
});

describe("origin config file: mode, modes, remove", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-cfg-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes the file 0600 in a 0700 directory it creates (mkdir -p)", () => {
    const dir = path.join(root, "deep", "routeflow-control");
    const file = writeOriginFile("file:///tmp/acme/state.git", { CONTROL_CONFIG_DIR: dir });
    expect(file).toBe(path.join(dir, "origin"));
    expectMode(file, 0o600);
    expectMode(dir, 0o700);
    expect(resolveStateOrigin({ env: { CONTROL_CONFIG_DIR: dir } }).origin).toBe(
      "file:///tmp/acme/state.git",
    );
  });
  it("rewriting keeps 0600 and replaces the value", () => {
    const env = { CONTROL_CONFIG_DIR: path.join(root, "c") };
    writeOriginFile("file:///tmp/acme/one.git", env);
    const file = writeOriginFile("file:///tmp/acme/two.git", env);
    expectMode(file, 0o600);
    expect(resolveStateOrigin({ env }).origin).toBe("file:///tmp/acme/two.git");
  });
  it("refuses to write the product repo and writes nothing", () => {
    const env = { CONTROL_CONFIG_DIR: path.join(root, "c") };
    expect(() => writeOriginFile(`https://github.com/${SLUG}.git`, env)).toThrow(CtlError);
    expect(fs.existsSync(path.join(root, "c"))).toBe(false);
  });
  it("removeOriginFile reports whether it removed a file", () => {
    const env = { CONTROL_CONFIG_DIR: path.join(root, "c") };
    expect(removeOriginFile(env)).toBe(false);
    writeOriginFile("file:///tmp/acme/state.git", env);
    expect(removeOriginFile(env)).toBe(true);
    expect(resolveStateOrigin({ env }).source).toBe("none");
  });
});

describe("ctl origin set | show | unset (CLI, never the network)", () => {
  let world: World;
  let cfg: string;
  beforeEach(() => {
    world = makeWorld();
    cfg = path.join(world.root, "cfg", "routeflow-control");
  });
  afterEach(() => world.cleanup());
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    CONTROL_STATE_ORIGIN: "",
    CONTROL_CONFIG_DIR: cfg,
    ...extra,
  });

  it("set writes the file, prints the redacted URL, never echoes the token", async () => {
    const url = `https://user:tok-cli-77${AT}host.example.test/acme/state.git`;
    const r = await runCli(world, ["origin", "set", url], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("state remote set: https://host.example.test/acme/state.git\n");
    expect(r.stdout + r.stderr).not.toContain("tok-cli-77");
    expectMode(path.join(cfg, "origin"), 0o600);
  });
  it("set refuses the product repo (exit 2), writes nothing", async () => {
    const r = await runCli(world, ["origin", "set", `git${AT}github.com:${SLUG}.git`], {
      env: env(),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/refusing state remote/);
    expect(fs.existsSync(path.join(cfg, "origin"))).toBe(false);
  });
  it.each([
    ["a trailing dot", `https://github.com/${SLUG}.`],
    ["a trailing .git.", `https://github.com/${SLUG}.git.`],
    ["a trailing %00", `https://github.com/${SLUG}%00`],
  ])("set refuses the product repo spelled with %s (exit 2), writes nothing", async (_l, url) => {
    const r = await runCli(world, ["origin", "set", url], { env: env() });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/refusing state remote/);
    expect(fs.existsSync(path.join(cfg, "origin"))).toBe(false);
  });
  it("set without a URL, an unknown subcommand and extra args exit 2", async () => {
    expect((await runCli(world, ["origin", "set"], { env: env() })).code).toBe(2);
    expect((await runCli(world, ["origin", "bogus"], { env: env() })).code).toBe(2);
    expect((await runCli(world, ["origin", "set", "a", "b"], { env: env() })).code).toBe(2);
  });
  it("show reports the source: none, file, then env (env wins)", async () => {
    const none = await runCli(world, ["origin"], { env: env() });
    expect(none.code).toBe(0);
    expect(none.stdout).toBe("no state remote configured (source: none)\n");

    await runCli(world, ["origin", "set", world.originUrl], { env: env() });
    const file = await runCli(world, ["origin"], { env: env() });
    expect(file.stdout).toBe(`state remote: ${world.originUrl} (source: file)\n`);

    const viaEnv = await runCli(world, ["origin"], {
      env: env({ CONTROL_STATE_ORIGIN: "file:///tmp/acme-env/state.git" }),
    });
    expect(viaEnv.stdout).toBe("state remote: file:///tmp/acme-env/state.git (source: env)\n");
  });
  it("show redacts a token in an env origin", async () => {
    const r = await runCli(world, ["origin"], {
      env: env({ CONTROL_STATE_ORIGIN: `https://u:tok-show-3${AT}host.example.test/acme/s.git` }),
    });
    expect(r.stdout).toBe("state remote: https://host.example.test/acme/s.git (source: env)\n");
  });
  it("unset removes the file; unsetting again is fine", async () => {
    await runCli(world, ["origin", "set", world.originUrl], { env: env() });
    const r = await runCli(world, ["origin", "unset"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("state remote unset\n");
    expect(fs.existsSync(path.join(cfg, "origin"))).toBe(false);
    expect((await runCli(world, ["origin", "unset"], { env: env() })).code).toBe(0);
  });
  it("the three verbs never touch a network (only offline origin-resolution probes)", async () => {
    const shim = makeGitShim(world);
    const e = env(shim.env);
    const u = "https://host.example.test/acme/state.git";
    expect((await runCli(world, ["origin", "set", u], { env: e, lane: "lead" })).code).toBe(0);
    expect((await runCli(world, ["origin"], { env: e, lane: "lead" })).code).toBe(0);
    expect((await runCli(world, ["origin", "unset"], { env: e, lane: "lead" })).code).toBe(0);
    expect(withoutOriginProbes(shim.calls())).toEqual([]);
  });
});

describe("NONE: no state remote configured", () => {
  let world: World;
  let cfg: string;
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(2));
    cfg = path.join(world.root, "empty-cfg");
    fs.mkdirSync(cfg);
  });
  afterEach(() => world.cleanup());
  const none = (): Record<string, string> => ({
    CONTROL_STATE_ORIGIN: "",
    CONTROL_CONFIG_DIR: cfg,
  });

  it("`next` prints exactly one line and exits 0", async () => {
    const r = await runCli(world, ["next"], { env: none() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("control: no state remote configured — run `ctl origin set <url>`\n");
  });
  it("`next --quiet` still prints the line; `next --hook` prints nothing", async () => {
    const q = await runCli(world, ["next", "--quiet"], { env: none() });
    expect(q.code).toBe(0);
    expect(q.stdout).toBe("control: no state remote configured — run `ctl origin set <url>`\n");
    const h = await runCli(world, ["next", "--hook"], { env: none() });
    expect(h.code).toBe(0);
    expect(h.stdout).toBe("");
    expect(h.stderr).toBe("");
  });
  it("a write verb exits 2 with the same message and pushes nothing", async () => {
    const tip = world.remoteHead();
    const r = await runCli(world, ["note", "hello"], { env: none() });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("ctl: no state remote configured — run `ctl origin set <url>`\n");
    expect(world.remoteHead()).toBe(tip);
  });
  it("the old fallback to the working repo's `origin` remote is gone", async () => {
    const work = path.join(world.root, "work-with-origin");
    fs.mkdirSync(work);
    git(work, ["init", "-q"]);
    git(work, ["remote", "add", "origin", world.originUrl]);
    const tip = world.remoteHead();
    const r = await runCli(world, ["note", "hello"], { env: none(), cwd: work });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no state remote configured/);
    expect(world.remoteHead()).toBe(tip);
    expect(fs.existsSync(world.cloneDirOf("a"))).toBe(false);
  });
  it("the config file supplies the remote once set", async () => {
    await runCli(world, ["origin", "set", world.originUrl], { env: none() });
    const r = await runCli(world, ["note", "via file"], { env: none() });
    expect(r.code).toBe(0);
    expect(world.remoteLines("lane-u").pop()).toMatchObject({ note: "via file" });
  });
});

describe("a product-repo origin is refused by every verb before any git call", () => {
  let world: World;
  beforeEach(() => {
    world = makeWorld();
    world.seedBranch("ctl/state", baseState(2));
  });
  afterEach(() => world.cleanup());
  const bad = `https://github.com/${SLUG}.git`;

  it("env origin: a write verb exits 2, runs no git, creates no clone", async () => {
    const shim = makeGitShim(world);
    const r = await runCli(world, ["note", "x"], {
      lane: "lane-u",
      env: { ...shim.env, CONTROL_STATE_ORIGIN: bad },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/refusing state remote https:\/\/github\.com\//);
    expect(shim.calls()).toEqual([]);
    expect(fs.existsSync(world.cloneDirOf("a"))).toBe(false);
  });
  it("file origin is refused the same way; `next` stays exit 0 and `--hook` silent", async () => {
    const cfg = path.join(world.root, "cfg");
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, "origin"), bad + "\n");
    const env = { CONTROL_STATE_ORIGIN: "", CONTROL_CONFIG_DIR: cfg };
    const w = await runCli(world, ["note", "x"], { env });
    expect(w.code).toBe(2);
    const n = await runCli(world, ["next"], { env });
    expect(n.code).toBe(0);
    expect(n.stdout).toMatch(/^control: /);
    expect(n.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    const h = await runCli(world, ["next", "--hook"], { env });
    expect(h.code).toBe(0);
    expect(h.stdout).toBe("");
  });
  it("--origin flag is refused too", async () => {
    const r = await runCli(world, ["note", "x", "--origin", bad]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/refusing state remote/);
  });
});
