/**
 * SA-1295 sitting-1 check script (apps/api/scripts/sitting-s1295-1-check.mjs) against the replay database (a database
 * migrated from the tree by `npm run local:test:db`). The script is an ES module, so each case runs it in a child
 * `node --input-type=module` process that imports it by file URL and drives the exported check functions with a `pg`
 * client on DATABASE_URL (a local target only: `requireLocalDatabaseUrl`). The CLI itself is not run here: it fails
 * closed without the Railway proxy variables, and its argument parsing is checked in the last case.
 *
 * `--status`: four cases (pending list equals --expect; differs; a failed run; a rolled-back-then-applied run).
 * `--post`: GO on the replay DB, and STOP when one trigger or the partial index is missing (each mutation runs inside
 * the child's own transaction that the check's ROLLBACK ends, so nothing is left behind).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

const SCRIPT = path.resolve(__dirname, "../../scripts/sitting-s1295-1-check.mjs");
const SCRIPT_URL = pathToFileURL(SCRIPT).href;

interface Out {
  ok: boolean;
  lines: string[];
}

/** Runs `body` (module code with `m` = the script module and `c` = a connected pg client) and returns {ok, lines}. */
function inChild(body: string): Out & { status: number | null; stderr: string } {
  const code = `
    import pg from "pg";
    const m = await import(${JSON.stringify(SCRIPT_URL)});
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const r = await (async () => { ${body} })();
      process.stdout.write("RESULT:" + JSON.stringify(r) + "\\n");
    } finally { await c.end(); }
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: path.dirname(SCRIPT),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: requireLocalDatabaseUrl() },
  });
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT:"));
  const parsed: Out = line ? JSON.parse(line.slice("RESULT:".length)) : { ok: false, lines: [] };
  return { ...parsed, status: res.status, stderr: res.stderr ?? "" };
}

describeDb("sitting-s1295-1-check.mjs on the replay database", () => {
  describe("--status (O3): four cases", () => {
    it("pending list equals --expect: GO", () => {
      const r = inChild(
        `return m.runStatus(c, ["20999999000000_acme_fake"], [...m.treeFolders(), "20999999000000_acme_fake"]);`,
      );
      expect(r.stderr).toBe("");
      expect(r.ok).toBe(true);
      expect(r.lines[r.lines.length - 1]).toBe("STATUS: GO (pending 1: 20999999000000_acme_fake)");
    });

    it("pending list differs from --expect: STOP", () => {
      const r = inChild(
        `return m.runStatus(c, [], [...m.treeFolders(), "20999999000000_acme_fake"]);`,
      );
      expect(r.ok).toBe(false);
      expect(r.lines[r.lines.length - 1]).toBe("STATUS: STOP (pending list differs from --expect)");
    });

    it("the migrated tree has nothing pending and nothing failed: GO with an empty list", () => {
      const r = inChild(`return m.runStatus(c, []);`);
      expect(r.ok).toBe(true);
      expect(r.lines[r.lines.length - 1]).toBe("STATUS: GO (pending 0: )");
    });

    it("classifyFolders: a failed run is STOP, a rolled-back-then-applied run is applied", () => {
      const r = inChild(`
        const d = new Date();
        const rows = [
          { migration_name: "f1", finished_at: null, rolled_back_at: null },
          { migration_name: "f2", finished_at: null, rolled_back_at: d },
          { migration_name: "f2", finished_at: d, rolled_back_at: null },
          { migration_name: "f3", finished_at: null, rolled_back_at: d },
        ];
        return { ok: true, lines: [JSON.stringify(m.classifyFolders(["f1", "f2", "f3", "f4"], rows))] };
      `);
      expect(JSON.parse(r.lines[0])).toEqual({ pending: ["f3", "f4"], failed: ["f1"] });
    });
  });

  describe("--post (O5)", () => {
    it("GO on a database migrated from the tree", () => {
      const r = inChild(`return m.runPost(c);`);
      expect(r.stderr).toBe("");
      expect(r.lines.filter((l) => l.startsWith("PROBLEM"))).toEqual([]);
      expect(r.lines[r.lines.length - 1]).toBe("POST: GO");
      expect(r.ok).toBe(true);
    });

    it("STOP when one guard trigger is missing", () => {
      const r = inChild(`
        await c.query("BEGIN");
        await c.query('DROP TRIGGER "SourceItemAlias_tenant_guard" ON "SourceItemAlias"');
        return m.runPost(c);
      `);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/PROBLEM: triggers differ/);
      expect(r.lines[r.lines.length - 1]).toMatch(/^POST: STOP/);
    });

    it("STOP when the partial unique index is missing", () => {
      const r = inChild(`
        await c.query("BEGIN");
        await c.query('DROP INDEX "ImportExternalRef_confirmed_entity_key"');
        return m.runPost(c);
      `);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(
        /PROBLEM: index ImportExternalRef_confirmed_entity_key: expected 1, found 0/,
      );
    });

    it("STOP when a foreign key has the wrong action (CASCADE on productId)", () => {
      const r = inChild(`
        await c.query("BEGIN");
        await c.query('ALTER TABLE "SourceItemAlias" DROP CONSTRAINT "SourceItemAlias_productId_fkey"');
        await c.query('ALTER TABLE "SourceItemAlias" ADD CONSTRAINT "SourceItemAlias_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE NO ACTION');
        return m.runPost(c);
      `);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/PROBLEM: foreign keys differ from A1-1/);
    });

    it("STOP when a rule or a second function names a guarded table", () => {
      const r = inChild(`
        await c.query("BEGIN");
        await c.query('CREATE FUNCTION acme_probe() RETURNS int LANGUAGE sql AS $$ SELECT count(*)::int FROM "LegacySalesLine" $$');
        return m.runPost(c);
      `);
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/PROBLEM: function bodies naming a guarded table/);
    });
  });

  describe("--pre (O2)", () => {
    it("GO on a quiet replay database, printing counts only", () => {
      const r = inChild(`return m.runPre(c);`);
      expect(r.stderr).toBe("");
      expect(r.lines[r.lines.length - 1]).toBe("PRE: GO");
      expect(r.lines.join("\n")).toMatch(/ImportExternalRef: rows \d+, bytes \d+/);
      expect(r.ok).toBe(true);
    });
  });

  it("the CLI arguments: exactly one mode, --status needs --expect", () => {
    const r = inChild(`
      const ok = m.parseArgs(["--status", "--expect", "a,b"]);
      const errs = [];
      for (const bad of [[], ["--pre", "--post"], ["--status"]]) {
        try { m.parseArgs(bad); errs.push("accepted"); } catch (e) { errs.push("refused"); }
      }
      return { ok: true, lines: [JSON.stringify(ok), ...errs] };
    `);
    expect(JSON.parse(r.lines[0])).toEqual({ mode: "status", expect: ["a", "b"] });
    expect(r.lines.slice(1)).toEqual(["refused", "refused", "refused"]);
  });
});
