import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "rf.mjs");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let tmp;
let env;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rfops-cli-"));
  const remote = join(tmp, "remote.git");
  git(tmp, "init", "--bare", "--quiet", "--initial-branch=main", remote);
  const specs = join(tmp, "specs");
  git(tmp, "clone", "--quiet", remote, specs);
  git(specs, "config", "user.name", "CLI Test");
  git(specs, "config", "user.email", "cli@example.com");
  writeFileSync(join(specs, "README.md"), "specs\n");
  git(specs, "add", "README.md");
  git(specs, "commit", "--quiet", "-m", "init");
  git(specs, "push", "--quiet", "-u", "origin", "main");
  env = {
    ...process.env,
    RF_OPS_HOME: join(tmp, "home"),
    RF_SPECS_DIR: specs,
    RF_SPECS_REMOTE: remote,
    RF_MACHINE: "testbox",
    RF_REPO_ROOT: join(tmp, "no-such-repo"),
    RF_NO_SYNC: "1",
    RF_ACTOR: "cli-test",
  };
  delete env.RF_LANE;
});

after(() => rmSync(tmp, { recursive: true, force: true }));

function rf(...args) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [RF, ...args],
      { env, encoding: "utf8", timeout: 200000 },
      (err, stdout, stderr) => {
        res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
      },
    );
  });
}
const T = { timeout: 600000 };

test("usage errors exit 2 without touching git", T, async () => {
  assert.equal((await rf()).code, 2);
  assert.equal((await rf("bogus")).code, 2);
  const noId = await rf("claim");
  assert.equal(noId.code, 2);
  assert.match(noId.stderr, /item id/);
  assert.equal((await rf("item", "new", "--title", "x")).code, 2); // no --type
  assert.equal((await rf("item")).code, 2);
  assert.equal((await rf("claim", "5", "--lane", "no-such-lane-xyz")).code, 2);
  assert.equal((await rf("event", "nope", "5")).code, 2);
});

test("item new -> claim -> next -> status -> ls --json, with refusals (exit 1)", T, async () => {
  let r = await rf(
    "item",
    "new",
    "--title",
    "Acme order screen",
    "--type",
    "feature",
    "--priority",
    "P1",
    "--lane",
    "pc-lane",
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /created item 1\b/);
  r = await rf(
    "item",
    "new",
    "--title",
    "Acme invoice total",
    "--type",
    "bug",
    "--priority",
    "P2",
    "--lane",
    "pc-lane",
    "--json",
  );
  assert.equal(r.code, 0, r.stderr);
  const created = JSON.parse(r.stdout);
  assert.equal(created.ok, true);
  assert.equal(created.pushed, true);
  assert.equal(created.events[0].item, "2");
  assert.equal(created.events[0].machine, "testbox");

  r = await rf("next", "--lane", "pc-lane", "--json");
  assert.equal(r.code, 0, r.stderr);
  let nx = JSON.parse(r.stdout);
  assert.equal(nx.item.id, "1");
  assert.equal(nx.runnersUp[0].id, "2");
  assert.match(nx.item.reason, /^P1 · assigned to pc-lane/);

  r = await rf("claim", "1", "--lane", "pc-lane", "--branch", "feat/1-acme");
  assert.equal(r.code, 0, r.stderr);

  // Held by pc-lane: another lane is refused (exit 1) unless --steal.
  r = await rf("claim", "1", "--lane", "macmini");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /held by pc-lane since .*--steal/);

  // Unknown item is refused (exit 1).
  r = await rf("status", "999", "live");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown item 999/);

  // Claimed items drop out of next; --claim takes the top pick.
  r = await rf("next", "--lane", "pc-lane", "--claim", "--json");
  assert.equal(r.code, 0, r.stderr);
  nx = JSON.parse(r.stdout);
  assert.equal(nx.item.id, "2");
  assert.equal(nx.claimed, true);

  r = await rf("status", "1", "building", "--note", "go");
  assert.equal(r.code, 0, r.stderr);

  r = await rf("ls", "--json", "--open");
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(
    rows.map((i) => i.id),
    ["1", "2"],
  );
  const one = rows.find((i) => i.id === "1");
  assert.equal(one.status, "building");
  assert.equal(one.claimedBy, "pc-lane");
  assert.deepEqual(one.links.branches, ["feat/1-acme"]);

  r = await rf("ls", "--status", "building");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Acme order screen/);
  assert.doesNotMatch(r.stdout, /invoice total/);

  r = await rf("next", "--lane", "pc-lane");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to pick/);

  r = await rf("item", "show", "1", "--json");
  assert.equal(JSON.parse(r.stdout).title, "Acme order screen");
  r = await rf("item", "show", "404");
  assert.equal(r.code, 1);
});

test("whoami and doctor do not fail hard", T, async () => {
  let r = await rf("whoami", "--json");
  assert.equal(r.code, 0, r.stderr);
  const w = JSON.parse(r.stdout);
  assert.equal(w.machine, "testbox");
  assert.equal(w.clone, "present");
  r = await rf("doctor");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /git/);
  assert.match(r.stdout, /gh/);
});

test("--quiet prints nothing on success", { timeout: 600000 }, async () => {
  const r = await rf("event", "note", "--text", "quiet note", "--quiet");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
});
