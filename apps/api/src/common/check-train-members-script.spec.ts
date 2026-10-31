// scripts/check-train-members.mjs: the train member table in a train PR's body. Drives the real script
// as a child process with a fake `gh`, so a spawn or argument bug shows up here too.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "../../../../scripts/check-train-members.mjs");
const TRAIN_PR = 40;
const BOARD = 3686;

let dir: string;
let fakeGh: string;
let fixture: string;

const FILES: Record<string, string[]> = {
  1: ["apps/web/components/Thing.tsx", "apps/api/src/orders/orders.service.ts"], // UI
  2: ["apps/api/src/orders/orders.service.ts"], // not UI
  3: ["apps/web/app/thing/page.test.tsx", "apps/web/e2e/thing.spec.ts"], // tests only, not UI
  4: ["apps/mobile/app/(driver)/route.tsx"], // UI
};
/** The head of PR n. Each PR's commits end here, so a read that names it is at the exact sha. */
const head = (n: number) => `abc${n}def`.padEnd(40, "0");
const old = (n: number) => `fed${n}cba`.padEnd(40, "0");
const short = (sha: string) => sha.slice(0, 10);
const textRead = (n: number, sha = head(n)) => `text and type, #${n} at ${short(sha)}`;
const walk = `apple-ux walk of #${TRAIN_PR} at ${short(head(TRAIN_PR))}`;

const COMMENTS: Record<string, { on: number; body: string }> = {
  1001: { on: 1, body: textRead(1) },
  1004: { on: 4, body: textRead(4) },
  1101: { on: BOARD, body: textRead(1) }, // the board, where reviews go
  1102: { on: BOARD, body: textRead(2) }, // the board, about another PR
  1103: { on: 1, body: "text and type, #1, looks fine" }, // no sha
  1104: { on: 1, body: textRead(1, old(1)) }, // an older commit
  1105: { on: 1, body: `logic PASS, #1 at ${short(head(1))}` }, // no text read in it
  2000: { on: TRAIN_PR, body: walk },
  2001: { on: 2, body: textRead(2) },
  2002: { on: BOARD, body: walk },
  2003: { on: 1, body: `apple-ux walk, #1 at ${short(head(1))}, #4 at ${short(head(4))}` },
  2004: { on: BOARD, body: `apple-ux walk, #1 at ${short(head(1))}` }, // silent on #4
  2005: { on: TRAIN_PR, body: `apple-ux walk of #${TRAIN_PR}` }, // no sha
};
const COMMITS: Record<string, Array<[string, number]>> = Object.fromEntries(
  [1, 2, 3, 4, TRAIN_PR].map((n) => [
    n,
    [
      [old(n), 1],
      [head(n), 1],
    ],
  ]),
);

function writeFixture(over: Record<string, unknown> = {}) {
  fs.writeFileSync(
    fixture,
    JSON.stringify({ files: FILES, comments: COMMENTS, commits: COMMITS, ...over }),
  );
}

function table(rows: Array<[string, string, string]>) {
  return [
    "## W99 train",
    "",
    "| Order | PR | head | reads | text-type | apple-ux |",
    "|---|---|---|---|---|---|",
    ...rows.map(([pr, text, ux], i) => `| ${i + 1} | ${pr} | \`abc\` | PASS 1 | ${text} | ${ux} |`),
    "| + | train commit | `abc` | patch | | |",
    "",
    "After the table.",
  ].join("\n");
}

function run(args: string[], body?: string, env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: body,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      TRAIN_MEMBERS_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
      FAKE_GH_FIXTURE: fixture,
      ...env,
    },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const check = (body: string) => run(["-"], body);
function landing(body: string) {
  writeFixture({ body });
  return run(["--pr", String(TRAIN_PR), "--landing"]);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "train-members-"));
  fakeGh = path.join(dir, "fake-gh.mjs");
  fixture = path.join(dir, "fixture.json");
  fs.writeFileSync(
    fakeGh,
    [
      'import fs from "node:fs";',
      "const args = process.argv.slice(2);",
      "const f = JSON.parse(fs.readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));",
      "if (f.down) { console.error('dial tcp: connection refused'); process.exit(1); }",
      "if (args[0] === 'pr' && args[1] === 'view') { console.log(f.body); process.exit(0); }",
      "const files = /pulls\\/(\\d+)\\/files/.exec(args[1] ?? '');",
      // One page unless the caller asks for them all, as gh does.
      "const page = (rows) => (args.includes('--paginate') ? rows : rows.slice(0, 1));",
      "if (files) { console.log(page(f.files[files[1]] ?? []).join('\\n')); process.exit(0); }",
      "const commits = /pulls\\/(\\d+)\\/commits/.exec(args[1] ?? '');",
      "if (commits && f.commits[commits[1]]) {",
      "  console.log(page(f.commits[commits[1]].map((c) => c.join(' '))).join('\\n'));",
      "  process.exit(0);",
      "}",
      "const comment = /issues\\/comments\\/(\\d+)/.exec(args[1] ?? '');",
      "if (comment && f.comments[comment[1]]) {",
      "  const { on, body } = f.comments[comment[1]];",
      "  const url = `https://api.github.com/repos/acme/app/issues/${on}`;",
      "  console.log(JSON.stringify({ issue_url: url, body }));",
      "  process.exit(0);",
      "}",
      "console.error('gh: Not Found (HTTP 404)');",
      "process.exit(1);",
    ].join("\n"),
  );
  writeFixture();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => writeFixture());

describe("before assembly: the draft body", () => {
  it("passes when every UI member cites a text read that names it at its head", () => {
    const res = check(
      table([
        ["#1", "1001", ""],
        ["#2", "", ""],
        ["#3", "", ""],
        ["#4", "1004", ""],
      ]),
    );
    expect(res.out).toContain("PASS (4 members, 2 UI)");
    expect(res.code).toBe(0);
  });

  it("reads the draft from a file as well as from stdin", () => {
    const file = path.join(dir, "draft.md");
    fs.writeFileSync(file, table([["#1", "1001", ""]]));
    expect(run([file]).code).toBe(0);
  });

  it("fails a UI member with a blank text-type cell, and says which", () => {
    const res = check(
      table([
        ["#1", "1001", ""],
        ["#4", "", ""],
      ]),
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain("#4: UI member with no text-type comment id");
    expect(res.out).not.toContain("#1:");
  });

  it("works the UI question out from the files, so a blank tests-only member passes", () => {
    expect(check(table([["#3", "", ""]])).code).toBe(0);
  });

  it("counts a read on the board as well as on the member PR", () => {
    expect(check(table([["#1", "1101", ""]])).code).toBe(0);
  });

  it("fails a read on the board that names another PR", () => {
    const res = check(table([["#1", "1102", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: text-type comment 1102 does not name #1");
  });

  it("fails a read that names no commit of the PR", () => {
    const res = check(table([["#1", "1103", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: text-type comment 1103 names no commit of #1");
  });

  it("fails a read at an older commit, because the work after it went unread", () => {
    const res = check(table([["#1", "1104", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain(
      `#1: text-type comment 1104 reads ${short(old(1))}, 1 commit(s) behind ${short(head(1))}`,
    );
  });

  it("carries a read over a merge, which adds no work of the PR's own", () => {
    const commits = {
      ...COMMITS,
      1: [
        [old(1), 1],
        [head(1), 2],
      ],
    };
    writeFixture({ commits });
    expect(check(table([["#1", "1104", ""]])).code).toBe(0);
  });

  it("fails a comment that is not a text read", () => {
    const res = check(table([["#1", "1105", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: text-type comment 1105 does not read as a text read");
  });

  it("fails an id that is a comment on another PR, or on no PR", () => {
    let res = check(table([["#1", "2001", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: text-type comment 2001 is on #2");
    res = check(table([["#1", "9999", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: text-type comment 9999 does not exist");
  });

  it("fails a text-type cell that is not a comment id", () => {
    const res = check(table([["#1", "see above", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain('#1: text-type cell "see above" is not a comment id');
  });

  it("fails a body with no member table, or one short of the columns", () => {
    let res = check("No table here.");
    expect(res.code).toBe(1);
    expect(res.out).toContain("no member table");
    res = check("| Order | PR | head | reads |\n|---|---|---|---|\n| 1 | #1 | `a` | PASS 1 |\n");
    expect(res.code).toBe(1);
    expect(res.out).toContain("member table has no text-type column");
    expect(res.out).toContain("member table has no apple-ux column");
  });

  it("fails a table with no member rows", () => {
    const res = check(table([]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("no member rows");
  });

  it("is not a PASS when gh cannot answer", () => {
    writeFixture({ down: true });
    const res = check(table([["#1", "1001", ""]]));
    expect(res.code).toBe(2);
    expect(res.out).toContain("connection refused");
  });

  it("does not ask for an apple-ux score yet", () => {
    expect(check(table([["#1", "1001", ""]])).code).toBe(0);
  });
});

describe("--landing: after the merged-tree walk", () => {
  const ux = (cell: string) =>
    landing(
      table([
        ["#1", "1001", cell],
        ["#2", "", ""],
        ["#4", "1004", cell],
      ]),
    );

  it("needs the live PR, because the walk's report is a comment on it", () => {
    const res = run(["-", "--landing"], table([["#1", "1001", ""]]));
    expect(res.code).toBe(2);
    expect(res.out).toContain("--landing needs --pr");
  });

  it("passes at or above the bar with no card", () => {
    expect(ux("90 · High 0 · report 2000").code).toBe(0);
  });

  it("passes under the bar only when the cell names the fix card", () => {
    expect(ux("81 · High 0 · SA-1066 · report 2000").code).toBe(0);
    const res = ux("81 · High 0 · report 2000");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: apple-ux 81 is under 90 with no fix card");
  });

  it("fails a blank score", () => {
    const res = ux("");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: UI member with no apple-ux score");
    expect(res.out).toContain("#4: UI member with no apple-ux score");
  });

  it("fails any open High, even over the bar and even with a card", () => {
    const res = ux("95 · High 1 · SA-1066 · report 2000");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: apple-ux has 1 open High");
  });

  it("fails a cell with no High count, or a cell that does not read", () => {
    let res = ux("95 · report 2000");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: apple-ux cell has no High count");
    res = ux("good · High 0 · report 2000");
    expect(res.code).toBe(1);
    expect(res.out).toContain('#1: apple-ux cell "good · High 0 · report 2000" has no score');
  });

  it("counts a report on the train, on the board, or on a member, if it names the head", () => {
    expect(ux("95 · High 0 · report 2000").code).toBe(0);
    expect(ux("95 · High 0 · report 2002").code).toBe(0);
    expect(ux("95 · High 0 · report 2003").code).toBe(0);
  });

  it("fails a report that leaves out a UI member, or names no sha", () => {
    let res = ux("95 · High 0 · report 2004");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#4: report 2004 does not name #4");
    res = ux("95 · High 0 · report 2005");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: report 2005 does not name #1");
  });

  it("needs a report, in a place that counts, cited the same way by every UI member", () => {
    let res = ux("95 · High 0");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: apple-ux cell cites no report");

    res = ux("95 · High 0 · report 2001");
    expect(res.code).toBe(1);
    expect(res.out).toContain("report 2001 is on #2");

    res = ux("95 · High 0 · report 1001");
    expect(res.code).toBe(1);
    expect(res.out).toContain("report 1001 does not read as an apple-ux read");

    res = ux("95 · High 0 · report 9999");
    expect(res.code).toBe(1);
    expect(res.out).toContain("report 9999 does not exist");

    res = landing(
      table([
        ["#1", "1001", "95 · High 0 · report 2000"],
        ["#4", "1004", "91 · High 0 · report 2000"],
      ]),
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain("UI members cite different walks");
  });

  it("still checks the text-type cells", () => {
    const res = landing(table([["#1", "", "95 · High 0 · report 2000"]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: UI member with no text-type comment id");
  });

  it("passes a train with no UI member", () => {
    expect(landing(table([["#2", "", ""]])).code).toBe(0);
  });
});

describe("false passes", () => {
  const five = (file: string) => {
    writeFixture({ files: { ...FILES, 5: [file] }, commits: { ...COMMITS, 5: [[head(5), 1]] } });
    return check(table([["#5", "", ""]]));
  };

  it.each([
    "apps/web/lib/generic-toast-copy.ts",
    "packages/types/counter-copy.ts",
    "apps/mobile/lib/labels.ts",
    "apps/mobile/components/Row.ts",
    "packages/ui/src/native/tokens.ts",
    "packages/ui/src/web/thing.css",
    "packages/ui/src/web/Thing.tsx",
    "apps/web/tailwind.config.ts",
    "apps/api/src/invoices/invoice-pdf-template.tsx",
  ])("reads %s as UI, so a blank cell fails", (file) => {
    const res = five(file);
    expect(res.code).toBe(1);
    expect(res.out).toContain("#5: UI member with no text-type comment id");
  });

  it.each([
    "apps/api/src/orders/orders.service.ts",
    "apps/api/src/orders/copy-order.ts",
    "packages/types/api/orders.ts",
    "apps/web/lib/README.md",
    "apps/web/mocks/thing.tsx",
  ])("reads %s as not UI", (file) => {
    expect(five(file).code).toBe(0);
  });

  it("finds a UI file past the first page of a large PR", () => {
    writeFixture({ files: { ...FILES, 5: ["apps/api/a.ts", "apps/web/components/B.tsx"] } });
    const res = check(table([["#5", "", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#5: UI member with no text-type comment id");
  });

  it("reads every commit of a large PR, so a later one can't hide", () => {
    const commits = {
      ...COMMITS,
      1: [
        [head(1), 1],
        [old(1), 1],
      ],
    };
    writeFixture({ commits });
    const res = check(table([["#1", "1001", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("1 commit(s) behind");
  });

  it.each(["7", "https://github.com/acme/app/pull/7", ""])(
    'fails a row whose PR cell is "%s", which would drop the member silently',
    (cell) => {
      const res = check(
        table([
          ["#1", "1001", ""],
          [cell, "", ""],
        ]),
      );
      expect(res.code).toBe(1);
      expect(res.out).toContain(`PR cell "${cell}" has no #<n>`);
    },
  );

  it("still leaves a train commit row out, by name or by sha", () => {
    const res = check(
      table([
        ["#1", "1001", ""],
        ["`abc1234`", "", ""],
      ]),
    );
    expect(res.code).toBe(0);
  });

  it("fails a cell with two PRs, because it would check only the first", () => {
    const res = check(table([["#1, #4", "1001", ""]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain('PR cell "#1, #4" names 2 PRs');
  });

  it("does not let an escaped pipe shift the cells", () => {
    const res = check(
      ["| note | PR | text-type | apple-ux |", "|---|---|---|---|", "| a\\|1001 | #1 | | |"].join(
        "\n",
      ),
    );
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: UI member with no text-type comment id");
  });

  it.each([
    [["--pr", String(TRAIN_PR), "--landin"], "unknown flag --landin"],
    [["--landing", "--pr", String(TRAIN_PR), "--dry"], "unknown flag --dry"],
    [["-", "-x"], "unknown flag -x"],
    [["-", "other.md"], "more than one body: other.md"],
  ])("exits 2 on %j, rather than run a weaker check", (args, message) => {
    const res = run(args, table([["#1", "1001", ""]]));
    expect(res.code).toBe(2);
    expect(res.out).toContain(message);
    expect(res.out).toContain("usage:");
  });

  it("fails a score over 100, and a cell with two High counts", () => {
    let res = landing(table([["#1", "1001", "999 · High 0 · report 2000"]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("has no score");
    res = landing(table([["#1", "1001", "95 · High 0 · High 3 · report 2000"]]));
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: apple-ux cell has 2 High counts");
  });
});

describe("the gh stand-in", () => {
  it("is ignored, loudly, outside a Jest worker", () => {
    const res = run(["-"], table([["#1", "1001", ""]]), {
      JEST_WORKER_ID: "",
      PATH: dir,
      Path: dir,
    });
    expect(res.out).toContain("TRAIN_MEMBERS_GH_CMD is ignored");
    expect(res.code).toBe(2);
  });
});

describe("usage", () => {
  it("exits 2 with no input", () => {
    expect(run([]).code).toBe(2);
  });
});
