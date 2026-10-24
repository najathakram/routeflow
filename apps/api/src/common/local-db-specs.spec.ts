import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// #2183: `npm run local:test:db` runs the DB lane on its own fresh database
// (scripts/local-db-specs.mjs). These pins cover the parts that must never drift, without touching
// a database: the only names it will create or DROP are its own `rf_dbspec_*` ones (so
// `routeflow_dev` can never be dropped), the target is always the compose Postgres on loopback (127.0.0.1, never the name `localhost`),
// and the CLI refuses anything it does not know before any side effect (the #2076 lesson).

const SCRIPT = path.resolve(__dirname, "../../../../scripts/local-db-specs.mjs");

/** Runs `body` against the imported module in a child node and returns its JSON output. */
function probe(body: string): unknown {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)}); console.log(JSON.stringify(${body}));`,
    ],
    { encoding: "utf8" },
  );
  expect(res.stderr).toBe("");
  return JSON.parse(res.stdout);
}

describe("#2183 local:test:db runs on its own fresh database", () => {
  it("only its own rf_dbspec_* names pass; routeflow_dev and every other name are refused", () => {
    const verdicts = probe(`[
      m.specDbName(1790000000000, 4242),
      "routeflow_dev", "postgres", "rf_dbspec_", "rf_dbspec_abc", "rf_dbspec_abc_1; DROP",
      'rf_dbspec_abc_1"', "RF_DBSPEC_ABC_1", "x_rf_dbspec_abc_1",
    ].map((n) => { try { m.assertSpecDbName(n); return [n, true]; } catch { return [n, false]; } })`);
    expect(verdicts).toEqual([
      ["rf_dbspec_mubbs7i8_4242", true],
      ["routeflow_dev", false],
      ["postgres", false],
      ["rf_dbspec_", false],
      ["rf_dbspec_abc", false],
      ["rf_dbspec_abc_1; DROP", false],
      ['rf_dbspec_abc_1"', false],
      ["RF_DBSPEC_ABC_1", false],
      ["x_rf_dbspec_abc_1", false],
    ]);
  });

  it("a generated name is unique per time and pid, and always passes its own guard", () => {
    const names = probe(
      `[[1, 1], [1, 2], [2, 1], [Date.now(), 99999]].map(([t, p]) => m.specDbName(t, p))`,
    ) as string[];
    expect(new Set(names).size).toBe(4);
    const ok = probe(
      `[[1, 1], [Date.now(), 4194304]].every(([t, p]) => { m.assertSpecDbName(m.specDbName(t, p)); return true; })`,
    );
    expect(ok).toBe(true);
  });

  it("targets the compose Postgres on 127.0.0.1 with the compose credential defaults", () => {
    expect(
      probe(`[
        m.connectionUrl(m.composeConnection({}, "rf_dbspec_a_1")),
        m.connectionUrl(m.composeConnection({ POSTGRES_USER: "u@x", POSTGRES_PASSWORD: "p/w" }, "postgres")),
        m.composeConnection({ POSTGRES_USER: "" }, "postgres").user,
      ]`),
    ).toEqual([
      "postgresql://user:pass@127.0.0.1:5432/rf_dbspec_a_1",
      "postgresql://u%40x:p%2Fw@127.0.0.1:5432/postgres",
      "user",
    ]);
  });

  it("RF_DBSPEC_HOST overrides the default host, loopback only; an empty value keeps the default", () => {
    expect(
      probe(`[
        m.composeConnection({ RF_DBSPEC_HOST: "localhost" }, "postgres").host,
        m.composeConnection({ RF_DBSPEC_HOST: "127.0.0.2" }, "postgres").host,
        m.composeConnection({ RF_DBSPEC_HOST: "" }, "postgres").host,
        ["db.example.com", "10.0.0.5", "127.0.0.1.evil.com", "[::1]"].map((h) => {
          try { return m.composeConnection({ RF_DBSPEC_HOST: h }, "postgres").host; } catch (e) { return "refused"; }
        }),
      ]`),
    ).toEqual([
      "localhost",
      "127.0.0.2",
      "127.0.0.1",
      ["refused", "refused", "refused", "refused"],
    ]);
  });

  it("the CLI refuses unknown flags and a missing command before any side effect", () => {
    expect(
      probe(`[
        ["--", "npm run test:db -w apps/api"], ["--keep", "--", "x", "y"], ["--help"],
        ["--db", "--", "x"], ["--"], [],
      ].map((a) => { try { return m.parseArgs(a); } catch (e) { return String(e.message); } })`),
    ).toEqual([
      {
        keep: false,
        command: "npm run test:db -w apps/api",
        tokens: ["npm run test:db -w apps/api"],
      },
      { keep: true, command: "x y", tokens: ["x", "y"] },
      { help: true },
      "unknown flag(s): --db",
      'expected `-- "<command string>"`',
      'expected `-- "<command string>"`',
    ]);
  });
});

// Item 726: a test pattern with shell metacharacters (`(a|b)`, `&`, `|`) must reach jest as literal
// argv. A single quoted string still runs through the shell (the `npm run local:test:db` form); two
// or more tokens after `--` are an argv and are spawned WITHOUT a shell, so cmd.exe never sees them.
describe("item 726: argv after `--` reaches the lane literally", () => {
  const PATTERNS = ["(a|b)", "a&b", "x|y", "50%", "'q'"];
  const list = PATTERNS.map((p) => JSON.stringify(p)).join(", ");

  it("a multi-token command is spawned without a shell, tokens untouched", () => {
    expect(
      probe(`[
        m.commandSpawn(["node", "run-db-tests.mjs", ${list}]),
        m.commandSpawn(["npm run test:db -w apps/api"]),
      ]`),
    ).toEqual([
      { cmd: "node", args: ["run-db-tests.mjs", ...PATTERNS], shell: false },
      { cmd: "npm run test:db -w apps/api", args: [], shell: true },
    ]);
  });

  it("the spawn spec round-trips every metacharacter pattern through a real child", () => {
    const spec = probe(
      `m.commandSpawn([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ${list}])`,
    ) as { cmd: string; args: string[]; shell: boolean };
    const res = spawnSync(spec.cmd, spec.args, { encoding: "utf8", shell: spec.shell });
    expect(JSON.parse(res.stdout)).toEqual(PATTERNS);
  });
});

// Review of #3718: the command string form must keep working when npm appends args, a first token
// that is a command string or an npm/npx shim (a .cmd on Windows) cannot be spawned without a
// shell, and `npm run local:test:db -- <spec>` must reach the runner as a spawnable argv.
describe("item 726: commandSpawn is safe for every caller form", () => {
  const ROOT_PKG = path.resolve(__dirname, "../../../../package.json");

  it("a first token holding a space (a command string plus appended args) runs through the shell, joined", () => {
    expect(
      probe(`[
        m.commandSpawn(["npm run test:db -w apps/api", "src/x.db.spec.ts"]),
        m.commandSpawn(["npm", "run", "test:db"]),
        m.commandSpawn(["npx", "jest"]),
      ]`),
    ).toEqual([
      { cmd: "npm run test:db -w apps/api src/x.db.spec.ts", args: [], shell: true },
      { cmd: "npm run test:db", args: [], shell: true },
      { cmd: "npx jest", args: [], shell: true },
    ]);
  });

  it("the npm-append form: local:test:db plus a spec path is spawned as node + argv, never ENOENT", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const script: string = require(ROOT_PKG).scripts["local:test:db"];
    // npm runs `<script> <appended args>`; split the way a shell would for these simple words.
    const words = [...script.split(" ").slice(2), "src/x.db.spec.ts"];
    const sep = words.indexOf("--");
    const spec = probe(`m.commandSpawn(${JSON.stringify(words.slice(sep + 1))})`) as {
      cmd: string;
      args: string[];
      shell: boolean;
    };
    expect(spec).toEqual({
      cmd: "node",
      args: ["apps/api/scripts/run-db-tests.mjs", "src/x.db.spec.ts"],
      shell: false,
    });
  });
});
