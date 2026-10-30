/**
 * SA-1035: the one model list, the exhaustive task map, and the literal pin (P-1): no Claude model id is written in app
 * code outside `ai-models.ts`.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { AI_MODELS, AI_TASKS, aiModelFamily, isAiModelId, type AiTask } from "./ai-models";

const SRC = join(__dirname, "..");

/** Every non-spec .ts file under apps/api/src, found by walking the disk (an untracked new file is seen too). */
function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") out.push(...sourceFiles(p));
    } else if (
      name.endsWith(".ts") &&
      !/\.(spec|test)\.ts$/.test(name) &&
      !p.includes(`${sep}testing${sep}`)
    ) {
      out.push(p);
    }
  }
  return out;
}

describe("AI_MODELS (SA-1035 rule 1)", () => {
  it("lists exactly the four latest models, each with a label and family", () => {
    expect(AI_MODELS.map((m) => [m.id, m.label, m.family])).toEqual([
      ["claude-fable-5-1", "Fable 5.1", "fable"],
      ["claude-opus-5-5", "Opus 5.5", "opus"],
      ["claude-sonnet-5-5", "Sonnet 5.5", "sonnet"],
      ["claude-haiku-5-5", "Haiku 5.5", "haiku"],
    ]);
  });
  it("isAiModelId accepts list ids only", () => {
    expect(isAiModelId("claude-haiku-5-5")).toBe(true);
    expect(isAiModelId("claude-sonnet-4-5")).toBe(false);
    expect(isAiModelId(undefined)).toBe(false);
  });
  it("prices an id by its list family, an older id by its name", () => {
    expect(aiModelFamily("claude-fable-5-1")).toBe("fable");
    expect(aiModelFamily("claude-3-opus-20240229")).toBe("opus");
    expect(aiModelFamily("claude-3-5-haiku-20241022")).toBe("haiku");
    expect(aiModelFamily("claude-sonnet-4-5")).toBe("sonnet");
  });
});

describe("AI_TASKS (SA-1035 rule 2)", () => {
  it("names a setting key and a fallback for every task", () => {
    expect(AI_TASKS.general).toEqual({ key: "claude.model", fallback: "claude-sonnet-5-5" });
    expect(AI_TASKS.bill_scan).toEqual({ key: "claude.scanModel", fallback: "claude-haiku-5-5" });
    expect(AI_TASKS.receipt_scan).toEqual({ key: null, fallback: "claude-opus-5-5" });
    const tasks: AiTask[] = ["general", "bill_scan", "receipt_scan", "statement_scan"];
    expect(Object.keys(AI_TASKS).sort()).toEqual([...tasks].sort());
  });
  it("every task's fallback is on the list (SA ruling: statements move to Sonnet 5.5 too)", () => {
    for (const t of Object.keys(AI_TASKS) as AiTask[]) {
      expect(isAiModelId(AI_TASKS[t].fallback)).toBe(true);
    }
    expect(AI_TASKS.statement_scan).toEqual({ key: null, fallback: "claude-sonnet-5-5" });
  });
});

describe("P-1: no model id literal outside ai-models.ts", () => {
  it("scans every non-spec api source", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500); // the scan really sees the tree
    const offenders: string[] = [];
    for (const f of files) {
      if (f === join(__dirname, "ai-models.ts")) continue;
      const hit = readFileSync(f, "utf8").match(
        /["'`]claude-(?:fable|opus|sonnet|haiku|instant|\d)[a-z0-9.-]*["'`]/,
      );
      if (hit) offenders.push(`${relative(SRC, f).split(sep).join("/")}: ${hit[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
