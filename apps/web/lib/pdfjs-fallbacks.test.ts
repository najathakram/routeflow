import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** P12 (SA-1074 A-1): a build that can't copy pdf.js's fallbacks fails, instead of shipping white scanned pages. */
const WEB = resolve(__dirname, "..");
const SCRIPT = join(WEB, "scripts/copy-pdfjs-fallbacks.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args]);

describe("copy-pdfjs-fallbacks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pdfjs-fallbacks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("exits non-zero when a file is missing from the package, and copies nothing", () => {
    writeFileSync(join(dir, "jbig2_nowasm_fallback.js"), "x");
    const to = join(dir, "out");
    const result = run("--from", dir, "--to", to);
    expect(result.status).not.toBe(0);
    expect(result.stderr.toString()).toContain("openjpeg_nowasm_fallback.js");
    expect(existsSync(to)).toBe(false);
  });

  it("copies both files from the installed package", () => {
    const to = join(dir, "out");
    const result = run("--to", to);
    expect(result.status).toBe(0);
    expect(existsSync(join(to, "jbig2_nowasm_fallback.js"))).toBe(true);
    expect(existsSync(join(to, "openjpeg_nowasm_fallback.js"))).toBe(true);
  });

  it("runs before every build and dev server, and its output stays out of git", () => {
    const { scripts } = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8"));
    expect(scripts.prebuild).toContain("copy-pdfjs-fallbacks.mjs");
    expect(scripts.predev).toContain("copy-pdfjs-fallbacks.mjs");
    expect(readFileSync(join(WEB, "../../.gitignore"), "utf8")).toContain("apps/web/public/pdfjs/");
  });
});
