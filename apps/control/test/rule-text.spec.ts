/**
 * T35 (R19) — the full control-system rule text lives in .claude/control/README.md.
 * The CLAUDE.md pointer and roadmap paragraph ship in their own docs PRs (lead ruling
 * 2026-09-30), so this spec pins only the README, and reads no untracked file.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("T35 rule text (R19)", () => {
  it(".claude/control/README.md carries the full rule with its key facts", () => {
    const readme = norm(read(".claude/control/README.md"));
    for (const k of [
      "### Control system (lanes, tasks, events)",
      "orphan branch **`ctl/state`**",
      "never put it in a PR",
      "npm run ctl -- next --lane <lane>",
      "npm run ctl -- pr-body <task>",
      "keep Bookkeeping Option B unchanged",
      "never typed",
    ]) {
      expect(readme).toContain(k);
    }
  });
});
