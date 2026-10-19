import * as fs from "fs";
import * as path from "path";

/**
 * Row 559 (G4): an install URL reaches the UI only from platform config (GET /app-links). No store
 * or APK URL literal may live in apps/web source; tests, fixtures and e2e may use example.test URLs.
 */

const WEB_ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".jest-cache",
  "e2e",
  "test-results",
  "public",
]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|css|json)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

// Built from parts so this file does not contain the literals it forbids.
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "play.google.com", re: new RegExp(["play", "google", "com"].join("\.")) },
  { name: "apps.apple.com", re: new RegExp(["apps", "apple", "com"].join("\.")) },
  { name: "testflight.apple.com", re: new RegExp(["testflight", "apple", "com"].join("\.")) },
  { name: '.apk"', re: /\.apk["'`]/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (SOURCE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

describe("no hardcoded store or APK URL in apps/web source", () => {
  it("no store or APK URL literal in apps/web source", () => {
    const hits: string[] = [];
    for (const file of walk(WEB_ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      for (const { name, re } of FORBIDDEN) {
        if (re.test(text)) hits.push(`${path.relative(WEB_ROOT, file)} contains ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the walker sees the get-the-app page (the scan is not vacuous)", () => {
    const files = Array.from(walk(WEB_ROOT)).map((f) => path.relative(WEB_ROOT, f));
    expect(
      files.some((f) => f.split(path.sep).join("/").endsWith("get-the-app/GetTheAppView.tsx")),
    ).toBe(true);
  });
});
