/**
 * B988: the platform-aware assertions must stay EXACT on POSIX and only relax on Windows. The helpers
 * take the platform as a parameter (default: the real one) so both branches are pinned on every OS.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WIN_NODE_ABORT, expectMode, expectRefusedExit, posixPath } from "./helpers/platform";

describe("expectMode", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-platform-"));
  });
  afterEach(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );

  it("POSIX: the permission bits must match exactly (a wrong mode throws)", () => {
    const file = path.join(root, "f");
    fs.writeFileSync(file, "x");
    // a file's mode is whatever the platform gives it: derive the expectation, then break it
    const actual = fs.statSync(file).mode & 0o777;
    expectMode(file, actual, false);
    expect(() => expectMode(file, actual ^ 0o001, false)).toThrow();
  });

  it("Windows: no POSIX bits exist, so it asks only that the owner can write", () => {
    const file = path.join(root, "f");
    fs.writeFileSync(file, "x");
    expectMode(file, 0o600, true); // would be the old failure (0o666 != 0o600) if it compared bits
  });
});

describe("expectRefusedExit", () => {
  it("POSIX: exactly 1", () => {
    expectRefusedExit(1, false);
    expect(() => expectRefusedExit(0, false)).toThrow();
    expect(() => expectRefusedExit(3, false)).toThrow();
    expect(() => expectRefusedExit(WIN_NODE_ABORT, false)).toThrow();
    expect(() => expectRefusedExit(null, false)).toThrow();
  });
  it("Windows: 1 or the libuv abort status, never success", () => {
    expectRefusedExit(1, true);
    expectRefusedExit(WIN_NODE_ABORT, true);
    expect(() => expectRefusedExit(0, true)).toThrow();
    expect(() => expectRefusedExit(null, true)).toThrow();
  });
});

describe("posixPath", () => {
  it("joins with forward slashes whatever the separator", () => {
    expect(posixPath(["registers", "bugs.jsonl"].join(path.sep))).toBe("registers/bugs.jsonl");
  });
});
