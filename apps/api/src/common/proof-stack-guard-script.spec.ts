import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #2491 (SA-473 (d)) — the proof-stack guard: scripts/lib/proof-stack.mjs and the
 * `--build-sha` / `--proof-stack` flags of scripts/local-env.mjs.
 *
 * The library is ESM and this suite runs under ts-jest's CommonJS transform, so its cases run in
 * ONE `node --input-type=module` child with injected fakes. The script cases drive the REAL
 * local-env.mjs with fake `docker` and `git` executables first on PATH, so no container runtime is
 * needed and the verdicts never depend on this clone's history depth (CI checks out shallow).
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LOCAL_ENV = path.join(REPO_ROOT, "scripts", "local-env.mjs");
const LIB_HREF = pathToFileURL(path.join(REPO_ROOT, "scripts", "lib", "proof-stack.mjs")).href;

const A = "a".repeat(40); // the commit under proof
const B = "b".repeat(40); // a descendant of A
const C = "c".repeat(40); // unrelated to A

const LIB_CASES = `
import * as p from "${LIB_HREF}";
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (status = 1) => ({ status, stdout: "", stderr: "" });
// ancestry among the fake commits: A is an ancestor of A and B, never of C
const anc = (a, b) => (a === "${A}" ? b === "${A}" || b === "${B}" : a === b);
const img = (sha, dirty = "false") => (cmd, args) =>
  cmd === "docker" ? ok(JSON.stringify({ "org.routeflow.sha": sha, "org.routeflow.dirty": dirty })) : fail();
const required = { sha: "${A}", from: "HEAD" };
const check = (images) => p.checkProofStack({ required, images, ancestor: anc });
const out = {
  stampClean: p.buildStamp((c, a) => (a[0] === "rev-parse" ? ok("${A}\\n") : ok(""))),
  stampDirty: p.buildStamp((c, a) => (a[0] === "rev-parse" ? ok("${A}\\n") : ok(" M x.ts\\n"))),
  stampNoGit: p.buildStamp(() => fail(128)),
  readOk: p.readImage("routeflow-api:local", img("${B}")),
  readMissing: p.readImage("routeflow-api:local", () => fail(1)),
  readNoLabels: p.readImage("routeflow-api:local", () => ok("null")),
  reqHead: p.requiredCommit({}, (c, a) => (a[3] === "HEAD^{commit}" ? ok("${A}\\n") : fail())),
  reqEnv: p.requiredCommit({ PROOF_STACK_REQUIRE: "abc123" }, (c, a) =>
    a[3] === "abc123^{commit}" ? ok("${B}\\n") : fail()),
  reqUnknown: p.requiredCommit({ PROOF_STACK_REQUIRE: "nope" }, () => fail(1)),
  isAnc: [p.isAncestor("x", "y", () => ok()), p.isAncestor("x", "y", () => fail(1)), p.isAncestor("x", "y", () => fail(128))],
  fresh: check([{ image: "api", sha: "${A}", dirty: "false" }, { image: "web", sha: "${B}", dirty: "false" }]),
  stale: check([{ image: "api", sha: "${B}", dirty: "false" }, { image: "web", sha: "${C}", dirty: "false" }]),
  unlabelled: check([{ image: "api", sha: null, dirty: null }, { image: "web", sha: "unknown", dirty: "unknown" }]),
  unreadable: check([{ image: "api", error: "cannot inspect api" }]),
  dirty: check([{ image: "api", sha: "${B}", dirty: "true" }]),
  dirtyPr: p.checkProofStack({ required: { sha: "${A}", from: "PROOF_STACK_REQUIRE" },
    images: [{ image: "api", sha: "${B}", dirty: "true" }], ancestor: anc }),
  noRequired: p.checkProofStack({ required: { error: "required commit nope is not in this clone" },
    images: [{ image: "api", sha: "${A}", dirty: "false" }], ancestor: anc }),
  unrelatable: p.checkProofStack({ required, images: [{ image: "api", sha: "${B}", dirty: "false" }], ancestor: () => null }),
};
out.freshLine = p.stampLine(out.fresh);
out.staleLine = p.stampLine(out.stale);
console.log(JSON.stringify(out));
`;

describe("proof-stack library (#2491)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  beforeAll(() => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", LIB_CASES], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    r = JSON.parse(res.stdout.trim());
  });

  it("stamps the build with HEAD and whether the tracked tree is dirty", () => {
    expect(r.stampClean).toEqual({ sha: A, dirty: "false" });
    expect(r.stampDirty).toEqual({ sha: A, dirty: "true" });
    expect(r.stampNoGit).toEqual({ sha: "unknown", dirty: "unknown" });
  });

  it("reads an image's build labels, and reports an image it cannot inspect", () => {
    expect(r.readOk).toEqual({ image: "routeflow-api:local", sha: B, dirty: "false" });
    expect(r.readMissing.error).toMatch(/cannot inspect routeflow-api:local/);
    expect(r.readNoLabels).toEqual({ image: "routeflow-api:local", sha: null, dirty: null });
  });

  it("requires HEAD by default, PROOF_STACK_REQUIRE when set, and refuses an unknown commit", () => {
    expect(r.reqHead).toEqual({ sha: A, from: "HEAD" });
    expect(r.reqEnv).toEqual({ sha: B, from: "PROOF_STACK_REQUIRE" });
    expect(r.reqUnknown.error).toMatch(/nope is not in this clone/);
  });

  it("maps git merge-base --is-ancestor exit codes to true / false / unknown", () => {
    expect(r.isAnc).toEqual([true, false, null]);
  });

  it("passes when every image was built from the required commit or a descendant", () => {
    expect(r.fresh.ok).toBe(true);
    expect(r.fresh.failures).toEqual([]);
    expect(r.fresh.record).toMatchObject({ required: A, requiredFrom: "HEAD", ok: true });
    expect(r.fresh.record.images.map((i: { sha: string }) => i.sha)).toEqual([A, B]);
    expect(r.freshLine).toMatch(
      /^proof-stack: api aaaaaaaaaaaa · web bbbbbbbbbbbb · required aaaaaaaaaaaa \(HEAD\) · OK$/,
    );
  });

  it("fails as stale image when an image does not contain the required commit", () => {
    expect(r.stale.ok).toBe(false);
    expect(r.stale.failures).toEqual([
      expect.stringMatching(
        /^stale image: web was built from cccccccccccc, which does not contain aaaaaaaaaaaa/,
      ),
    ]);
    expect(r.staleLine).toMatch(/· STALE$/);
  });

  it("fails an unlabelled, unreadable or unrelatable image, and an unknown required commit", () => {
    expect(r.unlabelled.failures).toHaveLength(2);
    for (const f of r.unlabelled.failures)
      expect(f).toMatch(/^stale image: .* carries no org\.routeflow\.sha/);
    expect(r.unreadable.failures).toEqual(["cannot inspect api"]);
    expect(r.unrelatable.failures[0]).toMatch(/^stale image: cannot relate api/);
    expect(r.noRequired.ok).toBe(false);
    expect(r.noRequired.failures).toEqual(["required commit nope is not in this clone"]);
  });

  it("fails a dirty-tree image as stale when proving a PR (PROOF_STACK_REQUIRE)", () => {
    expect(r.dirtyPr.ok).toBe(false);
    expect(r.dirtyPr.failures).toEqual([
      expect.stringMatching(/^stale image: api was built from a dirty tree at bbbbbbbbbbbb/),
    ]);
  });

  it("warns (without failing) on a dirty-tree image in the HEAD dev loop", () => {
    expect(r.dirty.ok).toBe(true);
    expect(r.dirty.warnings[0]).toMatch(/DIRTY tree at bbbbbbbbbbbb/);
  });
});

const describeFakes = process.platform === "win32" ? describe.skip : describe;

describeFakes("local-env.mjs --proof-stack / --build-sha (#2491), fake docker and git", () => {
  let dir: string;
  let marker: string;
  let log: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-stack-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // docker: prints the labels FAKE_IMAGE_SHA / FAKE_IMAGE_DIRTY describe ("none" = no labels).
    fs.writeFileSync(
      path.join(bin, "docker"),
      [
        "#!/usr/bin/env node",
        "const sha = process.env.FAKE_IMAGE_SHA;",
        "if (sha === 'absent') process.exit(1);",
        "if (sha === 'none') { console.log('null'); process.exit(0); }",
        "console.log(JSON.stringify({ 'org.routeflow.sha': sha, 'org.routeflow.dirty': process.env.FAKE_IMAGE_DIRTY || 'false' }));",
      ].join("\n"),
      { mode: 0o755 },
    );
    // git: HEAD is FAKE_HEAD; A is an ancestor of A and B only; a dirty tree when FAKE_DIRTY=1.
    fs.writeFileSync(
      path.join(bin, "git"),
      [
        "#!/usr/bin/env node",
        "const [cmd, ...a] = process.argv.slice(2);",
        `const A = '${A}', B = '${B}';`,
        "if (cmd === 'rev-parse') {",
        "  const want = a[a.length - 1].replace('^{commit}', '');",
        "  const sha = want === 'HEAD' ? process.env.FAKE_HEAD : /^[0-9a-f]{40}$/.test(want) ? want : '';",
        "  if (!sha) process.exit(1);",
        "  console.log(sha); process.exit(0);",
        "}",
        "if (cmd === 'status') { if (process.env.FAKE_DIRTY === '1') console.log(' M x.ts'); process.exit(0); }",
        "if (cmd === 'merge-base') {",
        "  const [, x, y] = a;",
        "  process.exit(x === y || (x === A && y === B) ? 0 : 1);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      { mode: 0o755 },
    );
    marker = path.join(dir, "ran");
    log = path.join(dir, "proof-stack.jsonl");
    fs.writeFileSync(
      path.join(dir, "child.js"),
      [
        "const fs = require('fs');",
        `fs.writeFileSync(${JSON.stringify(marker)}, [process.env.ROUTEFLOW_BUILD_SHA, process.env.ROUTEFLOW_BUILD_DIRTY].join('|'));`,
      ].join("\n"),
    );
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => fs.rmSync(marker, { force: true }));

  function run(flags: string[], env: Record<string, string>) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.PROOF_STACK_REQUIRE;
    delete childEnv.RF_HEAVY_SLOT_TOKEN;
    // --build-sha takes the heavy slot (#3376): a private slot dir, so a verify holding the machine's
    // slot (often the one running this spec) never blocks the child into the spawn timeout.
    Object.assign(childEnv, env, {
      PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
      PROOF_STACK_LOG: log,
      RF_HEAVY_SLOT_DIR: path.join(dir, "heavy-slot"),
    });
    const child = `"${process.execPath}" "${path.join(dir, "child.js")}"`;
    const res = spawnSync(process.execPath, [LOCAL_ENV, ...flags, "--", child], {
      encoding: "utf8",
      env: childEnv,
      timeout: 60_000,
    });
    return {
      status: res.status,
      out: `${res.stdout}${res.stderr}`,
      ran: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
    };
  }

  it("runs the lane and records the stamp when both images contain HEAD", () => {
    const r = run(["--proof-stack"], { FAKE_HEAD: A, FAKE_IMAGE_SHA: B });
    expect(r.status).toBe(0);
    expect(r.ran).not.toBeNull();
    expect(r.out).toMatch(
      /proof-stack: routeflow-api:local bbbbbbbbbbbb · routeflow-web:local bbbbbbbbbbbb · required aaaaaaaaaaaa \(HEAD\) · OK/,
    );
    const last = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop() as string);
    expect(last).toMatchObject({ required: A, ok: true });
    expect(last.images.map((i: { sha: string }) => i.sha)).toEqual([B, B]);
  });

  it("refuses a stale image: exit 1 and the lane never runs", () => {
    const r = run(["--proof-stack"], { FAKE_HEAD: B, FAKE_IMAGE_SHA: A });
    expect(r.status).toBe(1);
    expect(r.ran).toBeNull();
    expect(r.out).toMatch(
      /stale image: routeflow-api:local was built from aaaaaaaaaaaa, which does not contain bbbbbbbbbbbb \(HEAD\)/,
    );
    expect(r.out).toMatch(/refusing to run the lane against a stale stack/);
  });

  it("PROOF_STACK_REQUIRE overrides HEAD (the PR's merge or head commit)", () => {
    const r = run(["--proof-stack"], { FAKE_HEAD: B, FAKE_IMAGE_SHA: B, PROOF_STACK_REQUIRE: A });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/required aaaaaaaaaaaa \(PROOF_STACK_REQUIRE\) · OK/);
  });

  it("refuses a dirty-tree image for a PR proof, but only warns in the HEAD dev loop", () => {
    const pr = run(["--proof-stack"], {
      FAKE_HEAD: B,
      FAKE_IMAGE_SHA: B,
      FAKE_IMAGE_DIRTY: "true",
      PROOF_STACK_REQUIRE: A,
    });
    expect(pr.status).toBe(1);
    expect(pr.ran).toBeNull();
    expect(pr.out).toMatch(/stale image: routeflow-api:local was built from a dirty tree/);
    const dev = run(["--proof-stack"], {
      FAKE_HEAD: B,
      FAKE_IMAGE_SHA: B,
      FAKE_IMAGE_DIRTY: "true",
    });
    expect(dev.status).toBe(0);
    expect(dev.ran).not.toBeNull();
    expect(dev.out).toMatch(/WARNING .*DIRTY tree/);
  });

  it("refuses an unlabelled image and an image that was never built", () => {
    const none = run(["--proof-stack"], { FAKE_HEAD: A, FAKE_IMAGE_SHA: "none" });
    expect(none.status).toBe(1);
    expect(none.ran).toBeNull();
    expect(none.out).toMatch(/carries no org\.routeflow\.sha build sha/);
    const absent = run(["--proof-stack"], { FAKE_HEAD: A, FAKE_IMAGE_SHA: "absent" });
    expect(absent.status).toBe(1);
    expect(absent.out).toMatch(/cannot inspect routeflow-api:local/);
  });

  it("--build-sha hands the command HEAD and the dirty flag for the compose labels", () => {
    expect(run(["--build-sha"], { FAKE_HEAD: A }).ran).toBe(`${A}|false`);
    expect(run(["--build-sha"], { FAKE_HEAD: A, FAKE_DIRTY: "1" }).ran).toBe(`${A}|true`);
  });
});

describe("the stack-backed local:* lanes carry the guard (#2491)", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts;
  it.each([
    "local:validate",
    "local:validate:features",
    "local:e2e",
    "local:e2e:all",
    "local:proof-stack",
  ])("%s runs through local-env.mjs --proof-stack", (name) =>
    expect(scripts[name]).toMatch(/^node scripts\/local-env\.mjs --proof-stack /),
  );
  it.each(["local:up", "local:build"])("%s stamps the images through --build-sha", (name) =>
    expect(scripts[name]).toMatch(/^node scripts\/local-env\.mjs --build-sha -- /),
  );
  it("docker-compose.yml labels the api and web builds with the build sha", () => {
    const compose = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toContain("org.routeflow.sha: ${ROUTEFLOW_BUILD_SHA:-unknown}");
    expect(compose).toMatch(/dockerfile: apps\/web\/Dockerfile[\s\S]*?labels: \*build-sha-labels/);
  });
});
