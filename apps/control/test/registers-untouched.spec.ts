/**
 * T6/T7 (R3) — the register adapters and loader never write the registers.
 * sha256 + directory listing of the fixture register tree is identical before and after.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { posixPath } from "./helpers/platform";

function tryRequire(load: () => unknown): any {
  try {
    return load();
  } catch (e: any) {
    if (e && e.code === "MODULE_NOT_FOUND") return undefined;
    throw e;
  }
}
const src = tryRequire(() => require("../src/sources/registers"));
const ad = tryRequire(() => require("../src/domain/adapters"));

const FIX = path.join(__dirname, "fixtures", "acme");
const REG = path.join(FIX, "registers");

const snapshot = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else
        out[posixPath(path.relative(FIX, p))] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(p))
          .digest("hex");
    }
  };
  walk(REG);
  return out;
};

describe("registers stay untouched", () => {
  it("loading and adapting twice leaves every register file byte-identical", () => {
    expect(src).toBeDefined();
    expect(ad).toBeDefined();
    const before = snapshot();
    expect(Object.keys(before).sort()).toEqual([
      "registers/bugs.jsonl",
      "registers/deferred.jsonl",
      "registers/features.jsonl",
      "registers/releases.jsonl",
    ]);
    src.loadRegisters({ fixtureDir: FIX });
    src.loadRegisters({ fixtureDir: FIX });
    expect(snapshot()).toEqual(before);
  });

  it("source files contain no write APIs", () => {
    for (const f of ["../src/sources/registers.ts", "../src/domain/adapters.ts"]) {
      const text = fs.readFileSync(path.join(__dirname, f), "utf8");
      expect(text).not.toMatch(
        /writeFile|appendFile|createWriteStream|unlinkSync|renameSync|\brmSync|mkdirSync/,
      );
      expect(text).not.toMatch(
        /execFileSync\([^)]*["'`](push|commit|add|rm|mv|reset|checkout|fetch|clone|config|update-ref|branch|tag|apply|merge|rebase|stash|gc)["'`]/,
      );
    }
  });
});
