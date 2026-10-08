import fs from "fs";
import path from "path";
import { LEVEL_CODES_UI_ENABLED } from "./flags";

describe("LEVEL_CODES_UI_ENABLED", () => {
  it("stays false until U-8 (the per-level codes UI is built but hidden)", () => {
    expect(LEVEL_CODES_UI_ENABLED).toBe(false);
  });

  it("is only ever flipped in flags.ts (no other file re-declares it)", () => {
    const dirs = ["components", "app", "lib"].map((d) => path.join(__dirname, "../..", d));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== ".next") walk(p);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          if (/(const|let|var)\s+LEVEL_CODES_UI_ENABLED\s*=/.test(fs.readFileSync(p, "utf8")))
            hits.push(path.basename(p));
        }
      }
    };
    dirs.forEach(walk);
    expect(hits).toEqual(["flags.ts"]);
  });
});
