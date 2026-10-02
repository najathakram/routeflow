import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// T1 (R2, R3) — scripts/lint-migrations.mjs contract (item 3B, destructive-migration lint).
//
// The script does not exist yet on this branch, so every case here drives a real spawnSync
// and fails on the process's own observable contract (exit status, stdout/stderr content)
// rather than on an import. Mirrors the schema-drift-script.spec.ts pattern: node launches
// fine even when the entry module is missing — it exits 1 with MODULE_NOT_FOUND on stderr
// (verified: status 1, not null, on this tree) — so content oracles are asserted before the
// exit status wherever a bare status check could be satisfied by the script simply not
// existing yet.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/lint-migrations.mjs");
// git EXPORTS repo-scoped variables into a hook (verify runs this spec from pre-push): strip every GIT_*
// so the throwaway repos below can never be redirected at another repository (B420).
// The ONE GIT_* scrub (scripts/lib/scrubbed-git-env.cjs); fixture-git-env-scrub.spec.ts pins that every
// git spawn in a fixture-repo spec passes it (a private copy of the filter does not count).
const { scrubbedGitEnv } = require("../../../../scripts/lib/scrubbed-git-env.cjs") as {
  scrubbedGitEnv: () => NodeJS.ProcessEnv;
};
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SQUAWK_CLI = path.resolve(REPO_ROOT, "node_modules/squawk-cli");

function run(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });
}

describe("lint-migrations.mjs contract (T1 / R2, R3)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lint-migrations-"));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFixture(name: string, sql: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, sql);
    return file;
  }

  it("T1(a): a clean, non-destructive migration file exits 0", () => {
    const file = writeFixture("clean.sql", 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n');

    const res = run(["--files", file]);

    // The contract oracle comes first so the red gate fails on it (exit 0 is not a status a
    // missing script can produce); the guard below still forbids a crashing script from ever
    // masquerading as "the linter correctly found nothing wrong".
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("Cannot find module");
  });

  it("T1(b): a drop-column + not-null-add migration exits 1, names both destructive rules, and stays silent on an excluded lock-hygiene rule the same file would also trigger", () => {
    const file = writeFixture(
      "bad.sql",
      [
        'ALTER TABLE "T" DROP COLUMN "c";',
        'ALTER TABLE "T" ADD COLUMN y text NOT NULL;',
        'CREATE INDEX i ON "T"(a);',
        "",
      ].join("\n"),
    );

    const res = run(["--files", file]);

    // Anti-masking guard first — without it every oracle below could be satisfied by the
    // empty stdout of a missing or crashing script rather than by the linter's own output.
    expect(res.stderr).not.toContain("Cannot find module");
    // Content oracles next — the exit status alone cannot distinguish "the exclusion list
    // works" from "nothing ran at all".
    expect(res.stdout).toContain("ban-drop-column");
    expect(res.stdout).toContain("adding-required-field");
    expect(res.stdout).not.toContain("require-concurrent-index-creation");
    expect(res.status).toBe(1);
  });

  it("T1(c): a reasoned squawk-ignore above the destructive line silences that rule and exits 0", () => {
    const file = writeFixture(
      "reasoned.sql",
      [
        "-- reason: column unused since #123",
        "-- squawk-ignore ban-drop-column",
        'ALTER TABLE "T" DROP COLUMN "c";',
        "",
      ].join("\n"),
    );

    const res = run(["--files", file]);

    // Status first (the real oracle: the reasoned ignore makes this file clean), then the
    // anti-masking guard — without it the `not.toContain` below would pass vacuously on the
    // empty stdout of a missing or crashing script.
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stdout).not.toContain("ban-drop-column");
  });

  it("T1(d): a squawk-ignore with no reason line above it exits 1 with the reason-rule message naming the file and line", () => {
    const file = writeFixture(
      "unreasoned.sql",
      ["-- squawk-ignore ban-drop-column", 'ALTER TABLE "T" DROP COLUMN "c";', ""].join("\n"),
    );

    const res = run(["--files", file]);

    // Anti-masking guard first: `combined` folds in stderr, so a MODULE_NOT_FOUND trace
    // could otherwise be the string these content oracles are read against.
    expect(res.stderr).not.toContain("Cannot find module");
    const combined = res.stdout + res.stderr;
    expect(combined).toContain(`${file}:1`);
    expect(combined).toContain('squawk-ignore without a "-- reason:" line above it');
    expect(res.status).toBe(1);
  });

  it("T1(e): --files with no paths prints the no-migrations message and exits 0", () => {
    const res = run(["--files"]);

    // Anti-masking guard first — an absent script also produces empty stdout.
    expect(res.stderr).not.toContain("Cannot find module");
    expect(res.stdout).toContain("no migrations");
    expect(res.status).toBe(0);
  });

  it("T1(f): --base with an unresolvable ref fails closed — exit 2, names the ref, never claims a clean range", () => {
    const res = run(["--base", "does-not-exist-ref"]);

    // Content oracles first: the whole point is that this must NOT be mistakable for the
    // healthy "this PR adds no migrations" run that T1(e) pins.
    expect(res.stderr).toContain("could not resolve range");
    expect(res.stderr).toContain("does-not-exist-ref");
    expect(res.stdout).not.toContain("no migrations in range");
    expect(res.status).toBe(2);
  });

  it("T1(g): --all is cwd-independent — run from apps/api it still finds the migrations", () => {
    const res = run(["--all"], path.join(REPO_ROOT, "apps/api"));

    expect(res.stdout).not.toContain("no migrations in range");
    expect(res.stdout).toContain("lint:migrations --all:");
    expect(res.status).toBe(0);
  });

  // B896 / SA-582: `SET LOCAL` only lasts to the end of a transaction, and a migration file is not
  // guaranteed to run inside one, so it must sit inside an explicit BEGIN; ... COMMIT; wrap.
  describe("B896: SET LOCAL needs an explicit BEGIN; ... COMMIT; wrap", () => {
    const FIXTURES = path.resolve(REPO_ROOT, "scripts/fixtures/lint-migrations");
    const unwrapped = path.join(FIXTURES, "set-local-unwrapped.sql.fixture");
    const wrapped = path.join(FIXTURES, "set-local-wrapped.sql.fixture");

    it("the RED fixture (SET LOCAL, no wrap) exits 1 and names the file, the line and SET LOCAL", () => {
      const res = run(["--files", unwrapped]);
      expect(res.stderr).toContain(`${unwrapped}:3:`);
      expect(res.stderr).toMatch(/SET LOCAL.*BEGIN;.*COMMIT;/);
      expect(res.status).toBe(1);
    });

    it("the passing fixture (wrapped in BEGIN; ... COMMIT;) exits 0", () => {
      const res = run(["--files", wrapped]);
      expect(res.stderr).not.toContain("SET LOCAL");
      expect(res.status).toBe(0);
    });

    it.each([
      ["a lowercase set local", "set local lock_timeout = '5s';\nSELECT 1;\n"],
      [
        "SET LOCAL after the COMMIT",
        "BEGIN;\nSELECT 1;\nCOMMIT;\nSET LOCAL lock_timeout = '5s';\n",
      ],
      ["a BEGIN with no COMMIT", "BEGIN;\nSET LOCAL lock_timeout = '5s';\nSELECT 1;\n"],
      [
        "SET LOCAL before the BEGIN",
        "SET LOCAL lock_timeout = '5s';\nBEGIN;\nSELECT 1;\nCOMMIT;\n",
      ],
    ])("refuses %s", (_label, sql) => {
      const res = run(["--files", writeFixture(`b896-${Math.random()}.sql`, sql as string)]);
      expect(res.stderr).toMatch(/SET LOCAL|BEGIN/);
      expect(res.status).toBe(1);
    });

    it.each([
      [
        "a SET LOCAL mentioned only in a -- comment",
        "-- SET LOCAL lock_timeout is not used here\nSELECT 1;\n",
      ],
      ["a SET LOCAL inside a /* block comment */", "/* SET LOCAL x = 1; */\nSELECT 1;\n"],
      [
        "SET LOCAL text inside a string literal",
        'INSERT INTO "T" ("c") VALUES (\'SET LOCAL a = 1;\');\n',
      ],
      [
        "START TRANSACTION ... END as the wrap",
        "START TRANSACTION;\nSET LOCAL lock_timeout = '5s';\nEND;\n",
      ],
      ["no SET LOCAL at all, no wrap", 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n'],
    ])("accepts %s", (_label, sql) => {
      const res = run(["--files", writeFixture(`b896-${Math.random()}.sql`, sql as string)]);
      expect(res.stderr).not.toMatch(/SET LOCAL/);
      expect(res.status).toBe(0);
    });

    // Follow-up to the #2746 review: transaction-control spellings and masking.
    it.each([
      ["BEGIN WORK ... COMMIT WORK", "BEGIN WORK;\nSET LOCAL lock_timeout = '5s';\nCOMMIT WORK;\n"],
      [
        "BEGIN TRANSACTION ... COMMIT TRANSACTION",
        "BEGIN TRANSACTION;\nSET LOCAL lock_timeout = '5s';\nCOMMIT TRANSACTION;\n",
      ],
      ["BEGIN ... END TRANSACTION", "BEGIN;\nSET LOCAL lock_timeout = '5s';\nEND TRANSACTION;\n"],
      [
        "START TRANSACTION ISOLATION LEVEL ... COMMIT WORK",
        "START TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nSET LOCAL lock_timeout = '5s';\nCOMMIT WORK;\n",
      ],
      ["BEGIN ... ROLLBACK WORK", "BEGIN;\nSET LOCAL lock_timeout = '5s';\nROLLBACK WORK;\n"],
      [
        "a digit in a dollar-quote tag ($fn1$ body with its own SET LOCAL)",
        "DO $fn1$ BEGIN PERFORM 1; SET LOCAL x = 1; END $fn1$;\n",
      ],
      [
        "an E'..' string with an escaped quote hiding a SET LOCAL",
        'INSERT INTO "T" ("c") VALUES (E\'it\\\'s; SET LOCAL a = 1;\');\n',
      ],
    ])("accepts %s", (_label, sql) => {
      const res = run(["--files", writeFixture(`b896f-${Math.random()}.sql`, sql as string)]);
      expect(res.stderr).not.toMatch(/SET LOCAL|BEGIN;/);
      expect(res.status).toBe(0);
    });

    it("an E'..' string ending in an escaped BACKSLASH (E'a\\\\') closes at that quote, so a SET LOCAL after it is still refused", () => {
      const sql = "SELECT E'a\\\\';\nSET LOCAL lock_timeout = '5s';\n";
      const res = run(["--files", writeFixture(`b896f-${Math.random()}.sql`, sql)]);
      expect(res.stderr).toMatch(/SET LOCAL outside an explicit BEGIN/);
      expect(res.status).toBe(1);
    });

    it("ROLLBACK TO SAVEPOINT does not close the transaction (a SET LOCAL after it stays inside the wrap)", () => {
      const sql =
        "BEGIN;\nSAVEPOINT a;\nROLLBACK TO SAVEPOINT a;\nSET LOCAL lock_timeout = '5s';\nCOMMIT;\n";
      const res = run(["--files", writeFixture(`b896f-${Math.random()}.sql`, sql)]);
      expect(res.stderr).not.toMatch(/SET LOCAL|BEGIN;/);
      expect(res.status).toBe(0);
    });

    it("the repo's own migrations tree is not flagged in diff mode, only files in the range are read (history is immutable)", () => {
      const res = run(["--base", "HEAD"]);
      expect(res.stdout).toContain("no migrations in range");
      expect(res.status).toBe(0);
    });
  });

  // SA-582a / B896: applied-on-prod migrations cannot be edited (their checksum is recorded), so an
  // exact folder-name + file-sha256 exemption table lets ONLY the SET LOCAL wrap rule pass them.
  describe("SA-582a: applied-migration SET LOCAL exemption table", () => {
    const TABLE = path.resolve(REPO_ROOT, "scripts/lib/set-local-exempt-migrations.json");
    const MIGRATIONS = path.resolve(REPO_ROOT, "apps/api/prisma/migrations");
    const EXPECTED_EXEMPT = [
      "20260921180000_ledger_correction_and_parked_reversals",
      "20260923034344_b297_excise_snapshot_and_locked_filing",
      "20260924000000_parked_reversal_resolved_reason",
      "20260924060000_b562_stock_movement_effective_at",
      "20260925060000_f05_standing_order_line_suspension",
      "20260925160000_sales_facts_read_indexes",
      "20260927043000_sa436_credit_auto_apply_off",
      "20260927060000_onboarding_s1_cases",
      "20260928230000_2717_m1_catalog_barcodes_images",
    ];
    const PRESENT = EXPECTED_EXEMPT.filter((n) => fs.existsSync(path.join(MIGRATIONS, n)));
    const UNWRAPPED = "SET LOCAL lock_timeout = '5s';\nSELECT 1;\n";

    function inFolder(folder: string, sql: string): string {
      const d = path.join(dir, folder);
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, "migration.sql");
      fs.writeFileSync(file, sql);
      return file;
    }

    it("pins the exact exempt folder names (any addition is a deliberate spec edit)", () => {
      const table = JSON.parse(fs.readFileSync(TABLE, "utf8")) as { folder: string }[];
      expect(table.map((e) => e.folder)).toEqual(EXPECTED_EXEMPT);
    });

    it("every entry carries a sha256 and a one-line reason", () => {
      const table = JSON.parse(fs.readFileSync(TABLE, "utf8")) as {
        sha256: string;
        reason: string;
      }[];
      for (const e of table) {
        expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(e.reason).toMatch(/SA-582a/);
        expect(e.reason).not.toContain("\n");
      }
    });

    it("--all on the real tree reports no SET LOCAL finding (present exempt files pass through)", () => {
      expect(PRESENT.length).toBeGreaterThanOrEqual(8);
      const res = run(["--all", "--strict"]);
      expect(res.stderr).not.toContain("SET LOCAL");
      expect(res.stdout).not.toContain("SET LOCAL wrap finding");
    });

    it("each present exempt migration passes --files by its exemption", () => {
      for (const n of PRESENT) {
        const res = run(["--files", path.join(MIGRATIONS, n, "migration.sql")]);
        expect(res.stderr).not.toContain("SET LOCAL");
      }
    });

    it("a NEW migration with an unwrapped SET LOCAL still fails", () => {
      const res = run(["--files", inFolder("20260929000000_brand_new", UNWRAPPED)]);
      expect(res.stderr).toContain("SET LOCAL");
      expect(res.status).toBe(1);
    });

    it("an exempt folder name whose content differs (sha mismatch) fails", () => {
      const res = run(["--files", inFolder(EXPECTED_EXEMPT[0], UNWRAPPED)]);
      expect(res.stderr).toContain("SET LOCAL");
      expect(res.status).toBe(1);
    });

    it("an exempt folder with an unwrapped-M1-name but different content fails too", () => {
      const res = run(["--files", inFolder(EXPECTED_EXEMPT[8], UNWRAPPED)]);
      expect(res.stderr).toContain("SET LOCAL");
      expect(res.status).toBe(1);
    });

    it("matching is name-exact: prefix, suffix, containing and different-case names fail", () => {
      const real = fs.readFileSync(
        path.join(MIGRATIONS, EXPECTED_EXEMPT[0], "migration.sql"),
        "utf8",
      );
      for (const name of [
        `${EXPECTED_EXEMPT[0]}_x`,
        `x_${EXPECTED_EXEMPT[0]}`,
        EXPECTED_EXEMPT[0].toUpperCase(),
      ]) {
        const res = run(["--files", inFolder(name, real)]);
        expect(res.stderr).toContain("SET LOCAL");
        expect(res.status).toBe(1);
      }
    });

    it("the exemption does not suppress the reason rule", () => {
      const res = run([
        "--files",
        inFolder(EXPECTED_EXEMPT[0], "-- squawk-ignore ban-drop-column\nSELECT 1;\n"),
      ]);
      expect(res.stderr).toContain('squawk-ignore without a "-- reason:" line');
      expect(res.status).toBe(1);
    });
  });

  // B904 / SA-582: every NEW migration in the --base range must carry the wrap.
  describe("B904: --require-wrap (on by default in --base mode)", () => {
    const FIXTURES = path.resolve(REPO_ROOT, "scripts/fixtures/lint-migrations");
    const fx = (name: string) => path.join(FIXTURES, name);
    const req = (file: string) => run(["--files", file, "--require-wrap"]);

    it("RED: an unwrapped new migration exits 1, naming the file and what is missing", () => {
      const f = fx("new-unwrapped.sql.fixture");
      const res = req(f);
      expect(res.stderr).toContain(f);
      expect(res.stderr).toMatch(/exactly one BEGIN;.*found 0/);
      expect(res.stderr).toMatch(/exactly one COMMIT;.*found 0/);
      expect(res.stderr).toMatch(/exactly one SET LOCAL lock_timeout.*found 0/);
      expect(res.status).toBe(1);
    });

    it("RED: a wrap missing SET LOCAL lock_timeout exits 1", () => {
      const res = req(fx("wrap-missing-set-local.sql.fixture"));
      expect(res.stderr).toMatch(/exactly one SET LOCAL lock_timeout.*found 0/);
      expect(res.stderr).not.toMatch(/exactly one BEGIN;/);
      expect(res.status).toBe(1);
    });

    it("RED: a double BEGIN exits 1", () => {
      const res = req(fx("double-begin.sql.fixture"));
      expect(res.stderr).toMatch(/exactly one BEGIN;.*found 2/);
      expect(res.status).toBe(1);
    });

    it("GREEN: the wrapped fixture (BEGIN; SET LOCAL lock_timeout; ...; COMMIT;) exits 0", () => {
      const res = req(fx("set-local-wrapped.sql.fixture"));
      expect(res.stderr).not.toMatch(/exactly one/);
      expect(res.status).toBe(0);
    });

    const wrapped = (mid: string, pre = "", post = "") =>
      `${pre}BEGIN;\nSET LOCAL lock_timeout = '5s';\n${mid}COMMIT;\n${post}`;
    it.each([
      ["two COMMITs", wrapped("SELECT 1;\nCOMMIT;\n"), /exactly one COMMIT;.*found 2/],
      [
        "two SET LOCAL lock_timeout",
        wrapped("SET LOCAL lock_timeout = '9s';\n"),
        /exactly one SET LOCAL lock_timeout.*found 2/,
      ],
      [
        "SET LOCAL lock_timeout before the BEGIN",
        "SET LOCAL lock_timeout = '5s';\nBEGIN;\nSELECT 1;\nCOMMIT;\n",
        /must come between BEGIN; and COMMIT;|outside an explicit BEGIN/,
      ],
      [
        "a statement BEFORE the BEGIN",
        wrapped("SELECT 1;\n", 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n'),
        /statement before BEGIN;/,
      ],
      [
        "a statement AFTER the COMMIT",
        wrapped("SELECT 1;\n", "", 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n'),
        /statement after COMMIT;/,
      ],
    ])("RED: %s", (_label, sql, msg) => {
      const res = req(writeFixture(`b904-${Math.random()}.sql`, sql as string));
      expect(res.stderr).toMatch(msg as RegExp);
      expect(res.status).toBe(1);
    });

    it.each([
      [
        "lowercase begin/commit and set local",
        "begin;\nset local lock_timeout = '5s';\nselect 1;\ncommit;\n",
      ],
      [
        "BEGIN WORK ... COMMIT WORK",
        "BEGIN WORK;\nSET LOCAL lock_timeout = '5s';\nSELECT 1;\nCOMMIT WORK;\n",
      ],
      [
        "START TRANSACTION ... COMMIT TRANSACTION",
        "START TRANSACTION;\nSET LOCAL lock_timeout = '5s';\nSELECT 1;\nCOMMIT TRANSACTION;\n",
      ],
      [
        "other SET LOCAL statements inside the wrap, and comments outside it",
        "-- why this migration\nBEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '30s';\nSELECT 1;\nCOMMIT;\n-- done\n",
      ],
    ])("GREEN: %s", (_label, sql) => {
      const res = req(writeFixture(`b904-${Math.random()}.sql`, sql as string));
      expect(res.stderr).not.toMatch(/exactly one|before BEGIN|after COMMIT/);
      expect(res.status).toBe(0);
    });

    it("the rule is OFF by default outside --base: --files without --require-wrap keeps T1's unwrapped fixtures green", () => {
      expect(run(["--files", fx("new-unwrapped.sql.fixture")]).status).toBe(0);
    });

    it("`--all --strict` is still exit 0 (applied history: the exemption table covers the SET LOCAL ones, and the wrap is not required outside --base)", () => {
      const res = run(["--all", "--strict"]);
      expect(res.stderr).not.toMatch(/exactly one/);
      expect(res.status).toBe(0);
    });

    describe("end to end in a throwaway repo: --base range", () => {
      // The script anchors everything at its own repo root, so it runs from a copy in a temp repo.
      let repo: string;
      const g = (...a: string[]) => {
        const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", env: scrubbedGitEnv() });
        if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
        return r.stdout.trim();
      };
      const migrationsDir = () => path.join(repo, "apps/api/prisma/migrations");
      const addMigration = (name: string, sql: string) => {
        fs.mkdirSync(path.join(migrationsDir(), name), { recursive: true });
        fs.writeFileSync(path.join(migrationsDir(), name, "migration.sql"), sql);
      };
      const commitAll = (msg: string) => {
        g("add", "-A", "-f");
        g("commit", "-q", "-m", msg);
        return g("rev-parse", "HEAD");
      };
      const lint = (base: string) =>
        spawnSync(process.execPath, ["scripts/lint-migrations.mjs", "--base", base], {
          cwd: repo,
          encoding: "utf8",
          env: scrubbedGitEnv(),
        });
      let base: string;

      beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), "b904-repo-"));
        g("init", "-q", "-b", "master");
        g("config", "user.email", "t@example.test");
        g("config", "user.name", "t");
        g("config", "commit.gpgsign", "false");
        fs.mkdirSync(path.join(repo, "scripts/lib"), { recursive: true });
        fs.mkdirSync(path.join(repo, "apps/api"), { recursive: true });
        fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
        fs.copyFileSync(SCRIPT, path.join(repo, "scripts/lint-migrations.mjs"));
        fs.copyFileSync(
          path.resolve(REPO_ROOT, "scripts/lib/set-local-exempt-migrations.json"),
          path.join(repo, "scripts/lib/set-local-exempt-migrations.json"),
        );
        fs.copyFileSync(
          path.resolve(REPO_ROOT, "apps/api/.squawk.toml"),
          path.join(repo, "apps/api/.squawk.toml"),
        );
        // A "dir" symlink needs a privilege a normal Windows user lacks (EPERM); a junction does
        // not, and behaves the same for squawk (same pattern as scripts/janitor.self-test.mjs).
        fs.symlinkSync(
          SQUAWK_CLI,
          path.join(repo, "node_modules/squawk-cli"),
          process.platform === "win32" ? "junction" : "dir",
        );
        // An applied, UNWRAPPED migration already in history (no SET LOCAL, no wrap).
        addMigration("20260101000000_applied_history", 'ALTER TABLE "T" ADD COLUMN "old" TEXT;\n');
        base = commitAll("base");
      });
      afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
        // The cleanup must unlink the link only, never delete through it into the real install.
        expect(fs.existsSync(path.join(SQUAWK_CLI, "package.json"))).toBe(true);
      });

      const GOOD =
        'BEGIN;\nSET LOCAL lock_timeout = \'5s\';\nALTER TABLE "T" ADD COLUMN "c" TEXT;\nCOMMIT;\n';

      it("a NEW unwrapped migration in the range is refused (exit 1) and named", () => {
        addMigration("20260929000000_new_unwrapped", 'ALTER TABLE "T" ADD COLUMN "c" TEXT;\n');
        commitAll("new");
        const res = lint(base);
        expect(res.stderr).toContain("20260929000000_new_unwrapped");
        expect(res.stderr).toMatch(/exactly one BEGIN;/);
        expect(res.status).toBe(1);
      });

      it("a NEW wrapped migration passes, and the unwrapped applied history outside the range stays green", () => {
        addMigration("20260929000000_new_wrapped", GOOD);
        commitAll("new");
        const res = lint(base);
        expect(res.stderr).not.toMatch(/exactly one/);
        expect(res.status).toBe(0);
      });

      it("an EDITED applied migration in the range is held to the wrap too (its sha is no longer exempt)", () => {
        fs.appendFileSync(
          path.join(migrationsDir(), "20260101000000_applied_history", "migration.sql"),
          "-- edited\n",
        );
        commitAll("edit applied");
        expect(lint(base).status).toBe(1);
      });

      it("an applied migration on the exemption table (folder + sha256) is skipped by the wrap rule", () => {
        const sql = 'ALTER TABLE "T" ADD COLUMN "z" TEXT;\n';
        addMigration("20260202000000_exempt_one", sql);
        const table = JSON.parse(
          fs.readFileSync(path.join(repo, "scripts/lib/set-local-exempt-migrations.json"), "utf8"),
        );
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sha = require("node:crypto").createHash("sha256").update(sql).digest("hex");
        table.push({ folder: "20260202000000_exempt_one", sha256: sha, reason: "test" });
        fs.writeFileSync(
          path.join(repo, "scripts/lib/set-local-exempt-migrations.json"),
          JSON.stringify(table),
        );
        commitAll("exempt one");
        expect(lint(base).status).toBe(0);
      });
    });
  });
});
