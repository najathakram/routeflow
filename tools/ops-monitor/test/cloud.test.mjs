import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "../lib/auth.mjs";
import {
  READ_ONLY_GIT,
  checkCloudEnv,
  cloudBoot,
  cloudSyncSpecs,
  readOnlyExec,
  redact,
  repoDirFor,
} from "../lib/cloud.mjs";

const TOKEN = "github_pat_ABCDEF0123456789_xyz";
const B64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

function recorder(table = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts, line: `${cmd} ${args.join(" ")}` });
    const hit = Object.entries(table).find(([k]) => `${cmd} ${args.join(" ")}`.includes(k));
    return hit ? hit[1](args, opts) : { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("redact strips tokens, auth headers and userinfo", () => {
  const dirty = [
    `git -c http.extraHeader=Authorization: Basic ${B64} clone`,
    `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/r.git/'`,
    `Authorization: Bearer ghp_abcdefghijklmnop`,
    `token ghs_ABCDEF123456 and github_pat_11AAA_bbb`,
    `Project-Access-Token: 1234-abcd`,
  ].join("\n");
  const clean = redact(dirty);
  assert.doesNotMatch(clean, new RegExp(B64));
  assert.doesNotMatch(clean, /ABCDEF0123456789/);
  assert.doesNotMatch(clean, /ghp_abc|ghs_ABC|github_pat_11|1234-abcd/);
  assert.match(clean, /clone/);
  assert.equal(redact(undefined), "");
  assert.equal(redact("nothing secret here"), "nothing secret here");
  assert.equal(redact(`custom ${"s3cret-value"} here`, ["s3cret-value"]), "custom [redacted] here");
});

test("repoDirFor: RF_REPO_DIR or <opsHome>/routeflow", () => {
  assert.equal(
    repoDirFor({ RF_OPS_HOME: "/tmp/ops" }).replace(/\\/g, "/").endsWith("/tmp/ops/routeflow"),
    true,
  );
  assert.equal(
    repoDirFor({ RF_OPS_HOME: "/tmp/ops", RF_REPO_DIR: "/x/y" })
      .replace(/\\/g, "/")
      .endsWith("/x/y"),
    true,
  );
});

test("checkCloudEnv: cloud refuses to start without hash or session secret", () => {
  const good = {
    OPS_PASSWORD_HASH: hashPassword("a good password"),
    OPS_SESSION_SECRET: "a".repeat(64),
  };
  assert.deepEqual(checkCloudEnv({ ...good }, { cloud: true }), { ok: true, errors: [] });
  const badHash = checkCloudEnv(
    { ...good, OPS_PASSWORD_HASH: "scrypt$AAAA$BBBB" },
    { cloud: true },
  );
  assert.ok(badHash.errors.some((e) => /well-formed/.test(e)));
  const none = checkCloudEnv({}, { cloud: true });
  assert.equal(none.ok, false);
  assert.ok(none.errors.some((e) => /OPS_PASSWORD_HASH/.test(e)));
  assert.ok(none.errors.some((e) => /OPS_SESSION_SECRET/.test(e)));
  assert.equal(checkCloudEnv({}, { cloud: false }).ok, true, "local without a hash is open");
  const short = checkCloudEnv({ ...good, OPS_SESSION_SECRET: "short" }, { cloud: true });
  assert.ok(short.errors.some((e) => /32/.test(e)));
  // local with a hash but no secret is also refused (cannot sign sessions)
  const localHalf = checkCloudEnv({ OPS_PASSWORD_HASH: good.OPS_PASSWORD_HASH }, { cloud: false });
  assert.equal(localHalf.ok, false);
  assert.ok(localHalf.errors.some((e) => /OPS_SESSION_SECRET/.test(e)));
  assert.doesNotMatch(JSON.stringify(none), /a{20}/);
});

test("cloudBoot: requires GITHUB_TOKEN", async () => {
  const { exec } = recorder();
  await assert.rejects(() => cloudBoot({ env: { RF_OPS_HOME: tmpdir() }, exec }), /GITHUB_TOKEN/);
});

test("cloudBoot: clones both repos, header only via -c and local config, no identity, no URL token", async () => {
  const home = mkdtempSync(join(tmpdir(), "rf-cloud-"));
  const { exec, calls } = recorder();
  const env = { GITHUB_TOKEN: TOKEN, RF_OPS_HOME: home };
  const r = await cloudBoot({ env, exec });
  assert.equal(r.repoDir, repoDirFor(env));
  assert.equal(r.specsDir, join(home, "routeflow-specs"));
  const clones = calls.filter((c) => c.args.includes("clone"));
  assert.equal(clones.length, 2);
  const specsClone = clones.find((c) => c.args.some((a) => /routeflow-specs/.test(a)));
  const repoClone = clones.find((c) => !c.args.some((a) => /routeflow-specs/.test(a)));
  assert.ok(repoClone.args.includes("--filter=blob:none"));
  assert.ok(repoClone.args.includes("--no-checkout"));
  assert.ok(!specsClone.args.includes("--filter=blob:none"));
  for (const c of clones) {
    assert.equal(c.args[0], "-c");
    assert.equal(c.args[1], `http.extraHeader=Authorization: Basic ${B64}`);
    assert.ok(
      c.args.some((a) => /^https:\/\/github\.com\/[^@]+\.git$/.test(a)),
      "token-free URL",
    );
  }
  const cfg = calls.filter((c) => c.args.includes("config"));
  assert.equal(cfg.length, 2, "extraheader written once per clone");
  for (const c of cfg) {
    assert.deepEqual(c.args.slice(0, 3), [
      "config",
      "--local",
      "http.https://github.com/.extraheader",
    ]);
    assert.equal(c.args[3], `Authorization: Basic ${B64}`);
  }
  assert.ok(
    !calls.some((c) => c.args.some((a) => /user\.(name|email)/.test(a))),
    "read-only: no identity",
  );
  assert.ok(!calls.some((c) => c.args.some((a) => a.includes(`x-access-token:${TOKEN}`))));
  assert.ok(!calls.some((c) => c.cmd !== "git"));
});

test("cloudBoot: skips clones whose .git exists but still refreshes the header", async () => {
  const home = mkdtempSync(join(tmpdir(), "rf-cloud-"));
  mkdirSync(join(home, "routeflow-specs", ".git"), { recursive: true });
  mkdirSync(join(home, "routeflow", ".git"), { recursive: true });
  const { exec, calls } = recorder();
  await cloudBoot({ env: { GITHUB_TOKEN: TOKEN, RF_OPS_HOME: home }, exec });
  assert.equal(calls.filter((c) => c.args.includes("clone")).length, 0);
  assert.equal(calls.filter((c) => c.args.includes("config")).length, 2);
});

test("cloudBoot: a failed clone throws a redacted error", async () => {
  const home = mkdtempSync(join(tmpdir(), "rf-cloud-"));
  const { exec } = recorder({
    clone: () => ({
      code: 128,
      stdout: "",
      stderr: `fatal: could not read https://x-access-token:${TOKEN}@github.com/acme/r.git Authorization: Basic ${B64}`,
    }),
  });
  await assert.rejects(
    () => cloudBoot({ env: { GITHUB_TOKEN: TOKEN, RF_OPS_HOME: home }, exec }),
    (err) => {
      assert.match(err.message, /clone/);
      assert.ok(!err.message.includes(TOKEN) && !err.message.includes(B64));
      return true;
    },
  );
});

test("cloudSyncSpecs: fetch + reset --hard origin/<default>, never pull/rebase/push", async () => {
  const { exec, calls } = recorder({
    "symbolic-ref": () => ({ code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" }),
  });
  const r = await cloudSyncSpecs("/specs", exec);
  assert.equal(r.ok, true);
  const lines = calls.map((c) => c.line);
  assert.ok(lines.some((l) => l.startsWith("git fetch")));
  assert.ok(lines.includes("git reset --hard --quiet origin/main"));
  assert.ok(!lines.some((l) => /\b(pull|rebase|push|commit|merge)\b/.test(l)));
  assert.ok(calls.every((c) => c.opts.cwd === "/specs"));
});

test("cloudSyncSpecs: falls back to origin/main then origin/master; failure is reported", async () => {
  const { exec, calls } = recorder({
    "symbolic-ref": () => ({ code: 1, stdout: "", stderr: "no" }),
    "rev-parse --verify --quiet origin/main": () => ({ code: 1, stdout: "", stderr: "" }),
  });
  const r = await cloudSyncSpecs("/specs", exec);
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.line === "git reset --hard --quiet origin/master"));
  const bad = recorder({
    fetch: () => ({ code: 1, stdout: "", stderr: `boom Authorization: Basic ${B64}` }),
  });
  const r2 = await cloudSyncSpecs("/specs", bad.exec);
  assert.equal(r2.ok, false);
  assert.doesNotMatch(r2.error, new RegExp(B64));
});

test("readOnlyExec: allows reads, throws on anything that writes history or pushes", async () => {
  const { exec, calls } = recorder();
  const ro = readOnlyExec(exec);
  for (const args of [
    ["fetch", "origin", "--quiet"],
    ["for-each-ref", "refs/remotes/origin"],
    ["-C", "/x", "diff", "--name-only", "a...b"],
    ["-c", "k=v", "cat-file", "--batch"],
    ["reset", "--hard", "origin/main"],
    ["ls-tree", "-r", "origin/master"],
    ["rev-parse", "origin/master"],
  ]) {
    await ro("git", args, { cwd: "/r" });
  }
  assert.equal(calls.length, 7);
  for (const bad of [
    "push",
    "commit",
    "rebase",
    "pull",
    "merge",
    "cherry-pick",
    "am",
    "tag",
    "branch",
  ]) {
    await assert.rejects(() => ro("git", [bad, "x"], {}), /read-only/, bad);
    await assert.rejects(
      () => ro("git", ["-C", "/x", "-c", "a=b", bad], {}),
      /read-only/,
      `-C ${bad}`,
    );
  }
  assert.equal(calls.length, 7, "blocked calls never reach exec");
  assert.ok(READ_ONLY_GIT.has("fetch") && !READ_ONLY_GIT.has("push"));
  await ro("gh", ["api", "graphql"], {});
});

test("config: repoDir and isCloud", async () => {
  const cfg = await import("../lib/config.mjs");
  assert.equal(cfg.repoDir({}), cfg.REPO_ROOT);
  assert.equal(cfg.repoDir({ RF_REPO_DIR: "/x/y" }).replace(/\\/g, "/").endsWith("/x/y"), true);
  assert.equal(cfg.isCloud({ RF_CLOUD: "1" }), true);
  assert.equal(cfg.isCloud({}), false);
  assert.equal(cfg.isCloud({ RF_CLOUD: "0" }), false);
});

test("deploy files: Dockerfile and railway.toml match the plan", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("..", import.meta.url);
  const read = (f) => readFileSync(new URL(f, root), "utf8");
  const docker = read("Dockerfile");
  assert.match(docker, /^FROM node:20-alpine$/m);
  assert.match(docker, /apk add --no-cache git/);
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /RF_CLOUD=1/);
  assert.match(docker, /CMD \["node", "tools\/ops-monitor\/server\.mjs", "--cloud"\]/);
  assert.doesNotMatch(docker, /COPY [^\n]*\. \./, "never copies the whole repo");
  const toml = read("railway.toml");
  assert.match(toml, /builder = "DOCKERFILE"/);
  assert.match(toml, /dockerfilePath = "tools\/ops-monitor\/Dockerfile"/);
  assert.match(toml, /watchPatterns = \["tools\/ops-monitor\/\*\*"\]/);
  assert.match(toml, /healthcheckPath = "\/api\/health"/);
  assert.match(toml, /restartPolicyType = "ON_FAILURE"/);
  assert.match(toml, /numReplicas = 1/);
  const ign = read("Dockerfile.dockerignore").split("\n");
  assert.equal(ign.includes("*"), true);
  assert.equal(ign.includes("!tools/ops-monitor"), true);
});
