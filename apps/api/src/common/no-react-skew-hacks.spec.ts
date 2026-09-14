/**
 * T2 (S4, Next 15 upgrade — apps/web 14.2.35 → 15.5.25 + React 19): the two React-18-pin hacks
 * must come out **together**, or the half-converted state silently breaks every RTL suite (the
 * `jest.config.js` `moduleNameMapper` pins tests to react@18 while the Dockerfile still installs
 * react@18 for the production build) — see `.claude/pipeline/2026-09-10-next-15/spec.md` R2 and
 * this test plan's "why it earns its place" note. No runtime imports — plain `fs.readFileSync`,
 * matching the house convention (see `no-dead-deps.spec.ts`).
 */
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

type WebManifest = { dependencies?: Record<string, string> };

function readFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function readWebManifest(): WebManifest {
  return JSON.parse(readFile("apps/web/package.json"));
}

describe("apps/web carries no leftover React-18-pin hack (T2, R2)", () => {
  it("apps/web/Dockerfile no longer force-installs react@18 for the production build", () => {
    // Red today: line 48 is `RUN npm install --force --no-save react@18.3.1 react-dom@18.3.1`.
    // Scan LOGICAL lines: a trailing-backslash continuation is joined to the next physical line
    // (single space), so splitting the install across a continuation cannot hide it. Each logical
    // line is reported at the 1-based number of its first physical line.
    const dockerfile = readFile("apps/web/Dockerfile");
    const logicalLines: { line: number; text: string }[] = [];
    let pending: { line: number; text: string } | null = null;
    dockerfile.split("\n").forEach((physical, i) => {
      const trimmed = physical.trimEnd();
      const continues = trimmed.endsWith("\\");
      const part = continues ? trimmed.slice(0, -1) : physical;
      pending = pending
        ? { line: pending.line, text: `${pending.text} ${part}` }
        : { line: i + 1, text: part };
      if (!continues) {
        logicalLines.push(pending);
        pending = null;
      }
    });
    if (pending) logicalLines.push(pending);
    const installLines = logicalLines.filter(({ text }) => /npm install[^\n]*react@18/.test(text));
    expect(
      installLines.map(({ line, text }) => `apps/web/Dockerfile:${line}: ${text.trim()}`),
    ).toEqual([]);
  });

  it('apps/web/jest.config.js moduleNameMapper has no "^react$" key', () => {
    // Red today: line 55 is `"^react$": "<rootDir>/node_modules/react",`.
    const jestConfig = readFile("apps/web/jest.config.js");
    const offendingLines = jestConfig
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /["']\^react\$["']\s*:/.test(text));
    expect(
      offendingLines.map(({ line, text }) => `apps/web/jest.config.js:${line}: ${text.trim()}`),
    ).toEqual([]);
  });

  it("apps/web/package.json dependencies.react stays on the React 19 line", () => {
    // Red today: "^18". Checks the major line, not an exact minor/patch — dependabot moves the
    // patch/minor routinely (e.g. ^19.2.0 -> ^19.3.0), and pinning an exact string here just
    // makes every such bump fail this unrelated skew guard.
    expect(readWebManifest().dependencies?.react).toMatch(/^\^19\./);
  });

  it('apps/web/package.json dependencies["react-dom"] stays on the React 19 line', () => {
    // Red today: "^18". Same rationale as the react case above.
    expect(readWebManifest().dependencies?.["react-dom"]).toMatch(/^\^19\./);
  });
});
