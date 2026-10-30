/**
 * SA-1035: a Claude response can start with a thinking block, so no caller may read `content[0]` or hunt for the text
 * block itself. `firstText` is the one reader; the structural pin below fails on a new bypass.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { AI_SCAN_MAX_TOKENS, firstText } from "./ai-response";

const SRC = join(__dirname, "..");

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("firstText", () => {
  it("skips a leading thinking block", () => {
    expect(firstText([{ type: "thinking" }, { type: "text", text: "{}" }])).toBe("{}");
  });
  it("is null when there is no text block, or no content", () => {
    expect(firstText([{ type: "thinking" }])).toBeNull();
    expect(firstText([])).toBeNull();
    expect(firstText(undefined)).toBeNull();
  });
  it("leaves room for thinking in max_tokens", () => {
    expect(AI_SCAN_MAX_TOKENS).toBe(8192);
  });
});

describe("structural pin: one reader for a Claude response's text", () => {
  it("no non-spec api source reads content[0] or .content.find( outside ai-response.ts", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    const offenders: string[] = [];
    for (const f of files) {
      if (f === join(__dirname, "ai-response.ts")) continue;
      const text = readFileSync(f, "utf8");
      if (/\bcontent\[0\]|\.content\.find\(/.test(text)) {
        offenders.push(relative(SRC, f).split(sep).join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
