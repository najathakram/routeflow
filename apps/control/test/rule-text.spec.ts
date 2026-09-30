/**
 * T35 (R19) — the spec §8 rule text is present verbatim in CLAUDE.md and the
 * roadmap README; CLAUDE.md stays within the 25 KB house cap.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Blockquote that follows the "**Insert in `<marker>` ...**" line in spec §8. */
function specQuote(marker: string): string {
  const spec = read(".claude/pipeline/2026-09-30-control-system/spec.md");
  const sec = spec.slice(spec.indexOf("## 8. The amended bookkeeping rule"));
  const lines = sec.split("\n");
  const start = lines.findIndex((l) => l.startsWith("**Insert in") && l.includes(marker));
  if (start < 0) throw new Error(`spec §8 marker not found: ${marker}`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(">")) out.push(lines[i].replace(/^>\s?/, ""));
    else if (out.length) break;
  }
  return out.join("\n");
}

describe("T35 rule text (R19)", () => {
  it(".claude/control/README.md contains the full spec §8 CLAUDE.md block verbatim", () => {
    const para = specQuote("`CLAUDE.md`");
    expect(para).toContain("## Control system (lanes, tasks, events)");
    expect(norm(read(".claude/control/README.md"))).toContain(norm(para));
  });

  it("CLAUDE.md has a condensed ## Control system section (<= 700 B) with the key facts", () => {
    const c = read("CLAUDE.md");
    const start = c.indexOf("## Control system");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = c.slice(start + 3);
    const next = rest.search(/^## /m);
    const section = next < 0 ? c.slice(start) : c.slice(start, start + 3 + next);
    for (const k of [
      "ctl/state",
      "npm run ctl -- next --lane",
      "pr-body",
      "Bookkeeping Option B",
      ".claude/control/README.md",
    ]) {
      expect(section).toContain(k);
    }
    expect(Buffer.byteLength(section.trimEnd())).toBeLessThanOrEqual(700);
  });

  it("CLAUDE.md stays <= 25,600 B", () => {
    expect(Buffer.byteLength(read("CLAUDE.md"))).toBeLessThanOrEqual(25600);
  });

  it("roadmap README contains its spec §8 paragraph verbatim", () => {
    const para = specQuote("`.claude/roadmap/README.md`");
    expect(para).toContain("Not here");
    expect(norm(read(".claude/roadmap/README.md"))).toContain(norm(para));
  });
});
