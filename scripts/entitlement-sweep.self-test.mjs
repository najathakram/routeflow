#!/usr/bin/env node
// T11 (FG-1 WP1) — self-test for `scripts/entitlement-sweep.mjs --compare a.json b.json`.
// Plain node: `node scripts/entitlement-sweep.self-test.mjs`. Runs the compare on temp files and
// checks the exit code: same -> 0; a bit differs while inputsHash is unchanged -> 2; a bit differs
// but inputsHash changed -> 0. Also: the compare prints only hashed ids and key names; a
// non-local base URL is refused without the per-command owner flag.
// SA-1100 §3: --check (agree / courtesy gap / unexplained / client drift), the not-comparable refusal
// on a mode or env change (exit 3), the key-set rule and --new-keys, and (WP2) --expect wp2 / --check --after-wp2.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "entitlement-sweep.mjs");
let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

const bits = (over = {}) => ({
  old: true,
  effective: true,
  strict: true,
  clientAddon: null,
  clientFlag: true,
  ...over,
});
const file = (inputsHash, keyBits) => ({
  mode: "shadow",
  planFlagEnforcement: "off",
  tenants: [
    {
      id: "h-0001",
      class: "PRODUCTION",
      inputsHash,
      keys: { "flag.reports": keyBits, "flag.analytics": bits() },
      sets: { "order_delivery|developer_mode": { old: true, effective: true } },
    },
  ],
});

const dir = mkdtempSync(path.join(tmpdir(), "entitlement-sweep-"));
const write = (name, obj) => {
  const p = path.join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

try {
  const a = write("a.json", file("in-1", bits()));
  const same = write("same.json", file("in-1", bits()));
  const diffSameInputs = write("diff-same-inputs.json", file("in-1", bits({ effective: false })));
  const diffNewInputs = write("diff-new-inputs.json", file("in-2", bits({ effective: false })));

  check("same files -> exit 0", run(["--compare", a, same]).status, 0);
  const bad = run(["--compare", a, diffSameInputs]);
  check("bit differs, inputsHash unchanged -> exit 2", bad.status, 2);
  check(
    "the report names the hashed tenant and the key only",
    /h-0001/.test(bad.stdout) && /flag\.reports/.test(bad.stdout) && !/PRODUCTION/.test(bad.stdout),
    true,
  );
  check(
    "bit differs, inputsHash changed -> exit 0",
    run(["--compare", a, diffNewInputs]).status,
    0,
  );

  // A set row difference with unchanged inputs is a difference too.
  const setDiff = file("in-1", bits());
  setDiff.tenants[0].sets["order_delivery|developer_mode"].effective = false;
  check(
    "set row differs, inputsHash unchanged -> exit 2",
    run(["--compare", a, write("set.json", setDiff)]).status,
    2,
  );

  // ── SA-1100 §3 (B): between two sweeps ─────────────────────────────────────────────────────────
  const withEnv = (obj, over) => ({ ...obj, ...over });
  const modeFlip = write("mode-flip.json", withEnv(file("in-1", bits()), { mode: "live" }));
  const envFlip = write(
    "env-flip.json",
    withEnv(file("in-1", bits()), { planFlagEnforcement: "on" }),
  );
  const modeRun = run(["--compare", a, modeFlip]);
  check("mode differs -> refused, exit 3 (never just a note)", modeRun.status, 3);
  check("env differs -> refused, exit 3", run(["--compare", a, envFlip]).status, 3);
  check(
    "the refusal says 'not comparable' and prints no DIFF lines",
    /not comparable/.test(modeRun.stderr) && !/DIFF/.test(modeRun.stdout),
    true,
  );

  const withKey = (obj, name, b) => {
    const copy = JSON.parse(JSON.stringify(obj));
    copy.tenants[0].keys[name] = b;
    return copy;
  };
  const added = write("added.json", withKey(file("in-1", bits()), "flag.new_thing", bits()));
  const addedRun = run(["--compare", a, added]);
  check("a key present in only the second file -> exit 2", addedRun.status, 2);
  check(
    "the report names the key",
    /KEY-ONLY-IN-SECOND flag\.new_thing/.test(addedRun.stdout),
    true,
  );
  check(
    "--new-keys names the added key -> exit 0",
    run(["--compare", a, added, "--new-keys", "flag.new_thing"]).status,
    0,
  );
  check(
    "--new-keys never excuses a key that disappeared (only in the first file) -> exit 2",
    run(["--compare", added, a, "--new-keys", "flag.new_thing"]).status,
    2,
  );
  check("a key present in only the first file -> exit 2", run(["--compare", added, a]).status, 2);
  const strictDiff = write("strict-diff.json", file("in-1", bits({ strict: false })));
  check(
    "strict differs with unchanged inputs -> exit 2",
    run(["--compare", a, strictDiff]).status,
    2,
  );
  const clientDiff = write("client-diff.json", file("in-1", bits({ clientFlag: false })));
  check(
    "a client bit differs with unchanged inputs -> exit 2",
    run(["--compare", a, clientDiff]).status,
    2,
  );
  // ── FG-1 WP2 (SA-1100 §3 B): --expect wp2 ─────────────────────────────────────────────────────
  // S1 (before WP2): effective == strict. S2 (after): a courtesy row is served (effective true) but
  // not strict, and B.strict must equal A.effective.
  const wp2Row = (over) => ({
    old: true,
    effective: false,
    strict: false,
    clientAddon: null,
    clientFlag: false,
    courtesy: true,
    ...over,
  });
  const wp2File = (row, extraKeys = {}) => ({
    mode: "shadow",
    planFlagEnforcement: "off",
    tenants: [
      {
        id: "h-0001",
        class: "PRODUCTION",
        inputsHash: "in-1",
        keys: { "flag.reports": row, ...extraKeys },
        sets: {},
      },
    ],
  });
  const s1 = write("wp2-s1.json", wp2File(wp2Row({})));
  const s2Good = write("wp2-s2-good.json", wp2File(wp2Row({ effective: true, strict: false })));
  check(
    "--compare --expect wp2: false -> true on a courtesy row, strict equals A.effective -> exit 0",
    run(["--compare", s1, s2Good, "--expect", "wp2"]).status,
    0,
  );
  check(
    "the same pair WITHOUT --expect wp2 is still a difference -> exit 2",
    run(["--compare", s1, s2Good]).status,
    2,
  );
  const s2NoCourtesy = write(
    "wp2-s2-nocourtesy.json",
    wp2File(wp2Row({ effective: true, strict: false, courtesy: false })),
  );
  check(
    "--expect wp2: a row that became served without the courtesy bit -> exit 2",
    run(["--compare", s1, s2NoCourtesy, "--expect", "wp2"]).status,
    2,
  );
  const s2OldMoved = write(
    "wp2-s2-oldmoved.json",
    wp2File(wp2Row({ effective: true, strict: false, old: false })),
  );
  check(
    "--expect wp2: old may not move -> exit 2",
    run(["--compare", s1, s2OldMoved, "--expect", "wp2"]).status,
    2,
  );
  const s2StrictWrong = write(
    "wp2-s2-strictwrong.json",
    wp2File(wp2Row({ effective: true, strict: true })),
  );
  check(
    "--expect wp2: B.strict that differs from A.effective -> exit 2",
    run(["--compare", s1, s2StrictWrong, "--expect", "wp2"]).status,
    2,
  );
  const s2Lost = write(
    "wp2-s2-lost.json",
    wp2File(wp2Row({ effective: false, strict: false }), {}),
  );
  const s1Served = write("wp2-s1-served.json", wp2File(wp2Row({ effective: true, strict: true })));
  check(
    "--expect wp2: effective may not go true -> false -> exit 2",
    run(["--compare", s1Served, s2Lost, "--expect", "wp2"]).status,
    2,
  );
  check(
    "--expect with any other value is refused (exit 3)",
    run(["--compare", s1, s2Good, "--expect", "wp3"]).status,
    3,
  );

  // ── SA-1100 §3 (A): inside ONE sweep ───────────────────────────────────────────────────────────
  const one = (keys, extra = {}) => ({
    mode: "shadow",
    planFlagEnforcement: "off",
    tenants: [{ id: "h-0001", class: "PRODUCTION", inputsHash: "in-1", keys, sets: {}, ...extra }],
  });
  const agree = write("check-agree.json", one({ "flag.reports": bits({ courtesy: false }) }));
  const checkAgree = run(["--check", agree]);
  check("--check: old == effective everywhere -> exit 0", checkAgree.status, 0);
  check(
    "--check prints mode and planFlagEnforcement",
    /mode shadow, planFlagEnforcement off/.test(checkAgree.stdout),
    true,
  );

  const gap = write(
    "check-gap.json",
    one({
      "flag.reports": bits({ effective: false, strict: false, courtesy: true }),
      ocr: bits({
        effective: false,
        strict: false,
        courtesy: true,
        clientFlag: null,
        clientAddon: true,
      }),
    }),
  );
  const gapRun = run(["--check", gap]);
  check(
    "--check: old true, effective false, courtesy true is a courtesy gap -> exit 0",
    gapRun.status,
    0,
  );
  check(
    "the courtesy gaps are counted per key",
    /COURTESY-GAP flag\.reports: 1/.test(gapRun.stdout) &&
      /COURTESY-GAP ocr: 1/.test(gapRun.stdout),
    true,
  );

  const noCourtesy = write(
    "check-unexplained-1.json",
    one({ "flag.reports": bits({ effective: false, strict: false, courtesy: false }) }),
  );
  const unexplainedRun = run(["--check", noCourtesy]);
  check(
    "--check: old true, effective false, courtesy false is unexplained -> exit 2",
    unexplainedRun.status,
    2,
  );
  check(
    "the report names the hashed tenant and the key",
    /UNEXPLAINED h-0001 flag\.reports/.test(unexplainedRun.stdout),
    true,
  );
  check(
    "--check: a file with no courtesy bit at all cannot excuse a gap -> exit 2",
    run(["--check", write("check-nobit.json", one({ k: bits({ effective: false }) }))]).status,
    2,
  );
  check(
    "--check: old false, effective true is unexplained even with courtesy -> exit 2",
    run([
      "--check",
      write(
        "check-widen.json",
        one({ k: bits({ old: false, effective: true, courtesy: true, clientFlag: false }) }),
      ),
    ]).status,
    2,
  );
  check(
    "--check: a tenant the resolver could not resolve is unexplained -> exit 2",
    run(["--check", write("check-error.json", one({}, { error: "resolve_failed" }))]).status,
    2,
  );
  const setGap = one({});
  setGap.tenants[0].sets = {
    "order_delivery|developer_mode": {
      old: true,
      effective: false,
      strict: false,
      clientAddon: false,
      courtesy: false,
    },
  };
  check(
    "--check: a set row is classified too (a gap without courtesy) -> exit 2",
    run(["--check", write("check-set.json", setGap)]).status,
    2,
  );

  const drift = write(
    "check-drift.json",
    one({
      "flag.reports": bits({ courtesy: false, clientFlag: false }),
      ocr: bits({ courtesy: false, clientFlag: null, clientAddon: false }),
      "flag.estimates": bits({ courtesy: false, clientFlag: true }),
    }),
  );
  const driftRun = run(["--check", drift]);
  check("--check: client drift is listed per key but never fails -> exit 0", driftRun.status, 0);
  check(
    "drift names flag keys by clientFlag and add-on keys by clientAddon",
    /CLIENT-DRIFT h-0001 flag\.reports clientFlag=false/.test(driftRun.stdout) &&
      /CLIENT-DRIFT h-0001 ocr clientAddon=false/.test(driftRun.stdout) &&
      !/flag\.estimates/.test(driftRun.stdout),
    true,
  );

  // M-8 (SA-1106 section 5): the client is compared with STRICT (what clients are meant to show), not with
  // `old`. A courtesy-served key the client rightly hides is "agree, hidden by design"; drift is a real defect.
  const hidden = write(
    "check-drift-hidden.json",
    one({
      "flag.reports": bits({
        old: true,
        effective: true,
        strict: false,
        courtesy: true,
        clientFlag: false,
      }),
      ocr: bits({
        old: true,
        effective: true,
        strict: false,
        courtesy: true,
        clientFlag: null,
        clientAddon: false,
      }),
      "flag.estimates": bits({ strict: true, clientFlag: false }),
    }),
  );
  const hiddenRun = run(["--check", hidden]);
  check("M-8: a courtesy key the client hides is not drift; a real miss is", hiddenRun.status, 0);
  check(
    "M-8: only the key where client != strict is listed",
    /CLIENT-DRIFT h-0001 flag.estimates clientFlag=false/.test(hiddenRun.stdout) &&
      !/CLIENT-DRIFT h-0001 flag.reports/.test(hiddenRun.stdout) &&
      !/CLIENT-DRIFT h-0001 ocr/.test(hiddenRun.stdout),
    true,
  );

  const live = run([
    "--check",
    write("check-live.json", withEnv(one({ k: bits({ courtesy: false }) }), { mode: "live" })),
  ]);
  check(
    "--check: mode live prints the WP2 stop line and exits 4 (never 0)",
    live.status === 4 && /WP2-STOP/.test(live.stdout),
    true,
  );
  const envOn = run([
    "--check",
    write(
      "check-env-on.json",
      withEnv(one({ k: bits({ courtesy: false }) }), { planFlagEnforcement: "on" }),
    ),
  ]);
  check(
    "--check: planFlagEnforcement on prints the WP2 stop line and exits 4",
    envOn.status === 4 && /WP2-STOP/.test(envOn.stdout),
    true,
  );
  const stopAndUnexplained = run([
    "--check",
    write(
      "check-live-unexplained.json",
      withEnv(one({ k: bits({ effective: false, courtesy: false }) }), { mode: "live" }),
    ),
  ]);
  check(
    "--check: a stop plus an unexplained row exits 4 and prints both lines",
    stopAndUnexplained.status === 4 &&
      /WP2-STOP/.test(stopAndUnexplained.stdout) &&
      /UNEXPLAINED/.test(stopAndUnexplained.stdout),
    true,
  );
  // An unusable file is refused (exit 3), never read as a pass.
  const refuseCheck = (name, obj) => run(["--check", write(name, obj)]);
  check(
    "--check: a file with no tenants -> exit 3",
    refuseCheck("c-empty.json", { mode: "shadow", planFlagEnforcement: "off", tenants: [] }).status,
    3,
  );
  check(
    "--check: a headerless file ({ tenants: [] }) -> exit 3",
    refuseCheck("c-headerless.json", { tenants: [] }).status,
    3,
  );
  check(
    "--check: mode missing -> exit 3",
    refuseCheck("c-nomode.json", { planFlagEnforcement: "off", tenants: one({}).tenants }).status,
    3,
  );
  check(
    "--check: planFlagEnforcement missing -> exit 3",
    refuseCheck("c-noenv.json", { mode: "shadow", tenants: one({}).tenants }).status,
    3,
  );
  check(
    "--check: the API said the mode read failed (modeReadFailed) -> exit 3",
    refuseCheck("c-modefail.json", {
      modeReadFailed: true,
      planFlagEnforcement: "off",
      tenants: one({}).tenants,
    }).status,
    3,
  );
  check(
    "--compare: a file whose mode read failed is not comparable -> exit 3",
    run([
      "--compare",
      a,
      write("c-modefail2.json", { ...file("in-1", bits()), mode: undefined, modeReadFailed: true }),
    ]).status,
    3,
  );
  // A tenant that resolved in A and errors in B (or the reverse) is a difference, not a skip.
  const errored = file("in-9", bits());
  errored.tenants[0] = {
    id: "h-0001",
    class: "PRODUCTION",
    inputsHash: "in-9",
    keys: {},
    sets: {},
    error: "resolve_failed",
  };
  const bothTenants = (f) => {
    const copy = JSON.parse(JSON.stringify(f));
    copy.tenants.push({
      id: "h-0002",
      class: "PRODUCTION",
      inputsHash: "x",
      keys: { "flag.reports": bits(), "flag.analytics": bits() },
      sets: { "order_delivery|developer_mode": { old: true, effective: true } },
    });
    return copy;
  };
  const okTwo = write("two-ok.json", bothTenants(file("in-1", bits())));
  const errTwo = write("two-err.json", bothTenants(errored));
  const errRun = run(["--compare", okTwo, errTwo]);
  check("--compare: a tenant that resolved in A and errors in B -> exit 2", errRun.status, 2);
  check(
    "the report names the tenant and the error",
    /DIFF h-0001 \(resolve_failed\) error/.test(errRun.stdout),
    true,
  );
  check(
    "--compare: the reverse (errors in A, resolves in B) -> exit 2",
    run(["--compare", errTwo, okTwo]).status,
    2,
  );
  // ── FG-1 WP2 (SA-1100 §3 A): --check --after-wp2 ───────────────────────────────────────────────
  const afterRow = (over) => ({
    old: true,
    effective: true,
    strict: false,
    clientAddon: null,
    clientFlag: true,
    courtesy: true,
    ...over,
  });
  const afterFile = (rows) => ({
    mode: "shadow",
    planFlagEnforcement: "off",
    tenants: [{ id: "h-0001", class: "PRODUCTION", inputsHash: "in-1", keys: rows, sets: {} }],
  });
  const gapFile = write(
    "after-gap.json",
    afterFile({ "flag.reports": afterRow({ effective: false }) }),
  );
  check(
    "--check without the flag: a courtesy gap is expected -> exit 0",
    run(["--check", gapFile]).status,
    0,
  );
  const afterGapRun = run(["--check", gapFile, "--after-wp2"]);
  check("--check --after-wp2: a courtesy gap now fails -> exit 2", afterGapRun.status, 2);
  check("the report names the gap", /COURTESY-GAP flag.reports: 1/.test(afterGapRun.stdout), true);
  const servedFile = write("after-served.json", afterFile({ "flag.reports": afterRow({}) }));
  check(
    "--check --after-wp2: served by courtesy, strict false, courtesy bit on -> exit 0",
    run(["--check", servedFile, "--after-wp2"]).status,
    0,
  );
  const orphanFile = write(
    "after-orphan.json",
    afterFile({ "flag.reports": afterRow({ courtesy: false }) }),
  );
  check(
    "--check --after-wp2: served without strict and without the courtesy bit -> exit 2",
    run(["--check", orphanFile, "--after-wp2"]).status,
    2,
  );
  check(
    "--check --after-wp2: the stop line for a live mode still wins (exit 4)",
    run([
      "--check",
      write("after-live.json", { ...afterFile({ "flag.reports": afterRow({}) }), mode: "live" }),
      "--after-wp2",
    ]).status,
    4,
  );

  // Never against production by itself: a non-local base URL is refused (exit 3), no network call.
  const refused = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ENTITLEMENT_SWEEP_API_URL: "https://api.example.com/api/v1",
      ENTITLEMENT_SWEEP_TOKEN: "t",
    },
  });
  check("non-local base URL without the owner flag -> exit 3", refused.status, 3);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nentitlement-sweep self-test passed");
