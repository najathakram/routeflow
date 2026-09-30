/**
 * B202 (commit 3) — there is no visible build stamp on mobile web today, so
 * nobody can tell which deploy a phone (or a browser tab) is actually
 * running. That already produced a false bug report: a client screenshot
 * showing another tenant's branding was actually a stale browser context,
 * not a data bug. The retest note we send a client starts with "you're on
 * the new version when the login screen shows build <sha>" — and it is also
 * how we verify a Railway deploy actually carries a merge, since the mobile
 * web export bakes `EXPO_PUBLIC_BUILD_SHA` in at build time (see Dockerfile).
 *
 * `build-info.ts` doesn't exist for real yet beyond a signature-only stub
 * (every export returns `undefined`), so every assertion below compares a
 * WHOLE returned value via `toBe`/`toEqual` — never a property read off the
 * stub's result — so the suite fails on a clean assertion mismatch, not a
 * crash, before the real implementation lands.
 *
 * `BUILD_SHA` is read from `process.env.EXPO_PUBLIC_BUILD_SHA` at MODULE
 * SCOPE (Expo's babel plugin inlines `EXPO_PUBLIC_*` via a literal text
 * replacement at build time — there is no real `process.env` in the bundle).
 * That means the value is frozen at first `require()`, so every test that
 * cares about a specific `EXPO_PUBLIC_BUILD_SHA` sets `process.env` and then
 * `jest.resetModules()` + re-`require()`s the module, instead of importing it
 * once at the top of the file.
 */

describe("shortBuildSha (pure, total — never throws)", () => {
  // Fresh, ambient-env-independent require per test via resetModules, so
  // whatever EXPO_PUBLIC_BUILD_SHA happens to be set to on this machine/CI
  // runner can never leak into the pure-function pins below.
  function freshShortBuildSha(): (raw?: string | null) => string {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    return require("../lib/build-info").shortBuildSha;
  }

  it("REG-B202/build-info: a full 40-char sha is truncated to its first 7 chars", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("1234567890abcdef1234567890abcdef12345678")).toBe("1234567");
  });

  it("REG-B202/build-info: an already-short 7-char hex sha passes through unchanged", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("a1b2c3d")).toBe("a1b2c3d");
  });

  it("REG-B202/build-info: an uppercase sha is lowercased", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("ABCDEF1234567890ABCDEF1234567890ABCDEF12")).toBe("abcdef1");
  });

  it("REG-B202/build-info: undefined falls back to 'dev'", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha(undefined)).toBe("dev");
  });

  it("REG-B202/build-info: null falls back to 'dev'", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha(null)).toBe("dev");
  });

  it("REG-B202/build-info: empty string falls back to 'dev'", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("")).toBe("dev");
  });

  it("REG-B202/build-info: whitespace-only string falls back to 'dev'", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("   ")).toBe("dev");
  });

  it("REG-B202/build-info: a human-set tag shorter than 7 chars survives untouched, not mangled to 'dev'", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("local")).toBe("local");
  });

  it("REG-B202/build-info: a human-set tag with non-hex characters survives untouched even past 7 chars", () => {
    // "local-build" is 11 chars (past the 7-char truncation threshold) but
    // contains '-', 'l', 'o', 'u', which are not hex digits — it must be
    // returned as-is, proving the branch checks hex-ness and not just length.
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("local-build")).toBe("local-build");
  });

  it("REG-B202/build-info: a version tag like v1.1.0 survives untouched", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("v1.1.0")).toBe("v1.1.0");
  });

  it("REG-B202/build-info: a value with surrounding whitespace is trimmed before the hex check", () => {
    const shortBuildSha = freshShortBuildSha();
    expect(shortBuildSha("  a1b2c3d  ")).toBe("a1b2c3d");
  });
});

describe("BUILD_SHA (module-scope env read, frozen at first require)", () => {
  const ORIGINAL = process.env.EXPO_PUBLIC_BUILD_SHA;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.EXPO_PUBLIC_BUILD_SHA;
    } else {
      process.env.EXPO_PUBLIC_BUILD_SHA = ORIGINAL;
    }
    jest.resetModules();
  });

  it("REG-B202/build-info: is the empty string when EXPO_PUBLIC_BUILD_SHA is unset at module load (local dev)", () => {
    delete process.env.EXPO_PUBLIC_BUILD_SHA;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { BUILD_SHA } = require("../lib/build-info");
    expect(BUILD_SHA).toBe("");
  });

  it("REG-B202/build-info: carries the exact raw value EXPO_PUBLIC_BUILD_SHA held at module load", () => {
    process.env.EXPO_PUBLIC_BUILD_SHA = "1234567890abcdef1234567890abcdef12345678";
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { BUILD_SHA } = require("../lib/build-info");
    expect(BUILD_SHA).toBe("1234567890abcdef1234567890abcdef12345678");
  });
});

describe("buildLabel (single source of truth for the display string)", () => {
  it("REG-B202/build-info: composes 'build <short sha>' for an explicit full sha", () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { buildLabel } = require("../lib/build-info");
    expect(buildLabel("1234567890abcdef1234567890abcdef12345678")).toBe("build 1234567");
  });

  it("REG-B202/build-info: composes 'build dev' for an explicit blank value", () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { buildLabel } = require("../lib/build-info");
    expect(buildLabel("")).toBe("build dev");
  });

  it("REG-B202/build-info: composes 'build <tag>' for an explicit human-set tag", () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { buildLabel } = require("../lib/build-info");
    expect(buildLabel("local")).toBe("build local");
  });

  it("REG-B202/build-info: called with no argument, falls back to the module's own BUILD_SHA — 'build dev' when unset", () => {
    const original = process.env.EXPO_PUBLIC_BUILD_SHA;
    delete process.env.EXPO_PUBLIC_BUILD_SHA;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { buildLabel } = require("../lib/build-info");
    expect(buildLabel()).toBe("build dev");
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_BUILD_SHA;
    } else {
      process.env.EXPO_PUBLIC_BUILD_SHA = original;
    }
    jest.resetModules();
  });

  it("REG-B202/build-info: called with no argument, reflects a baked-in sha set at module load", () => {
    const original = process.env.EXPO_PUBLIC_BUILD_SHA;
    process.env.EXPO_PUBLIC_BUILD_SHA = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fresh module load, see header comment
    const { buildLabel } = require("../lib/build-info");
    expect(buildLabel()).toBe("build abcdef1");
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_BUILD_SHA;
    } else {
      process.env.EXPO_PUBLIC_BUILD_SHA = original;
    }
    jest.resetModules();
  });
});
