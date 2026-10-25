import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// scripts/lib/visibility-window.mjs — the pure marker contract shared by the watchdog (writer)
// and the Mac visibility timer (reader). The module is plain ESM, which a CommonJS Jest worker
// cannot import directly, so each call runs in a short `node` child and returns JSON.
const LIB = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/lib/visibility-window.mjs"),
).href;

function call(fn: string, ...args: unknown[]): any {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import * as l from ${JSON.stringify(LIB)};
       const [fn, args] = JSON.parse(process.argv[1]);
       const v = typeof l[fn] === "function" ? l[fn](...args) : l[fn];
       process.stdout.write(JSON.stringify(v));`,
      JSON.stringify([fn, args]),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) throw new Error(`lib call ${fn} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

const lib = {
  get MARKER_REPO(): string {
    return call("MARKER_REPO");
  },
  get MARKER_PATH(): string {
    return call("MARKER_PATH");
  },
  get STALE_MS(): number {
    return call("STALE_MS");
  },
  get GRACE_MS(): number {
    return call("GRACE_MS");
  },
  get MAX_WINDOW_MS(): number {
    return call("MAX_WINDOW_MS");
  },
  buildMarker: (a: Record<string, string>) => call("buildMarker", a) as Record<string, unknown>,
  parseMarker: (t: string) =>
    call("parseMarker", t) as { ok: true; marker: any } | { ok: false; reason: string },
  decide: (a: { markerText: string | null; repo: string; nowMs: number }) =>
    call("decide", a) as { action: string; reason: string },
};

const REPO = "najathakram/routeflow";
const OPENED = "2026-10-25T10:00:00.000Z";
const DEADLINE = "2026-10-25T10:45:00.000Z";
const deadlineMs = Date.parse(DEADLINE);

function text(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    repo: REPO,
    openedAt: OPENED,
    deadline: DEADLINE,
    opener: "pc/host pid 1",
    ...over,
  });
}

describe("visibility-window lib", () => {
  it("exports the pinned constants", () => {
    expect(lib.MARKER_REPO).toBe("najathakram/routeflow-specs");
    expect(lib.MARKER_PATH).toBe("ops/visibility-window.json");
    expect(lib.STALE_MS).toBe(6 * 3600_000);
    expect(lib.GRACE_MS).toBe(2 * 60_000);
    expect(lib.MAX_WINDOW_MS).toBe(4 * 3600_000);
  });

  it("buildMarker round-trips through parseMarker", () => {
    const m = lib.buildMarker({ repo: REPO, openedAt: OPENED, deadline: DEADLINE, opener: "x" });
    expect(m).toEqual({ v: 1, repo: REPO, openedAt: OPENED, deadline: DEADLINE, opener: "x" });
    const parsed = lib.parseMarker(JSON.stringify(m));
    expect(parsed.ok).toBe(true);
  });

  describe("parseMarker", () => {
    it("accepts a valid marker", () => {
      const r = lib.parseMarker(text());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.marker.repo).toBe(REPO);
    });
    it.each([
      ["not JSON", "{nope"],
      ["wrong version", text({ v: 2 })],
      ["missing repo", text({ repo: undefined })],
      ["empty opener", text({ opener: "" })],
      ["bad openedAt", text({ openedAt: "yesterday" })],
      ["bad deadline", text({ deadline: 12 })],
      ["deadline before openedAt", text({ deadline: "2026-10-25T09:00:00.000Z" })],
      ["window over 4h", text({ deadline: "2026-10-25T14:00:01.000Z" })],
    ])("rejects %s", (_n, body) => {
      const r = lib.parseMarker(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    });
    it("accepts exactly 4h", () => {
      expect(lib.parseMarker(text({ deadline: "2026-10-25T14:00:00.000Z" })).ok).toBe(true);
    });
  });

  describe("decide", () => {
    const base = { repo: REPO };
    it("none/no-marker when missing", () => {
      expect(lib.decide({ markerText: null, ...base, nowMs: deadlineMs })).toEqual({
        action: "none",
        reason: "no-marker",
      });
    });
    it("none/malformed for garbage", () => {
      const d = lib.decide({ markerText: "garbage", ...base, nowMs: deadlineMs });
      expect(d.action).toBe("none");
      expect(d.reason).toMatch(/^malformed:/);
    });
    it("none/repo-mismatch for another repo", () => {
      const d = lib.decide({ markerText: text({ repo: "a/b" }), ...base, nowMs: deadlineMs + 1e6 });
      expect(d).toEqual({ action: "none", reason: "repo-mismatch" });
    });
    it("none/stale past deadline + 6h", () => {
      const d = lib.decide({
        markerText: text(),
        ...base,
        nowMs: deadlineMs + lib.STALE_MS + 1,
      });
      expect(d).toEqual({ action: "none", reason: "stale" });
    });
    it("wait before the deadline", () => {
      expect(lib.decide({ markerText: text(), ...base, nowMs: deadlineMs - 1 })).toEqual({
        action: "wait",
        reason: "deadline-not-reached",
      });
    });
    it("wait inside the grace window", () => {
      const d = lib.decide({ markerText: text(), ...base, nowMs: deadlineMs + lib.GRACE_MS - 1 });
      expect(d.action).toBe("wait");
    });
    it("check once past deadline + grace", () => {
      const d = lib.decide({ markerText: text(), ...base, nowMs: deadlineMs + lib.GRACE_MS });
      expect(d.action).toBe("check");
    });
    it("still check exactly at the stale edge", () => {
      const d = lib.decide({ markerText: text(), ...base, nowMs: deadlineMs + lib.STALE_MS });
      expect(d.action).toBe("check");
    });
  });
});
