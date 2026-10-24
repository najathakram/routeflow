/**
 * Server-token PR, review F3: the process-level wiring of the write probe. `enforceReadOnly` is
 * unit-tested elsewhere; this runs the real compiled entry point (`main.js`) against a fake GitHub
 * on 127.0.0.1 and proves what the OWNER sees: exit 1 with the message and no listener when the
 * token can write (either repo) or cannot be verified, a normal boot with the two log lines when
 * both repos answer 403, and no half-booted process when a later boot step rejects.
 *
 * The compiled copy is the once-per-run build (test/global-setup.ts), never `dist/`.
 * The GitHub base is redirected to the fake server by the Jest-only seam in main.ts
 * (CONTROL_TEST_GITHUB_BASE, honoured only when JEST_WORKER_ID is set), so nothing leaves 127.0.0.1.
 */
import { spawn } from "child_process";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { buildPrivateDist } from "./helpers/build-dist";
import type { PrivateDist } from "./helpers/build-dist";
import { expectRefusedExit, scaled } from "./helpers/platform";

jest.setTimeout(scaled(120_000));

// the once-per-run build from test/global-setup.ts (a private one when run outside it)
let dist: PrivateDist;
const TOKEN = "tok-FAKE-boot-refusal-0123456789";
const B64 = Buffer.from("x-access-token:" + TOKEN).toString("base64");
const PRODUCT = "acme/acme";
const STATE = "acme/acme-control-state";

beforeAll(() => {
  dist = buildPrivateDist("boot-refusal");
});
afterAll(() => dist?.cleanup());

interface Fake {
  base: string;
  /** Every request path (with query) in arrival order. */
  seen: string[];
  /** Authorization header values seen on the probes. */
  auths: Array<string | undefined>;
  close(): Promise<void>;
}
/** Answer the receive-pack advertisement of each repo with its scripted statuses (last repeats). */
async function fake(plan: Record<string, number[]>): Promise<Fake> {
  const seen: string[] = [];
  const auths: Array<string | undefined> = [];
  const left: Record<string, number[]> = Object.fromEntries(
    Object.entries(plan).map(([k, v]) => [k, v.slice()]),
  );
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    const m = /^\/([^/]+\/[^/]+)\.git\/info\/refs\?service=git-receive-pack$/.exec(req.url ?? "");
    if (m && left[m[1]]) {
      auths.push(req.headers.authorization);
      const next = left[m[1]].length > 1 ? left[m[1]].shift() : left[m[1]][0];
      res.writeHead(next ?? 500, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    auths,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Marks an env var to drop from the child (JEST_WORKER_ID, to prove the seam is inert). */
const UNSET = "\u0000unset";

const probes = (f: Fake): string[] => f.seen.filter((u) => u.includes("git-receive-pack"));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Run the compiled main.js; resolves on exit, or kills it once `until` matches stdout. */
function boot(
  f: Fake,
  over: Record<string, string> = {},
  until?: RegExp,
  ms = 30_000,
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      JEST_WORKER_ID: "1",
      CONTROL_TEST_GITHUB_BASE: f.base,
      CONTROL_TEST_PROBE_BACKOFF_MS: "5",
      GIT_ALLOW_PROTOCOL: "file", // no git child may speak http, even to the fake
      CONTROL_PASSWORD: "a-long-enough-password",
      CONTROL_SESSION_SECRET: "s".repeat(40),
      CONTROL_GITHUB_TOKEN: TOKEN,
      CONTROL_REPO: PRODUCT,
      CONTROL_STATE_REPO: STATE,
      CONTROL_PUBLIC_URL: "https://control.example.test",
      CONTROL_PORT: "0",
      ...over,
    };
    for (const k of Object.keys(env)) if (env[k] === UNSET) delete env[k];
    const child = spawn("node", [dist.main], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`boot timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, ms);
    child.stdout.on("data", (c: Buffer) => {
      stdout += String(c);
      if (until?.test(stdout)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const noSecrets = (r: Run): void => {
  const all = r.stdout + r.stderr;
  expect(all).not.toContain(TOKEN);
  expect(all).not.toContain(B64);
};

let f: Fake | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("the process refuses a token that can write, or one it cannot verify", () => {
  it("product repo answers 200: exit 1, the write-access message, never listens", async () => {
    f = await fake({ [PRODUCT]: [200], [STATE]: [403] });
    const r = await boot(f);
    expectRefusedExit(r.code);
    expect(r.stderr).toMatch(/the token has write access to acme\/acme; refusing to start/);
    expect(r.stdout).not.toMatch(/listening on/);
    expect(probes(f)).toEqual([`/${PRODUCT}.git/info/refs?service=git-receive-pack`]);
    noSecrets(r);
  });

  it("state repo answers 200 (product 403): exit 1 naming the state repo, never listens", async () => {
    f = await fake({ [PRODUCT]: [403], [STATE]: [200] });
    const r = await boot(f);
    expectRefusedExit(r.code);
    expect(r.stderr).toMatch(/the token has write access to acme\/acme-control-state/);
    expect(r.stdout).not.toMatch(/listening on/);
    expect(probes(f)).toHaveLength(2);
    noSecrets(r);
  });

  it("500 on every try (3 tries): exit 1 'could not verify', never listens", async () => {
    f = await fake({ [PRODUCT]: [500], [STATE]: [403] });
    const r = await boot(f);
    expectRefusedExit(r.code);
    expect(r.stderr).toMatch(/could not verify the token is read-only on acme\/acme \(500\)/);
    expect(r.stdout).not.toMatch(/listening on/);
    expect(probes(f)).toHaveLength(3);
    noSecrets(r);
  });

  it("a 500 then a 403 is retried and the boot goes on", async () => {
    f = await fake({ [PRODUCT]: [500, 403], [STATE]: [403] });
    const r = await boot(f, {}, /listening on/);
    expect(r.stdout).toMatch(/control: probe acme\/acme -> read-only \(403\)/);
    expect(r.stdout).toMatch(/listening on/);
  });
});

describe("403 on both repos boots, and says what it saw", () => {
  it("logs one 'control: probe <repo> -> read-only (403)' line per repo, then listens", async () => {
    f = await fake({ [PRODUCT]: [403], [STATE]: [403] });
    const r = await boot(f, {}, /listening on/);
    expect(r.stdout).toContain(`control: probe ${PRODUCT} -> read-only (403)`);
    expect(r.stdout).toContain(`control: probe ${STATE} -> read-only (403)`);
    expect(r.stdout.match(/control: probe .* -> read-only \(403\)/g)).toHaveLength(2);
    expect(r.stdout).toMatch(/\[control\] listening on 0\.0\.0\.0:\d+/);
    // the product repo is probed first, and each probe carried the Basic credential
    expect(probes(f)).toEqual([
      `/${PRODUCT}.git/info/refs?service=git-receive-pack`,
      `/${STATE}.git/info/refs?service=git-receive-pack`,
    ]);
    expect(f.auths).toEqual([`Basic ${B64}`, `Basic ${B64}`]);
    noSecrets(r);
  });
});

describe("a rejected boot step leaves no half-booted process", () => {
  it("the port is already taken: the process exits 1 instead of lingering", async () => {
    f = await fake({ [PRODUCT]: [403], [STATE]: [403] });
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "0.0.0.0", r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const r = await boot(f, { CONTROL_PORT: String(port) }, undefined, 15_000);
      expectRefusedExit(r.code);
      expect(r.stderr).toMatch(/EADDRINUSE|address already in use/);
      expect(r.stdout).not.toMatch(/listening on/);
      noSecrets(r);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe("the test seam is inert outside a Jest worker", () => {
  it("without JEST_WORKER_ID the override is ignored with a warning, and no seam banner shows", async () => {
    f = await fake({ [PRODUCT]: [200], [STATE]: [200] });
    // fixture mode keeps the process off the network while still running the seam code
    const r = await boot(
      f,
      {
        JEST_WORKER_ID: UNSET,
        CONTROL_LOCAL: "1",
        CONTROL_FIXTURE: path.join(__dirname, "fixtures", "acme"),
      },
      /listening on/,
    );
    expect(r.stderr).toMatch(/CONTROL_TEST_\* variables are ignored outside a Jest worker/);
    expect(r.stderr).not.toMatch(/test seam active/);
    expect(f.seen).toEqual([]);
  });
  it("inside a Jest worker the redirect is announced", async () => {
    f = await fake({ [PRODUCT]: [403], [STATE]: [403] });
    const r = await boot(f, {}, /listening on/);
    expect(r.stderr).toContain(`WARNING test seam active: GitHub base is ${f.base}`);
  });
});
