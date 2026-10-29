#!/usr/bin/env node
/**
 * Self-test for the register's one write transaction (B1-b1, SPEC v3.2 "Ruling v3" / G5).
 *
 * Runs against a local bare repo (the "remote") plus clones, never the real remote or tree:
 *   - withRegistryWrite: clean push, dirty guard, foreign origin, two writers, 5 rejected pushes then
 *     success, give-up, and the lock-wait >= worst-case pin (derived from the same constants);
 *   - the review musts: a hand edit made during the push window survives (retry and give-up), the
 *     lock is scripts/lib/mkdir-lock.mjs, a lock timeout names the lock to remove.
 * The clone, the origin check and RF_REGISTRY_MODE_TEST are pinned in registry-clone.self-test.mjs.
 *
 * Run directly: `node scripts/registry-write.self-test.mjs` (wired into `npm run verify`).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootStamp } from "./lib/mkdir-lock.mjs";
import { PFX, append, fixture, git, rowsOf, spawned } from "./lib/registry-fixture.mjs";
import * as rr from "./lib/registry-root.mjs";
import * as rw from "./lib/registry-write.mjs";

const ME = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(ME), "..");
// ── worker mode: one writer process on a shared clone (two of them race for the lock) ──
if (process.argv[2] === "--worker") {
  const [, , , cloneDir, line, mode] = process.argv;
  try {
    rw.withRegistryWrite(
      ({ root }) => {
        // "usurp": another process takes the lock over while this one is inside its section.
        if (mode === "usurp")
          writeFileSync(
            join(cloneDir, ".registry-write.lock", "owner.json"),
            JSON.stringify({ pid: process.pid, token: "usurper", at: Date.now() }),
          );
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        appendFileSync(join(root, "rows.txt"), `${line}\n`);
        return { paths: [`${PFX}/rows.txt`], result: line };
      },
      { cloneDir, lockWaitMs: 60000 },
    );
    process.exit(process.exitCode || 0);
  } catch (e) {
    console.error(e.message);
    process.exit(e.exitCode ?? 1);
  }
}

const fx = fixture("rf-regwrite-");
const { tmp, bare, check, section, env, showOrigin, clean, other } = fx;

async function main() {
  fx.world();
  const A = fx.clone("a");
  const B = fx.clone("b");
  const base = { cloneDir: A, lockWaitMs: 30000 };
  const addRow =
    (calls) =>
    ({ root }) => {
      calls.n++;
      appendFileSync(join(root, "rows.txt"), "mine\n");
      return { paths: [`${PFX}/rows.txt`], result: "id-1" };
    };

  let k = 0;
  await section("lock wait", async () => {
    // Every capped git call of every attempt, plus the fixed calls (origin check, give-up reset).
    const calls = (rr.REGISTRY_PUSH_RETRIES + 1) * rr.REGISTRY_GIT_CALLS_PER_ATTEMPT;
    const worst = (calls + rr.REGISTRY_GIT_CALLS_FIXED) * rr.REGISTRY_GIT_TIMEOUT_MS;
    check("the slack is positive", rr.REGISTRY_LOCK_SLACK_MS > 0);
    check(
      "lock wait >= every capped git call per attempt + the give-up calls + slack",
      rr.REGISTRY_LOCK_WAIT_MS >= worst + rr.REGISTRY_LOCK_SLACK_MS,
    );
    check("default wait is that constant", rw.WRITE_DEFAULTS?.lockWaitMs, rr.REGISTRY_LOCK_WAIT_MS);
  });
  await section("withRegistryWrite", async () => {
    const c1 = { n: 0 };
    const r1 = rw.withRegistryWrite(addRow(c1), base);
    check(
      "clean write pushes, id after the push",
      [r1.result, r1.attempts, r1.pushed, showOrigin("rows.txt")],
      ["id-1", 1, true, "base\nmine"],
    );

    appendFileSync(join(A, PFX, "rows.txt"), "hand edit\n");
    const c2 = { n: 0 };
    let err;
    try {
      rw.withRegistryWrite(addRow(c2), base);
    } catch (e) {
      err = e;
    }
    const kept = readFileSync(join(A, PFX, "rows.txt"), "utf8").endsWith("hand edit\n");
    check(
      "dirty clone: exit 2 names commit-record, fn not run, edit kept",
      [err?.exitCode, /commit-record/.test(err?.message), c2.n, kept],
      [2, true, 0, true],
    );
    git(A, "checkout", "--", PFX);

    const w = (line) => spawned([ME, "--worker", A, line], env());
    const two = await Promise.all([w("w1"), w("w2")]);
    const landed = rowsOf(showOrigin("rows.txt")).filter((l) => /^w[12]$/.test(l));
    check(
      "two writers, one clone: both land",
      [two.map((x) => x.code), landed.sort()],
      [
        [0, 0],
        ["w1", "w2"],
      ],
    );

    const c3 = { n: 0 };
    const r3 = rw.withRegistryWrite(addRow(c3), {
      ...base,
      hooks: { beforePush: (i) => i < 5 && other(B, append("rows.txt", `c${k++}\n`)) },
    });
    check("5 rejected pushes then success on the 6th attempt", [r3.attempts, c3.n], [6, 6]);
    const rows = rowsOf(showOrigin("rows.txt"));
    check(
      "every rival row and mine landed",
      [rows.filter((l) => /^c\d$/.test(l)).length, rows.filter((l) => l === "mine").length],
      [5, 2],
    );

    const c4 = { n: 0 };
    const calls = [];
    err = undefined;
    try {
      rw.withRegistryWrite(addRow(c4), {
        ...base,
        hooks: {
          beforePush: () => other(B, append("rows.txt", `d${k++}\n`)),
          onGit: (args) => calls.push(args[0]),
        },
      });
    } catch (e) {
      err = e;
    }
    check(
      "gives up after REGISTRY_PUSH_RETRIES: exit 1, not recorded",
      [err?.exitCode, /not recorded/.test(err?.message), c4.n],
      [1, true, 6],
    );
    check(
      "a full give-up makes no more capped git calls than the lock-wait budget counts",
      [
        calls.length > 0,
        calls.length <=
          (rr.REGISTRY_PUSH_RETRIES + 1) * rr.REGISTRY_GIT_CALLS_PER_ATTEMPT +
            rr.REGISTRY_GIT_CALLS_FIXED,
      ],
      [true, true],
    );
    check(
      "give-up leaves the clone clean at origin",
      [clean(A), git(A, "rev-parse", "HEAD") === git(bare, "rev-parse", "main")],
      [true, true],
    );
    git(tmp, "init", "--bare", "--initial-branch=main", join(tmp, "elsewhere.git"));
    const A3 = fx.clone("a3");
    git(A3, "remote", "set-url", "origin", join(tmp, "elsewhere.git"));
    const head = git(A3, "rev-parse", "HEAD");
    const c5 = { n: 0 };
    err = undefined;
    try {
      rw.withRegistryWrite(addRow(c5), { ...base, cloneDir: A3 });
    } catch (e) {
      err = e;
    }
    check(
      "a foreign origin: exit 2, fn not run, the clone untouched",
      [err?.exitCode, c5.n, git(A3, "rev-parse", "HEAD") === head],
      [2, 0, true],
    );
  });
  await section("a hand edit made in the push window (MUST 1)", async () => {
    const hand = join(A, PFX, "bugs", "B12.md");
    const hand2 = join(A, PFX, "hand-untracked.txt");
    const mark = "\nhand edit in the push window\n";
    const mines = () => rowsOf(showOrigin("rows.txt")).filter((l) => l === "mine").length;
    const before = mines();
    const run = (retries, edit, c = { n: 0 }) => {
      try {
        rw.withRegistryWrite(addRow(c), {
          ...base,
          retries,
          hooks: {
            beforePush: (i) => {
              other(B, append("rows.txt", `r${k++}\n`));
              edit(i);
            },
          },
        });
      } catch (e) {
        return e;
      }
    };
    const c = { n: 0 };
    let err = run(5, (i) => i === 0 && appendFileSync(hand, mark), c);
    check(
      "retry: exit 2, the edit is still in the clone, fn ran once, nothing of it pushed",
      [err?.exitCode, readFileSync(hand, "utf8").endsWith(mark), c.n, mines()],
      [2, true, 1, before],
    );
    git(A, "checkout", "--", PFX);
    err = run(1, (i) => {
      if (i === 1) (appendFileSync(hand, mark), writeFileSync(hand2, "keep me\n"));
    });
    check(
      "give-up: exit 2, a tracked and an untracked hand edit are neither reset nor cleaned",
      [err?.exitCode, readFileSync(hand, "utf8").endsWith(mark), existsSync(hand2)],
      [2, true, true],
    );
    git(A, "checkout", "--", PFX);
    rmSync(hand2, { force: true });
    // fn throws while a hand edit lands mid-write: the clone is left as is, never reset or cleaned
    try {
      rw.withRegistryWrite(
        (ctx) => {
          appendFileSync(join(ctx.root, "rows.txt"), "half\n");
          appendFileSync(hand, mark);
          writeFileSync(hand2, "keep me\n");
          throw new Error("fn broke");
        },
        { ...base },
      );
    } catch (e) {
      err = e;
    }
    check(
      "fn throws: exit 2, says the clone was left as is, both hand edits kept",
      [err?.exitCode, /left as is/.test(err?.message), readFileSync(hand, "utf8").endsWith(mark)],
      [2, true, true],
    );
    check("fn throws: the untracked hand file survives", existsSync(hand2), true);
    git(A, "checkout", "--", PFX);
    rmSync(hand2, { force: true });
  });
  await section("the lock is scripts/lib/mkdir-lock.mjs (MUST 3)", async () => {
    const lib = (n) => readFileSync(join(ROOT, "scripts", "lib", n), "utf8");
    const [clone, write] = [lib("registry-clone.mjs"), lib("registry-write.mjs")];
    check(
      "takes the shared lock, hand-rolls none, and the clone URL follows --",
      [
        /from "\.\/mkdir-lock\.mjs"/.test(clone),
        /mkdirSync\((?!dirname\()|\brmSync\(/.test(clone + write),
        /"--",\s*remoteUrl\(\)/.test(clone),
      ],
      [true, false, true],
    );
    const lockDir = join(A, ".registry-write.lock");
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const plant = (pid = deadPid, token = "t-dead") => {
      mkdirSync(lockDir);
      const owner = { pid, token, at: Date.now(), bootAt: bootStamp() };
      writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner));
    };
    const worker = (extra = {}, mode = "") => spawned([ME, "--worker", A, "w", mode], env(extra));
    const gone = { BUGS_SELF_TEST: "1", BUGS_TEST_RELEASE_AFTER_OWNER_READ: "1" };

    plant();
    let r = await worker();
    check(
      "a dead owner's lock is broken and reported, never silently",
      [
        r.code,
        /breaking the lock on .*owner \(pid \d+\) is gone/s.test(r.out),
        existsSync(lockDir),
      ],
      [0, true, false],
    );
    plant();
    r = await worker(gone);
    check(
      "B598 through the transaction: a lock released under the waiter is not reported broken",
      [r.code, /breaking the lock/.test(r.out), existsSync(lockDir)],
      [0, false, false],
    );
    r = await worker({}, "usurp");
    check(
      "release is token-checked: a lock taken over mid-section is left alone, exit 1",
      [r.code, /was broken by another process/.test(r.out), existsSync(lockDir)],
      [1, true, true],
    );
    rmSync(lockDir, { recursive: true, force: true });

    const sleeper = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    plant(sleeper.pid, "t-live");
    const t0 = Date.now();
    let err;
    try {
      rw.withRegistryWrite(addRow({ n: 0 }), { ...base, lockWaitMs: 1500 });
    } catch (e) {
      err = e;
    }
    const took = Date.now() - t0;
    sleeper.kill();
    rmSync(lockDir, { recursive: true, force: true });
    check(
      "lock timeout: exit 1, names the lock to remove, honours lockWaitMs (not the helper's 10s)",
      [err?.exitCode, String(err?.message).includes(lockDir), took < 8000],
      [1, true, true],
    );
  });
}

await main();
fx.finish("registry-write");
