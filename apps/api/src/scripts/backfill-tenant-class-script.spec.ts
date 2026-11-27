import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The tenant-class backfill must (1) import under plain Node ESM (Node 24 rejects a named import
 * from the CommonJS @prisma/client) and (2) write nothing on the dry-run path.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.join(API_DIR, "scripts", "backfill-tenant-class.mjs");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("backfill-tenant-class.mjs", () => {
  it("does not named-import PrismaClient from the CommonJS @prisma/client", () => {
    const src = stripComments(fs.readFileSync(SCRIPT, "utf8"));
    expect(src).not.toMatch(/import\s*\{[^}]*PrismaClient[^}]*\}\s*from\s*["']@prisma\/client["']/);
    expect(src).toMatch(/import\s+prismaPkg\s+from\s+["']@prisma\/client["']/);
  });

  it("imports as an ES module without running the CLI or connecting", () => {
    const res = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify("file:///" + SCRIPT.replace(/\\/g, "/"))}); ` +
          `console.log(m.classify("test"), m.classify("acme-co"));`,
      ],
      {
        encoding: "utf8",
        cwd: API_DIR,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      },
    );
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("TEST PRODUCTION");
  });

  it("every write sits after the dry-run return, behind --apply", () => {
    const src = stripComments(fs.readFileSync(SCRIPT, "utf8"));
    const dryReturn = src.indexOf("if (!apply)");
    expect(dryReturn).toBeGreaterThan(-1);
    const before = src.slice(0, dryReturn);
    expect(before).not.toMatch(
      /\.(updateMany|update|create|createMany|delete|deleteMany|upsert)\(/,
    );
    expect(before).not.toMatch(/\$(executeRaw|queryRaw)/);
    // the only writer is the guarded updateMany after the dry-run return
    expect((src.match(/\.updateMany\(/g) ?? []).length).toBe(1);
    expect(src.indexOf(".updateMany(")).toBeGreaterThan(dryReturn);
  });

  it("dry run refuses without a database url (exit 1) and never reaches a write", () => {
    const res = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      cwd: API_DIR,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    expect(res.status).toBe(1);
    expect(res.stdout).not.toMatch(/Applied/);
  });
});
