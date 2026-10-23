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
