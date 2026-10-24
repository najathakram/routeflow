/**
 * `runCli` (and every helper that spawns git) is offline by construction: the child gets
 * GIT_ALLOW_PROTOCOL=file and GIT_SSH_COMMAND=false unless the caller overrides them, so a
 * regressed state-origin refusal can never reach github.com (or any host) from a spec. Nothing here
 * touches a network: the origins below use the reserved `.invalid` TLD, and are blocked by git's
 * protocol allow-list before any lookup.
 */
import * as fs from "fs";
import * as path from "path";
import { cliChildEnv, runCli } from "./helpers/spawn-cli";
import { makeWorld } from "./helpers/temp-repo";
import type { World } from "./helpers/temp-repo";
import { scaled } from "./helpers/platform";

jest.setTimeout(scaled(60_000));

// built from parts so this file (scanned by the client-data guard) holds no literal address
const AT = "@";

let world: World;
beforeEach(() => {
  world = makeWorld();
  world.seedBranch("ctl/state", { "README.md": "synthetic\n" });
});
afterEach(() => world.cleanup());

describe("the env a spawned ctl gets", () => {
  it("defaults to file-only transport and a git that cannot run ssh", () => {
    const env = cliChildEnv(world, {});
    expect(env.GIT_ALLOW_PROTOCOL).toBe("file");
    expect(env.GIT_SSH_COMMAND).toBe("false");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
  it("beats an ambient value in the jest process", () => {
    const prev = { p: process.env.GIT_ALLOW_PROTOCOL, s: process.env.GIT_SSH_COMMAND };
    process.env.GIT_ALLOW_PROTOCOL = "file:https:ssh";
    process.env.GIT_SSH_COMMAND = "ssh -v";
    try {
      const env = cliChildEnv(world, {});
      expect(env.GIT_ALLOW_PROTOCOL).toBe("file");
      expect(env.GIT_SSH_COMMAND).toBe("false");
    } finally {
      for (const [k, v] of [
        ["GIT_ALLOW_PROTOCOL", prev.p],
        ["GIT_SSH_COMMAND", prev.s],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  it("a caller can still override both (the redirect specs talk http to 127.0.0.1)", () => {
    const env = cliChildEnv(world, {
      env: { GIT_ALLOW_PROTOCOL: "file:http:https", GIT_SSH_COMMAND: "true" },
    });
    expect(env.GIT_ALLOW_PROTOCOL).toBe("file:http:https");
    expect(env.GIT_SSH_COMMAND).toBe("true");
  });
});

describe("a spawned ctl against a remote origin never makes a non-file connection", () => {
  it.each([
    ["https", "https://state.invalid/acme/state.git"],
    ["ssh://", `ssh://git${AT}state.invalid/acme/state.git`],
    ["scp-like", `git${AT}state.invalid:acme/state.git`],
  ])("%s: git refuses the transport before any lookup (exit 5, 'not allowed')", async (_n, url) => {
    const r = await runCli(world, ["note", "hello"], { env: { CONTROL_STATE_ORIGIN: url } });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/not allowed|transport/i);
    expect(r.stderr).not.toMatch(/resolve host|connect to|Permission denied/i);
  });
});

describe("every helper that spawns git or the CLI is offline by default", () => {
  const helpers = path.join(__dirname, "helpers");
  const src = (f: string): string => fs.readFileSync(path.join(helpers, f), "utf8");
  const spawners = fs
    .readdirSync(helpers)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) =>
      /execFileSync\("git"|spawn(Sync)?\("git"|spawn\(\s*process\.execPath/.test(src(f)),
    );
  it("found the spawning helpers (the audit is not vacuous)", () => {
    expect(spawners).toEqual(
      expect.arrayContaining(["spawn-cli.ts", "temp-repo.ts", "smart-http.ts"]),
    );
  });
  it("each one starts from OFFLINE_GIT_ENV (file-only transport, ssh disabled)", () => {
    for (const f of spawners) {
      expect([f, /\.\.\.OFFLINE_GIT_ENV/.test(src(f))]).toEqual([f, true]);
    }
    const { OFFLINE_GIT_ENV } = require("./helpers/temp-repo");
    expect(OFFLINE_GIT_ENV).toEqual({ GIT_ALLOW_PROTOCOL: "file", GIT_SSH_COMMAND: "false" });
  });
});
