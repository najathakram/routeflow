import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../lib/config.mjs";

const LIVE_LANES = [
  "lead",
  "sa",
  "win-heavy",
  "win-billing",
  "win-salvage",
  "macmini",
  "mm-landing",
  "mm-counter",
  "macbook",
  "owner",
];

test("loadConfig without ops/config.json falls back to the current live lane set", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-cfg-"));
  const cfg = loadConfig(dir);
  assert.deepEqual(
    cfg.lanes.map((l) => l.id),
    LIVE_LANES,
  );
  const byId = Object.fromEntries(cfg.lanes.map((l) => [l.id, l]));
  assert.equal(byId["mm-counter"].machine, "windows");
  assert.equal(byId["mm-landing"].machine, "macmini");
  assert.deepEqual(byId["win-billing"].areas, ["domain:billing"]);
  assert.equal(byId.owner.machine, null);
});

test("every default lane alias targets an existing default lane id", () => {
  const ids = new Set(DEFAULT_CONFIG.lanes.map((l) => l.id));
  for (const [alias, target] of Object.entries(DEFAULT_CONFIG.laneAliases)) {
    assert.ok(ids.has(target), `alias "${alias}" -> unknown lane ${target}`);
  }
  assert.equal(DEFAULT_CONFIG.laneAliases.counter, "mm-counter");
  assert.equal(DEFAULT_CONFIG.laneAliases["pc lane"], "lead");
});

import { writeFileSync, mkdirSync } from "node:fs";
import { resolveLaneId } from "../lib/config.mjs";

function cfgDir(obj) {
  const dir = mkdtempSync(join(tmpdir(), "ops-cfg-"));
  mkdirSync(join(dir, "ops"));
  writeFileSync(join(dir, "ops", "config.json"), JSON.stringify(obj));
  return dir;
}

test("a config file's lanes replace the defaults", () => {
  const cfg = loadConfig(cfgDir({ lanes: [{ id: "a" }, { id: "b" }] }));
  assert.deepEqual(
    cfg.lanes.map((l) => l.id),
    ["a", "b"],
  );
});

test("merged default aliases whose target the file's lanes omit are dropped", () => {
  const cfg = loadConfig(
    cfgDir({ lanes: [{ id: "lead" }, { id: "x" }], laneAliases: { ex: "x", nope: "gone" } }),
  );
  assert.equal(cfg.laneAliases["pc lane"], "lead");
  assert.equal(cfg.laneAliases.ex, "x");
  assert.equal(cfg.laneAliases.counter, undefined); // target mm-counter not configured
  assert.equal(cfg.laneAliases.nope, undefined);
  for (const t of Object.values(cfg.laneAliases)) assert.ok(["lead", "x"].includes(t), t);
});

test("resolveLaneId: configured id, alias to a configured lane, else null", () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), "ops-cfg-")));
  assert.equal(resolveLaneId("macmini", cfg), "macmini");
  assert.equal(resolveLaneId("pc-lane", cfg), "lead");
  assert.equal(resolveLaneId("coordinator", cfg), "lead");
  assert.equal(resolveLaneId("ops-monitor", cfg), "mm-landing");
  assert.equal(resolveLaneId("ghost", cfg), null);
  assert.equal(resolveLaneId(null, cfg), null);
});
