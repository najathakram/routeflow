import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// row 220: `_`-prefixed destructured vars (e.g. `{ a: _a, ...rest }`) must not warn as unused.
describe("eslint no-unused-vars underscore convention (row 220)", () => {
  it("does not warn on an unused _-prefixed destructured variable", () => {
    const apiDir = resolve(__dirname, "../..");
    const run = spawnSync(
      "npx",
      ["eslint", "--stdin", "--stdin-filename", "src/users/users.service.ts", "--format", "json"],
      {
        cwd: apiDir,
        encoding: "utf8",
        input:
          "const user = { a: 1, b: 2, c: 3 };\nconst { a: _a, ...rest } = user;\nexport const out = rest;\n",
      },
    );
    const parsed = JSON.parse(run.stdout) as Array<{
      messages: Array<{ ruleId: string | null; message: string }>;
    }>;
    const unused = parsed[0].messages
      .filter((m) => m.ruleId === "@typescript-eslint/no-unused-vars")
      .map((m) => m.message);
    expect(unused).toEqual([]);
  }, 120_000);
});
