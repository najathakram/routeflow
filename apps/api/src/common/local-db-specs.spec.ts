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
      { keep: false, command: "npm run test:db -w apps/api" },
      { keep: true, command: "x y" },
      { help: true },
      "unknown flag(s): --db",
      'expected `-- "<command string>"`',
      'expected `-- "<command string>"`',
    ]);
  });
});
