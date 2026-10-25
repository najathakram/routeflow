import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// scripts/visibility-timer.mjs contract — the off-machine safety net for the watchdog. A Mac
// launchd job runs it every 5 minutes: it reads the window marker the watchdog publishes, and
// flips the repo private once the marker's deadline (plus a 2 min grace) has passed. A fake `gh`
// (VISIBILITY_TIMER_GH_CMD, honoured only under JEST_WORKER_ID) records every argv to a calls
// file so each case can assert which gh verbs ran. The clock is VISIBILITY_TIMER_NOW_MS.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/visibility-timer.mjs");
const REPO = "acme/test";
const OPENED = "2026-10-25T10:00:00.000Z";
const DEADLINE = "2026-10-25T10:45:00.000Z";
const deadlineMs = Date.parse(DEADLINE);

let dir: string;
let fakeGh: string;
let seq = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "visibility-timer-"));
  fakeGh = path.join(dir, "fake-gh.mjs");
  fs.writeFileSync(
    fakeGh,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify(args) + '\\n');",
      "const stateFile = process.env.FAKE_STATE_FILE;",
      "const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { visibility: process.env.FAKE_VIS || 'PUBLIC', edits: 0 }; } };",
      "const writeState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));",
      "if (args[0] === 'api' && /^repos\\/[^/]+\\/[^/]+$/.test(args[1])) {",
      "  const r = process.env.FAKE_REPO_MODE || 'ok';",
      "  if (r === '404') { process.stderr.write('gh: Not Found (HTTP 404)\\nsecond line\\n'); process.exit(1); }",
      "  if (r === 'error') { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }",
      "  process.stdout.write(args[1].slice('repos/'.length) + '\\n');",
      "  process.exit(0);",
      "} else if (args[0] === 'api') {",
      "  const m = process.env.FAKE_MARKER_MODE || 'ok';",
      "  if (m === '404') { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }",
      "  if (m === 'error') { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }",
      "  process.stdout.write(fs.readFileSync(process.env.FAKE_MARKER_FILE, 'utf8'));",
      "  process.exit(0);",
      "} else if (args[0] === 'repo' && args[1] === 'view') {",
      "  if (process.env.FAKE_VIEW_FAIL) { process.stderr.write('HTTP 500\\n'); process.exit(1); }",
      "  process.stdout.write(readState().visibility + '\\n');",
      "  process.exit(0);",
      "} else if (args[0] === 'repo' && args[1] === 'edit') {",
      "  const s = readState(); s.edits += 1;",
      "  if (process.env.FAKE_EDIT_MODE === 'fail') { writeState(s); process.stderr.write('HTTP 403: Forbidden\\n'); process.exit(1); }",
      "  s.visibility = 'PRIVATE'; writeState(s); process.exit(0);",
      "} else { process.stderr.write('fake-gh: unrecognized ' + args.join(' ') + '\\n'); process.exit(1); }",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function marker(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    repo: REPO,
    openedAt: OPENED,
    deadline: DEADLINE,
    opener: "pc/host pid 7",
    ...over,
  });
}

interface Ctx {
  log: string;
  calls: string;
  markerFile: string;
}

function ctx(): Ctx {
  const n = `case${++seq}`;
  return {
    log: path.join(dir, `${n}.log`),
    calls: path.join(dir, `${n}.calls`),
    markerFile: path.join(dir, `${n}.marker.json`),
  };
}

function run(c: Ctx, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      VISIBILITY_TIMER_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
      VISIBILITY_TIMER_LOG_FILE: c.log,
      VISIBILITY_TIMER_ATTEMPT_DELAYS_MS: "[0,0]",
      FAKE_CALLS_FILE: c.calls,
      FAKE_STATE_FILE: c.calls.replace(/\.calls$/, ".state.json"),
      FAKE_MARKER_FILE: c.markerFile,
      ...env,
    },
  });
}

function calls(c: Ctx): string[][] {
  if (!fs.existsSync(c.calls)) return [];
  return fs
    .readFileSync(c.calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const verbs = (c: Ctx, a: string, b?: string) =>
  calls(c).filter((x) => x[0] === a && (b === undefined || x[1] === b));

function logLines(c: Ctx): string[] {
  return fs.existsSync(c.log) ? fs.readFileSync(c.log, "utf8").trim().split("\n") : [];
}

const NOW = (ms: number) => ({ VISIBILITY_TIMER_NOW_MS: String(ms) });
const ARGS = ["--repo", REPO];

describe("visibility-timer.mjs contract", () => {
  it("reads the marker from the marker repo with the raw Accept header", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    run(c, ARGS, NOW(deadlineMs - 60_000));
    const api = verbs(c, "api");
    expect(api).toHaveLength(1);
    expect(api[0][1]).toBe("repos/najathakram/routeflow-specs/contents/ops/visibility-window.json");
    expect(api[0].join(" ")).toContain("Accept: application/vnd.github.raw");
  });

  it("deadline not reached: one log line, no repo view, no edit, exit 0", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, NOW(deadlineMs - 60_000));
    expect(res.status).toBe(0);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ wait /);
    expect(lines[0]).toContain("deadline-not-reached");
    expect(lines[0]).toContain(REPO);
    expect(lines[0]).toContain(DEADLINE);
    expect(lines[0]).toContain("pc/host pid 7");
    expect(res.stdout).toContain("deadline-not-reached");
    expect(res.stderr).toContain("WARNING: test override VISIBILITY_TIMER_GH_CMD active");
  });

  it("within the 2 min grace: still waits", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, NOW(deadlineMs + 60_000));
    expect(res.status).toBe(0);
    expect(verbs(c, "repo")).toHaveLength(0);
  });

  it("already private past the deadline: view called, no edit, log already-private, exit 0", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, { ...NOW(deadlineMs + 5 * 60_000), FAKE_VIS: "PRIVATE" });
    expect(res.status).toBe(0);
    expect(verbs(c, "repo", "view")).toHaveLength(1);
    expect(verbs(c, "repo", "edit")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" already-private ");
  });

  it("public past the deadline: one edit, read-back PRIVATE, log flipped, exit 0", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, { ...NOW(deadlineMs + 5 * 60_000), FAKE_VIS: "PUBLIC" });
    expect(res.status).toBe(0);
    const edits = verbs(c, "repo", "edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual([
      "repo",
      "edit",
      REPO,
      "--visibility",
      "private",
      "--accept-visibility-change-consequences",
    ]);
    const lines = logLines(c);
    expect(lines.some((l) => l.includes(" flipped ") && l.includes("attempt=1"))).toBe(true);
    // initial view + one read-back
    expect(verbs(c, "repo", "view").length).toBeGreaterThanOrEqual(2);
    expect(verbs(c, "repo", "view")[0].join(" ")).toContain("--json visibility --jq .visibility");
  });

  it("edit keeps failing: three attempts, exit 1, error logged", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, {
      ...NOW(deadlineMs + 5 * 60_000),
      FAKE_VIS: "PUBLIC",
      FAKE_EDIT_MODE: "fail",
    });
    expect(res.status).toBe(1);
    expect(verbs(c, "repo", "edit")).toHaveLength(3);
    const lines = logLines(c);
    expect(lines.filter((l) => l.includes(" attempt "))).toHaveLength(3);
    expect(lines[lines.length - 1]).toContain(" error ");
    expect(lines.some((l) => l.includes(" flipped "))).toBe(false);
  });

  it("visibility unreadable past the deadline: logs visibility-unreadable, exit 1, no edit", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, { ...NOW(deadlineMs + 5 * 60_000), FAKE_VIEW_FAIL: "1" });
    expect(res.status).toBe(1);
    expect(verbs(c, "repo", "edit")).toHaveLength(0);
    expect(logLines(c).join("\n")).toContain("visibility-unreadable");
  });

  it("malformed marker: no view, no edit, one malformed line, exit 0", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, "{ this is not json");
    const res = run(c, ARGS, NOW(deadlineMs + 5 * 60_000));
    expect(res.status).toBe(0);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("malformed:");
  });

  it("missing marker (404): no view, no edit, one no-marker line, exit 0", () => {
    const c = ctx();
    const res = run(c, ARGS, { ...NOW(deadlineMs + 5 * 60_000), FAKE_MARKER_MODE: "404" });
    expect(res.status).toBe(0);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no-marker");
  });

  it("specs repo unreadable (404) behind a contents 404: marker-unreadable, exit 1, no flip", () => {
    const c = ctx();
    const res = run(c, ARGS, {
      ...NOW(deadlineMs + 5 * 60_000),
      FAKE_MARKER_MODE: "404",
      FAKE_REPO_MODE: "404",
    });
    expect(res.status).toBe(1);
    const api = verbs(c, "api");
    expect(api).toHaveLength(2);
    expect(api[1]).toEqual(["api", "repos/najathakram/routeflow-specs", "--jq", ".full_name"]);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" marker-unreadable ");
    expect(lines[0]).toContain("Not Found (HTTP 404)");
    expect(lines[0]).not.toContain("second line");
    expect(lines[0]).not.toContain(" none ");
    expect(res.stdout).toContain("marker-unreadable");
  });

  it("specs repo readable + contents 404: no-marker, exit 0, repo probed once", () => {
    const c = ctx();
    const res = run(c, ARGS, {
      ...NOW(deadlineMs + 5 * 60_000),
      FAKE_MARKER_MODE: "404",
      FAKE_REPO_MODE: "ok",
    });
    expect(res.status).toBe(0);
    const api = verbs(c, "api");
    expect(api).toHaveLength(2);
    expect(api[1]).toEqual(["api", "repos/najathakram/routeflow-specs", "--jq", ".full_name"]);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("no-marker");
    expect(lines[0]).not.toContain("marker-unreadable");
  });

  it("marker unreadable (non-404 failure): logs marker-unreadable, exit 1, no flip", () => {
    const c = ctx();
    const res = run(c, ARGS, { ...NOW(deadlineMs + 5 * 60_000), FAKE_MARKER_MODE: "error" });
    expect(res.status).toBe(1);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("marker-unreadable");
  });

  it("stale marker (deadline + 6h passed): no action", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    const res = run(c, ARGS, NOW(deadlineMs + 6 * 3600_000 + 1000));
    expect(res.status).toBe(0);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("stale");
  });

  it("marker for another repo: no action", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker({ repo: "someone/else" }));
    const res = run(c, ARGS, NOW(deadlineMs + 5 * 60_000));
    expect(res.status).toBe(0);
    expect(verbs(c, "repo")).toHaveLength(0);
    const lines = logLines(c);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("repo-mismatch");
  });

  it("--marker-repo changes where the marker is read from", () => {
    const c = ctx();
    fs.writeFileSync(c.markerFile, marker());
    run(c, [...ARGS, "--marker-repo", "acme/ops"], NOW(deadlineMs - 1000));
    expect(verbs(c, "api")[0][1]).toBe("repos/acme/ops/contents/ops/visibility-window.json");
  });

  it("a bad flag exits 2 with usage, no gh call and no log line", () => {
    const c = ctx();
    const res = run(c, ["--bogus"], NOW(deadlineMs));
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage:");
    expect(calls(c)).toHaveLength(0);
    expect(logLines(c)).toHaveLength(0);
  });

  it("--repo without a value exits 2", () => {
    const c = ctx();
    const res = run(c, ["--repo"], NOW(deadlineMs));
    expect(res.status).toBe(2);
    expect(calls(c)).toHaveLength(0);
  });

  it("--help exits 0 with no gh call and no log line", () => {
    const c = ctx();
    const res = run(c, ["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("usage:");
    expect(calls(c)).toHaveLength(0);
    expect(logLines(c)).toHaveLength(0);
  });

  it("test overrides are ignored loudly outside a Jest worker", () => {
    const c = ctx();
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.JEST_WORKER_ID;
    // the operator's REAL log must stay untouched (os.homedir() reads HOME on POSIX, USERPROFILE on Windows)
    const realLog = path.join(os.homedir(), ".routeflow", "ops", "visibility-timer.log");
    const realBefore = fs.existsSync(realLog) ? fs.statSync(realLog).size : null;
    const res = spawnSync(process.execPath, [SCRIPT, "--repo", REPO, "--marker-repo", "acme/ops"], {
      encoding: "utf8",
      timeout: 60_000,
      // A real `gh` call would be made if the override were ignored; point PATH at an empty dir
      // so it fails fast as marker-unreadable instead of reaching the network.
      env: {
        ...env,
        PATH: dir,
        HOME: dir,
        USERPROFILE: dir,
        VISIBILITY_TIMER_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
        VISIBILITY_TIMER_LOG_FILE: c.log,
        FAKE_CALLS_FILE: c.calls,
      },
    });
    expect(res.stderr).toContain("VISIBILITY_TIMER_GH_CMD is ignored outside test");
    expect(res.stderr).not.toContain("WARNING: test override");
    expect(calls(c)).toHaveLength(0);
    expect(res.status).toBe(1);
    // the log override was ignored too: the real path lives under HOME (the scratch dir)
    expect(fs.existsSync(c.log)).toBe(false);
    expect(fs.existsSync(path.join(dir, ".routeflow", "ops", "visibility-timer.log"))).toBe(true);
    // ...and nothing was appended to the operator's real home log
    const realAfter = fs.existsSync(realLog) ? fs.statSync(realLog).size : null;
    expect(realAfter).toBe(realBefore);
  });
});
