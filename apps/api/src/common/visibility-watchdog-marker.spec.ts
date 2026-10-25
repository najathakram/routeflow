import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// scripts/visibility-watchdog.mjs --window-marker (opt-in): after the lock and the start line, the
// watchdog publishes a window marker for the Mac visibility timer via `gh api ... PUT`. The write
// is best-effort: a failure never stops or delays the verified flip. Without the flag the watchdog
// makes no `api` call at all. Fake gh records every argv to a calls file.

const SCRIPT = path.resolve(__dirname, "../../../../scripts/visibility-watchdog.mjs");
const LIB = pathToFileURL(
  path.resolve(__dirname, "../../../../scripts/lib/visibility-window.mjs"),
).href;

let dir: string;
let fakeGh: string;
let seq = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "visibility-wd-marker-"));
  fakeGh = path.join(dir, "fake-gh.mjs");
  fs.writeFileSync(
    fakeGh,
    [
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FAKE_CALLS_FILE, JSON.stringify(args) + '\\n');",
      "const sf = process.env.FAKE_STATE_FILE;",
      "const rs = () => { try { return JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { return { visibility: 'PUBLIC' }; } };",
      "if (args[0] === 'api') {",
      "  if (args.includes('PUT')) {",
      "    if (process.env.FAKE_PUT_FAIL) { process.stderr.write('HTTP 422: Unprocessable\\nsecond line\\n'); process.exit(1); }",
      "    process.stdout.write('{}'); process.exit(0);",
      "  }",
      "  // the sha GET",
      "  if (process.env.FAKE_SHA) { process.stdout.write(process.env.FAKE_SHA + '\\n'); process.exit(0); }",
      "  process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1);",
      "} else if (args[0] === 'repo' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({ visibility: rs().visibility })); process.exit(0);",
      "} else if (args[0] === 'repo' && args[1] === 'edit') {",
      "  fs.writeFileSync(sf, JSON.stringify({ visibility: 'PRIVATE' })); process.exit(0);",
      "} else { process.stderr.write('fake-gh: unrecognized\\n'); process.exit(1); }",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(extraArgs: string[], env: Record<string, string> = {}) {
  const n = `case${++seq}`;
  const log = path.join(dir, `${n}.log`);
  const calls = path.join(dir, `${n}.calls`);
  const res = spawnSync(
    process.execPath,
    [SCRIPT, "--minutes", "0.01", "--repo", "acme/test", ...extraArgs],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        // scratch home: os.homedir() reads HOME (POSIX) / USERPROFILE (Windows); never the operator's
        HOME: dir,
        USERPROFILE: dir,
        VISIBILITY_WATCHDOG_GH_CMD: JSON.stringify([process.execPath, fakeGh]),
        VISIBILITY_WATCHDOG_LOG_FILE: log,
        VISIBILITY_WATCHDOG_MARKER_FILE: log.replace(/\.log$/, ".FAILED"),
        VISIBILITY_WATCHDOG_ATTEMPT_DELAYS_MS: "[5,5,5,5,5]",
        FAKE_CALLS_FILE: calls,
        FAKE_STATE_FILE: log.replace(/\.log$/, ".state.json"),
        ...env,
      },
    },
  );
  const callList: string[][] = fs.existsSync(calls)
    ? fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  return { res, calls: callList, log: logText };
}

function parseWithLib(text: string): any {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { parseMarker } from ${JSON.stringify(LIB)};
       process.stdout.write(JSON.stringify(parseMarker(process.argv[1])));`,
      text,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(r.stdout);
}

const field = (argv: string[], key: string): string | undefined => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "-f" && argv[i + 1].startsWith(`${key}=`)) {
      return argv[i + 1].slice(key.length + 1);
    }
  }
  return undefined;
};

describe("visibility-watchdog.mjs --window-marker", () => {
  it("PUTs a marker the timer's parser accepts, then still verifies the flip", () => {
    const before = Date.now();
    const { res, calls, log } = run(["--window-marker"]);
    expect(res.status).toBe(0);
    const put = calls.find((c) => c[0] === "api" && c.includes("PUT"));
    expect(put).toBeDefined();
    expect(put).toContain("repos/najathakram/routeflow-specs/contents/ops/visibility-window.json");
    expect(field(put!, "message")).toMatch(/^ops: visibility window \d{4}-/);
    expect(field(put!, "sha")).toBeUndefined();
    const decoded = Buffer.from(field(put!, "content")!, "base64").toString("utf8");
    const parsed = parseWithLib(decoded);
    expect(parsed.ok).toBe(true);
    expect(parsed.marker.repo).toBe("acme/test");
    expect(parsed.marker.opener).toContain(`pid ${res.pid}`);
    const deadline = Date.parse(parsed.marker.deadline);
    expect(deadline).toBeGreaterThanOrEqual(before + 0.01 * 60_000 - 2000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 0.01 * 60_000 + 2000);
    expect(log).toContain(" marker written");
    expect(log).toContain(" verified ");
  });

  it("includes the existing sha when the marker file already exists", () => {
    const { res, calls } = run(["--window-marker"], { FAKE_SHA: "abc123" });
    expect(res.status).toBe(0);
    const get = calls.find((c) => c[0] === "api" && !c.includes("PUT"));
    expect(get).toBeDefined();
    expect(get).toContain("--jq");
    const put = calls.find((c) => c.includes("PUT"))!;
    expect(field(put, "sha")).toBe("abc123");
  });

  it("a failing PUT logs marker-failed and the watchdog still flips and exits 0", () => {
    const { res, log } = run(["--window-marker"], { FAKE_PUT_FAIL: "1" });
    expect(res.status).toBe(0);
    expect(log).toContain(" marker-failed HTTP 422: Unprocessable");
    expect(log).not.toContain("second line");
    expect(log).toContain(" verified ");
    expect(log.split("\n").findIndex((l) => l.includes(" start "))).toBeLessThan(
      log.split("\n").findIndex((l) => l.includes("marker-failed")),
    );
  });

  it("without the flag no api call is made and no marker line is logged", () => {
    const { res, calls, log } = run([]);
    expect(res.status).toBe(0);
    expect(calls.filter((c) => c[0] === "api")).toHaveLength(0);
    expect(log).not.toContain("marker");
    expect(log).toContain(" verified ");
  });
});
