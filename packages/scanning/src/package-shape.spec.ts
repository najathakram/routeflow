import * as fs from "fs";
import * as path from "path";

/**
 * M4a-0 — package shape + config assertions for @routeflow/scanning.
 *
 * Asserts the COMPILED-package contract before the implementation lands:
 * package.json's main/types/exports point at dist/, tsconfig.build.json compiles
 * to CommonJS with declarations into dist/, the root postinstall builds this
 * workspace before anything typechecks, turbo.json drops the apps/api#test
 * mirror-inputs special case in favor of check-types depending on ^build, and every
 * app Dockerfile copies the scanning sources in before `npm ci` runs.
 *
 * Reads are UNGUARDED on purpose: a missing or unparsable file must throw and
 * fail the suite, never be swallowed into a `{}` that turns a hard absence into
 * a soft `undefined` comparison.
 */

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// turbo.json carries `//` line comments (JSONC) documenting the cache-key
// trade-offs — strip them (outside string literals, so "https://…" URLs
// survive) before parsing.
function readJsonc(filePath: string): Record<string, any> {
  const text = fs.readFileSync(filePath, "utf8");
  let stripped = "";
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escapeNext) {
      stripped += ch;
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        escapeNext = true;
        stripped += ch;
        continue;
      }
      if (ch === '"') inString = false;
      stripped += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n";
      continue;
    }
    stripped += ch;
  }
  return JSON.parse(stripped);
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const PKG_PATH = path.join(__dirname, "..", "package.json");
const TSCONFIG_BUILD_PATH = path.join(__dirname, "..", "tsconfig.build.json");
const ROOT_PKG_PATH = path.join(REPO_ROOT, "package.json");
const TURBO_JSON_PATH = path.join(REPO_ROOT, "turbo.json");
const DOCKERFILES = ["apps/api/Dockerfile", "apps/web/Dockerfile", "apps/mobile/Dockerfile"];

describe("M4a-0 — @routeflow/scanning package shape (R1, R4)", () => {
  describe("packages/scanning/package.json", () => {
    const pkg = readJson(PKG_PATH);

    it("main points at the compiled entry point", () => {
      expect(pkg.main).toBe("./dist/index.js");
    });

    it("types points at the compiled declaration file", () => {
      expect(pkg.types).toBe("./dist/index.d.ts");
    });

    it("exports['.'].types points at the compiled declaration file", () => {
      expect(pkg.exports?.["."]?.types).toBe("./dist/index.d.ts");
    });

    it("exports['.'].default points at the compiled entry point", () => {
      expect(pkg.exports?.["."]?.default).toBe("./dist/index.js");
    });

    it("scripts.build compiles via tsconfig.build.json", () => {
      expect(pkg.scripts?.build).toEqual(expect.stringContaining("tsc -p tsconfig.build.json"));
    });

    it("has no scripts.postinstall — the root workspace owns the build-before-typecheck order", () => {
      expect(pkg.scripts?.postinstall).toBeUndefined();
    });
  });

  describe("packages/scanning/tsconfig.build.json", () => {
    const tsconfig = readJson(TSCONFIG_BUILD_PATH);

    it("compiles to CommonJS", () => {
      expect(String(tsconfig.compilerOptions?.module)).toMatch(/commonjs/i);
    });

    it("emits declaration files", () => {
      expect(tsconfig.compilerOptions?.declaration).toBe(true);
    });

    it("outputs to dist", () => {
      expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    });
  });

  describe("root package.json", () => {
    const rootPkg = readJson(ROOT_PKG_PATH);

    it("postinstall builds @routeflow/scanning before anything typechecks", () => {
      expect(rootPkg.scripts?.postinstall).toEqual(
        expect.stringContaining("npm run build -w @routeflow/scanning"),
      );
    });

    it("builds @routeflow/pricing BEFORE @routeflow/scanning", () => {
      const post: string = rootPkg.scripts?.postinstall ?? "";
      const pricingAt = post.indexOf("npm run build -w @routeflow/pricing");
      expect(pricingAt).toBeGreaterThanOrEqual(0);
      expect(pricingAt).toBeLessThan(post.indexOf("npm run build -w @routeflow/scanning"));
    });
  });

  describe("turbo.json", () => {
    const turbo = readJsonc(TURBO_JSON_PATH);

    it("drops the apps/api#test mirror-inputs special case", () => {
      expect(turbo.tasks).not.toHaveProperty("@routeflow/api#test");
    });

    it("check-types depends on ^build so the compiled package exists first", () => {
      expect(turbo.tasks?.["check-types"]?.dependsOn).toContain("^build");
    });
  });

  // The image installs from the lockfile, so @routeflow/scanning's sources must be in
  // the build context BEFORE `npm ci` runs — otherwise the workspace link resolves to
  // a directory that does not exist yet and the install fails (or silently skips it).
  describe.each(DOCKERFILES)("%s", (dockerfile) => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, dockerfile), "utf8").split(/\r?\n/);
    const copyIndex = lines.findIndex((line) => /^COPY packages\/scanning\/ /.test(line));
    const npmCiIndex = lines.findIndex((line) => /^RUN npm ci/.test(line));

    it("copies packages/scanning into the build context", () => {
      expect(copyIndex).toBeGreaterThanOrEqual(0);
    });

    it("runs npm ci", () => {
      expect(npmCiIndex).toBeGreaterThanOrEqual(0);
    });

    it("copies packages/scanning before running npm ci", () => {
      expect(copyIndex).toBeLessThan(npmCiIndex);
    });
  });
});
