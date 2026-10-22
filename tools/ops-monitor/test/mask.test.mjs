import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNameLoader, deepMasker, loadClientNames, maskDeep, maskText } from "../lib/mask.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");
const FIXTURE = join(HERE, "fixtures", "snapshot-sample.json");
const tmp = () => mkdtempSync(join(tmpdir(), "rf-mask-"));

test("maskText: whole word, case-insensitive, regex-safe, longest first", () => {
  const names = ["acme", "acme foods", "acme.co (pilot)"];
  assert.equal(
    maskText("Acme ships; ACME FOODS too", names),
    "a live business ships; a live business too",
  );
  assert.equal(maskText("acmes and macme and acme2", names), "acmes and macme and acme2");
  assert.equal(maskText("see acme.co (pilot) now", names), "see a live business now");
  assert.equal(maskText("acmeXco (pilot)", ["acme.co (pilot)"]), "acmeXco (pilot)");
  assert.equal(maskText("acme-foods: x", ["acme", "acme-foods"]), "a live business: x");
  assert.equal(maskText("plain", []), "plain");
  assert.equal(maskText("plain", ["", "  ", 5, null]), "plain");
  assert.equal(maskText(42, ["acme"]), 42, "non-strings pass through");
});

test("maskDeep: every string value masked in a deep copy; keys and the input untouched", () => {
  const input = {
    acme: "acme here",
    n: 3,
    ok: true,
    nil: null,
    list: ["acme", { deeper: ["x acme y", { t: "Acme" }] }],
  };
  const copy = JSON.stringify(input);
  const out = maskDeep(input, ["acme"]);
  assert.equal(JSON.stringify(input), copy, "input not mutated");
  assert.deepEqual(out, {
    acme: "a live business here",
    n: 3,
    ok: true,
    nil: null,
    list: ["a live business", { deeper: ["x a live business y", { t: "a live business" }] }],
  });
  assert.equal(maskDeep(input, []), input, "no names: same object, no copy cost");
});

test("every string field of the fixture snapshot is masked (items, bugs, alarms, problems, incidents, queue, trains, latent)", () => {
  const snap = JSON.parse(readFileSync(FIXTURE, "utf8"));
  snap.items[0].title = "Reprice for acme-foods";
  snap.items[0].gate = "needs Acme-Foods sign-off";
  snap.bugs[0].title = "acme-foods invoice wrong";
  snap.alarms[0].message = "acme-foods stuck";
  snap.problems = [{ id: "p1", title: "acme-foods down", detail: "ACME-FOODS" }];
  snap.incidents = [{ id: "i1", title: "acme-foods outage", status: "open" }];
  snap.ownerQueue = [{ id: "q1", title: "ask acme-foods", options: ["acme-foods yes", "no"] }];
  snap.trains = [{ id: "t1", label: "acme-foods train", items: [{ title: "acme-foods" }] }];
  snap.latentRisks = [{ id: "525", title: "acme-foods latent", evidence: "530: acme-foods $0.00" }];
  const out = maskDeep(snap, ["acme-foods"]);
  const flat = JSON.stringify(out);
  assert.doesNotMatch(flat, /acme-foods/i);
  assert.match(flat, /a live business/);
  assert.equal(out.items[0].title, "Reprice for a live business");
  assert.equal(out.latentRisks[0].evidence, "530: a live business $0.00");
  assert.equal(out.ownerQueue[0].options[0], "a live business yes");
});

test("loadClientNames: file array, {names} object, CLIENT_NAMES_JSON fallback, else no names", () => {
  const home = tmp();
  const ok = (names) => ({ names, error: null });
  try {
    assert.deepEqual(loadClientNames({ env: {}, home }), ok([]), "neither exists");
    assert.deepEqual(
      loadClientNames({ env: { CLIENT_NAMES_JSON: '["acme","beta"]' }, home }),
      ok(["acme", "beta"]),
    );
    writeFileSync(join(home, "client-names.json"), JSON.stringify(["acme-foods"]));
    assert.deepEqual(
      loadClientNames({ env: { CLIENT_NAMES_JSON: '["other"]' }, home }),
      ok(["acme-foods"]),
      "file wins",
    );
    writeFileSync(join(home, "client-names.json"), JSON.stringify({ names: ["acme-x", 7, ""] }));
    assert.deepEqual(loadClientNames({ env: {}, home }), ok(["acme-x"]));
    writeFileSync(join(home, "client-names.json"), "[]");
    assert.deepEqual(loadClientNames({ env: {}, home }), ok([]), "an empty list is not an error");
    // home defaults to RF_OPS_HOME
    writeFileSync(join(home, "client-names.json"), JSON.stringify(["acme-env"]));
    assert.deepEqual(loadClientNames({ env: { RF_OPS_HOME: home } }), ok(["acme-env"]));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClientNames: a file that exists but does not parse is an error, never an empty list, and never echoes its text", () => {
  const home = tmp();
  try {
    for (const bad of [
      '["acme-foods", oops',
      "",
      "not json acme-foods",
      '{"other": 1}',
      '"acme-foods"',
    ]) {
      writeFileSync(join(home, "client-names.json"), bad);
      const r = loadClientNames({ env: { CLIENT_NAMES_JSON: '["fallback"]' }, home });
      assert.deepEqual(r.names, [], "the broken file does not fall back to the variable");
      assert.match(r.error, /^client-names.json does not (parse|hold)/);
      assert.doesNotMatch(
        JSON.stringify(r),
        /acme|oops/,
        "the file's text never leaves the loader",
      );
    }
    const none = join(home, "none");
    const v = loadClientNames({ env: { CLIENT_NAMES_JSON: "{bad acme" }, home: none });
    assert.deepEqual(v.names, []);
    assert.match(v.error, /^CLIENT_NAMES_JSON does not parse$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createNameLoader: reloads when the file mtime changes, checks at most every 60 s", () => {
  const home = tmp();
  const file = join(home, "client-names.json");
  try {
    writeFileSync(file, JSON.stringify(["acme"]));
    let t = 1_000_000;
    const loader = createNameLoader({ env: {}, home, now: () => t });
    assert.deepEqual(loader.get(), ["acme"]);
    writeFileSync(file, JSON.stringify(["acme", "beta"]));
    utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
    t += 30_000;
    assert.deepEqual(loader.get(), ["acme"], "within 60 s: not re-checked");
    t += 31_000;
    assert.deepEqual(loader.get(), ["acme", "beta"], "after 60 s: mtime changed, reloaded");
    rmSync(file);
    t += 61_000;
    assert.deepEqual(loader.get(), [], "file removed: empty");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── spawned server: the name never leaves ───────────────────────────────────
function startServer(env) {
  return new Promise((resolve, reject) => {
    const args = [SERVER, "--port", "0", "--fixture", join(env.RF_OPS_HOME, "fx.json")];
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stderr.on("data", (c) => (out += c));
    child.stdout.on("data", (c) => {
      out += c;
      const m = /127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on("close", (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`no start: ${out}`)), 15000).unref();
  });
}
// Reads a response; for the SSE stream resolves after the first event.
const get = (port, path, stream = false) =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
        if (stream && body.includes("\n\n")) {
          req.destroy();
          resolve(body);
        }
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", (e) => (stream ? undefined : reject(e)));
  });

test("spawned server (fixture + temp home): no name in /api/snapshot or SSE", async () => {
  const home = tmp();
  try {
    const snap = JSON.parse(readFileSync(FIXTURE, "utf8"));
    snap.items[0].title = "Reprice for acme-foods";
    snap.alarms[0].message = "ACME-FOODS stuck";
    writeFileSync(join(home, "fx.json"), JSON.stringify(snap));
    writeFileSync(join(home, "client-names.json"), JSON.stringify(["acme-foods"]));
    const { child, port } = await startServer({ RF_OPS_HOME: home });
    try {
      const api = await get(port, "/api/snapshot");
      assert.doesNotMatch(api, /acme-foods/i);
      assert.match(api, /Reprice for a live business/);
      const sse = await get(port, "/sse", true);
      assert.doesNotMatch(sse, /acme-foods/i);
      assert.match(sse, /a live business/);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createNameLoader: a file that breaks after a good load keeps the last good list and reports the error", () => {
  const home = tmp();
  const file = join(home, "client-names.json");
  try {
    writeFileSync(file, JSON.stringify(["acme"]));
    let t = 1_000_000;
    const loader = createNameLoader({ env: {}, home, now: () => t });
    assert.deepEqual(loader.get(), ["acme"]);
    assert.equal(loader.error(), null);
    writeFileSync(file, "[ broken");
    utimesSync(file, new Date(2031, 0, 1), new Date(2031, 0, 1));
    t += 61_000;
    assert.deepEqual(loader.get(), ["acme"], "never silently unmasks");
    assert.match(loader.error(), /does not parse/);
    writeFileSync(file, JSON.stringify(["acme", "beta"]));
    utimesSync(file, new Date(2032, 0, 1), new Date(2032, 0, 1));
    t += 61_000;
    assert.deepEqual(loader.get(), ["acme", "beta"]);
    assert.equal(loader.error(), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deepMasker: a names list masks a name that a later cut would have split", () => {
  const mask = deepMasker(["acme-foods"]);
  const out = mask({ t: `${"x".repeat(100)} acme-foods ${"y".repeat(20)}` });
  assert.doesNotMatch(out.t.slice(0, 110), /acme/);
});

// ── spawned server: refusals and the plain-localhost warning ─────────────────
function runServerOnce(args, env, { waitMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let listening = false;
    child.stderr.on("data", (c) => (out += c));
    child.stdout.on("data", (c) => {
      out += c;
      if (/127\.0\.0\.1:\d+|0\.0\.0\.0:\d+/.test(out)) listening = true;
    });
    const done = (code) => resolve({ code, out, listening });
    child.on("close", done);
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill();
      }
    }, waitMs).unref();
  });
}

test("--views and --lan refuse to start when client-names.json is empty or does not parse; plain localhost only warns", async () => {
  const home = tmp();
  try {
    writeFileSync(join(home, "fx.json"), readFileSync(FIXTURE, "utf8"));
    const fx = ["--port", "0", "--fixture", join(home, "fx.json")];
    const env = { RF_OPS_HOME: home };
    for (const [label, content] of [
      ["empty list", "[]"],
      ["broken file", '["acme-foods", oops'],
    ]) {
      writeFileSync(join(home, "client-names.json"), content);
      for (const flag of ["--views", "--lan"]) {
        const r = await runServerOnce([...fx, flag], env);
        assert.equal(r.code, 1, `${flag} with a ${label}: ${r.out}`);
        assert.match(r.out, /client-names\.json|client names/i);
        assert.doesNotMatch(r.out, /acme-foods|oops/, "never prints the file's content");
        assert.equal(r.listening, false);
      }
    }
    // no file at all: the same refusal
    rmSync(join(home, "client-names.json"));
    for (const flag of ["--views", "--lan"]) {
      const r = await runServerOnce([...fx, flag], env);
      assert.equal(r.code, 1, `${flag} without a file: ${r.out}`);
    }
    // plain localhost: starts, warns exactly once
    writeFileSync(join(home, "client-names.json"), "[ broken");
    const plain = await runServerOnce(fx, env, { waitMs: 3000 });
    assert.equal(plain.listening, true, plain.out);
    assert.equal((plain.out.match(/warning: /g) ?? []).length, 1, plain.out);
    assert.doesNotMatch(plain.out, /acme|broken/);
    // a good list lets --views and --lan start
    writeFileSync(join(home, "client-names.json"), '["acme-foods"]');
    const lan = await runServerOnce([...fx, "--lan"], env, { waitMs: 3000 });
    assert.equal(lan.listening, true, lan.out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("non-fixture server: last-snapshot.json, /api/snapshot and SSE carry no client name (masked before and after the build)", async () => {
  const root = tmp();
  const home = join(root, "home");
  const specs = join(root, "specs");
  const repo = join(root, "repo");
  const name = "acme-foods-distribution";
  try {
    for (const d of [join(home), join(specs, "events", "testbox"), join(specs, "incidents"), repo])
      mkdirSync(d, { recursive: true });
    writeFileSync(join(home, "client-names.json"), JSON.stringify([name]));
    const evs = [
      {
        v: 1,
        id: "testbox-0001760875200000-0001",
        ts: "2026-10-19T12:00:00Z",
        machine: "testbox",
        actor: "t",
        lane: "lead",
        kind: "item.new",
        item: "960",
        data: {
          title: `${"x".repeat(60)} ${name} wants a refund`,
          type: "bug",
          priority: "P0",
          status: "building",
          lane: "lead",
        },
      },
    ];
    writeFileSync(
      join(specs, "events", "testbox", "2026-10-19.jsonl"),
      `${evs.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    writeFileSync(
      join(specs, "incidents", `2026-10-15-${name}-outage.md`),
      `# ${"t".repeat(290)} ${name} down\n\n**Status:** open\n`,
    );
    // The specs dir is a real clone (git init + a bare origin), so the collector's sync works.
    const remote = join(root, "remote.git");
    const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
    g(root, "init", "-q", "--bare", "-b", "main", remote);
    g(specs, "init", "-q", "-b", "main");
    g(specs, "config", "user.name", "T");
    g(specs, "config", "user.email", "t@example.com");
    g(specs, "add", "-A");
    g(specs, "commit", "-q", "-m", "seed");
    g(specs, "remote", "add", "origin", remote);
    g(specs, "push", "-q", "-u", "origin", "main");
    const child = spawn(process.execPath, [SERVER, "--port", "0"], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        RF_OPS_HOME: home,
        RF_SPECS_DIR: specs,
        RF_REPO_DIR: repo,
        RF_PERSIST_MS: "300",
        RF_MACHINE: "testbox",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stderr.on("data", (c) => (out += c));
    let port = 0;
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (c) => {
        out += c;
        const m = /127\.0\.0\.1:(\d+)/.exec(out);
        if (m && !port) {
          port = Number(m[1]);
          resolve();
        }
      });
      child.on("close", (code) => reject(new Error(`server exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`no start: ${out}`)), 20000).unref();
    });
    try {
      const file = join(home, "last-snapshot.json");
      let written = null;
      for (let i = 0; i < 120 && !/a live business/.test(written ?? ""); i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          written = readFileSync(file, "utf8");
        } catch {
          written = null;
        }
      }
      assert.ok(written, `last-snapshot.json was written: ${out}`);
      assert.match(written, /a live business/, `the events reached the persisted snapshot: ${out}`);
      assert.doesNotMatch(written, /acme/i, "last-snapshot.json is masked");
      assert.match(written, /a live business/);
      const api = await get(port, "/api/snapshot");
      assert.doesNotMatch(api, /acme/i);
      const sse = await get(port, "/sse", true);
      assert.doesNotMatch(sse, /acme/i);
      const parsed = JSON.parse(written);
      const inc = (parsed.incidents ?? []).map((i) => i.id);
      assert.ok(inc.includes("INC-1015a"), `incident id is date + index only: ${inc}`);
      assert.doesNotMatch(JSON.stringify(inc), /acme|outage/i);
    } finally {
      const closed = new Promise((r) => child.once("close", r));
      child.kill();
      await closed;
    }
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* a lingering git child on Windows; the temp dir is disposable */
    }
  }
});
