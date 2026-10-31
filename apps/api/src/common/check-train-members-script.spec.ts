// scripts/check-train-members.mjs: the train member table in a train PR's body. Drives the real script
// as a child process with a fake `gh`, so a spawn or argument bug shows up here too.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SCRIPT = path.resolve(__dirname, "../../../../scripts/check-train-members.mjs");
const TRAIN_PR = 40;

let dir: string;
let fakeGh: string;
let fixture: string;

const FILES: Record<string, string[]> = {
  1: ["apps/web/components/Thing.tsx", "apps/api/src/orders/orders.service.ts"], // UI
  2: ["apps/api/src/orders/orders.service.ts"], // not UI
  3: ["apps/web/app/thing/page.test.tsx", "apps/web/e2e/thing.spec.ts"], // tests only, not UI
  4: ["apps/mobile/app/(driver)/route.tsx"], // UI
};
const COMMENTS: Record<string, number> = { 1001: 1, 1004: 4, 2000: TRAIN_PR, 2001: 2 };

function writeFixture(over: Record<string, unknown> = {}) {
  fs.writeFileSync(fixture, JSON.stringify({ files: FILES, comments: COMMENTS, ...over }));
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
      "if (files) { console.log((f.files[files[1]] ?? []).join('\\n')); process.exit(0); }",
      "const comment = /issues\\/comments\\/(\\d+)/.exec(args[1] ?? '');",
      "if (comment && f.comments[comment[1]] !== undefined) {",
      "  console.log(`https://api.github.com/repos/acme/app/issues/${f.comments[comment[1]]}`);",
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
  it("passes when every UI member cites a text-type comment on its own PR", () => {
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

  it("needs a report on the train PR, cited the same way by every UI member", () => {
    let res = ux("95 · High 0");
    expect(res.code).toBe(1);
    expect(res.out).toContain("#1: apple-ux cell cites no report");

    res = ux("95 · High 0 · report 1001");
    expect(res.code).toBe(1);
    expect(res.out).toContain(`report 1001 is not a comment on train #${TRAIN_PR}`);

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
