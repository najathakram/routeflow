import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// SA-1248: the local mail TLS pair is generated per machine, never tracked.
// Drives scripts/lib/mailpit-tls.mjs through a tiny ESM driver (the helper is .mjs).

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const HELPER = path.join(REPO_ROOT, "scripts", "lib", "mailpit-tls.mjs");

let work: string;
let driver: string;

function ensure(root: string, mode: "real" | "none" | "future") {
  const r = spawnSync(process.execPath, [driver, root, mode], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const paths = (root: string) => [
  path.join(root, "docker", "mailpit-tls", "cert.pem"),
  path.join(root, "docker", "mailpit-tls", "key.pem"),
];
const mtimes = (root: string) => paths(root).map((p) => fs.statSync(p).mtimeMs);

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mailpit-tls-"));
  driver = path.join(work, "driver.mjs");
  fs.writeFileSync(
    driver,
    `import { ensureMailpitTls } from ${JSON.stringify(pathToFileURL(HELPER).href)};
const [, , root, mode] = process.argv;
const opts = { repoRoot: root };
if (mode === "none") opts.run = () => ({ status: null });
if (mode === "future") opts.now = Date.now() + 11 * 365 * 24 * 3600 * 1000;
try { console.log(JSON.stringify(ensureMailpitTls(opts))); } catch (e) { console.error(e.message); process.exit(1); }
`,
  );
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe("ensureMailpitTls", () => {
  it("T1/T2/T6: generates a missing pair, then keeps it, never printing a key", () => {
    const root = fs.mkdtempSync(path.join(work, "r1-"));
    const first = ensure(root, "real");
    expect(first.out).toContain('"generated":true');
    expect(first.out).not.toContain("PRIVATE KEY");
    expect(fs.readFileSync(paths(root)[1], "utf8")).toContain("PRIVATE KEY");
    const before = mtimes(root);
    const second = ensure(root, "real");
    expect(second.out).toContain('"generated":false');
    expect(mtimes(root)).toEqual(before);
  }, 60_000);

  it("T3: regenerates over a garbage cert and over an expired one", () => {
    const root = fs.mkdtempSync(path.join(work, "r3-"));
    ensure(root, "real");
    fs.writeFileSync(paths(root)[0], "garbage");
    expect(ensure(root, "real").out).toContain('"generated":true');
    // validTo is mocked through `now`, no real clock wait: 11 years on, the 10-year pair is expired.
    expect(ensure(root, "future").out).toContain("cannot generate");
  }, 60_000);

  it("T4: with neither tool it fails with one plain line and writes no pair", () => {
    const root = fs.mkdtempSync(path.join(work, "r4-"));
    const res = ensure(root, "none");
    expect(res.status).toBe(1);
    expect(res.out).toMatch(/openssl or start Docker/);
    expect(fs.existsSync(paths(root)[0])).toBe(false);
  }, 30_000);
});

describe("repo truth", () => {
  it("T5: only README.md is tracked under docker/mailpit-tls", () => {
    const r = spawnSync("git", ["ls-files", "docker/mailpit-tls"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.stdout.trim().split("\n")).toEqual(["docker/mailpit-tls/README.md"]);
  });
});
