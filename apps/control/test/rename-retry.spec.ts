/**
 * B988: the clone is renamed into place right after git exits. Windows transiently refuses that
 * rename (EPERM/EBUSY/EACCES) while a scanner or indexer holds a handle in the fresh clone, which
 * surfaced as `ctl: EPERM: operation not permitted, rename ...clone-a.ctl-tmp-...` in roughly one
 * parallel CLI spec in thirty. On Windows only, `renameDirRetrying` retries those codes with a short back-off and
 * throws everything else unchanged; on POSIX it renames directly (no retry, no thread-blocking sleep).
 * Pure: the rename, the sleep and the platform are injected.
 */
import { renameDirRetrying } from "../src/sources/state-branch";

const err = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

describe("renameDirRetrying", () => {
  it("renames at once when nothing is refused (no sleep)", () => {
    const rename = jest.fn();
    const sleep = jest.fn();
    renameDirRetrying("a", "b", rename, sleep, true);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("a", "b");
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(["EPERM", "EBUSY", "EACCES"])("retries a transient %s and then succeeds", (code) => {
    const rename = jest
      .fn()
      .mockImplementationOnce(() => {
        throw err(code);
      })
      .mockImplementationOnce(() => {
        throw err(code);
      })
      .mockImplementation(() => undefined);
    const sleep = jest.fn();
    renameDirRetrying("a", "b", rename, sleep, true);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([50, 100]); // growing back-off
  });

  it("throws any other error at once, unchanged (EEXIST / ENOENT are real answers)", () => {
    for (const code of ["EEXIST", "ENOENT", "ENOTEMPTY"]) {
      const rename = jest.fn(() => {
        throw err(code);
      });
      const sleep = jest.fn();
      expect(() => renameDirRetrying("a", "b", rename, sleep, true)).toThrow(code);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("gives up after the retry budget and throws the last transient error", () => {
    const rename = jest.fn(() => {
      throw err("EPERM");
    });
    const sleep = jest.fn();
    expect(() => renameDirRetrying("a", "b", rename, sleep, true)).toThrow("EPERM");
    expect(rename).toHaveBeenCalledTimes(9); // the first try plus 8 retries
    expect(sleep).toHaveBeenCalledTimes(8);
  });

  it.each(["EPERM", "EBUSY", "EACCES"])(
    "POSIX (win=false) never retries a %s: one rename call, no sleep, thrown unchanged",
    (code) => {
      const rename = jest.fn(() => {
        throw err(code);
      });
      const sleep = jest.fn();
      expect(() => renameDirRetrying("a", "b", rename, sleep, false)).toThrow(code);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled(); // the back-off blocks the thread; Linux must not pay it
    },
  );

  it("POSIX (win=false) renames directly", () => {
    const rename = jest.fn();
    const sleep = jest.fn();
    renameDirRetrying("a", "b", rename, sleep, false);
    expect(rename).toHaveBeenCalledWith("a", "b");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("the platform default is Windows-only: retries exactly when process.platform is win32", () => {
    const rename = jest
      .fn()
      .mockImplementationOnce(() => {
        throw err("EPERM");
      })
      .mockImplementation(() => undefined);
    const sleep = jest.fn();
    if (process.platform === "win32") {
      renameDirRetrying("a", "b", rename, sleep);
      expect(rename).toHaveBeenCalledTimes(2);
    } else {
      expect(() => renameDirRetrying("a", "b", rename, sleep)).toThrow("EPERM");
      expect(rename).toHaveBeenCalledTimes(1);
    }
  });

  it("really renames a directory with the default seams", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-rename-"));
    try {
      fs.mkdirSync(path.join(root, "from"));
      fs.writeFileSync(path.join(root, "from", "f.txt"), "x");
      renameDirRetrying(path.join(root, "from"), path.join(root, "to"));
      expect(fs.readFileSync(path.join(root, "to", "f.txt"), "utf8")).toBe("x");
      expect(fs.existsSync(path.join(root, "from"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
