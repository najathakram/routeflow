#!/usr/bin/env node
// Self-test for b681-correct-ledger.mjs's five ruled apply-gate behaviors (architect ruling
// 2026-09-22, relayed by the fleet lead): the live-deployed-sha refusal, the pricing-dist stamp
// recorded in the plan, the per-row evidence hash (covered in b681-ledger-query.self-test.mjs),
// the explicit refusal when a correction row already exists, and the statement timeout. Fixtures
// and injected fakes only -- no database connection, no real git shell-out, no network call, no
// Docker. Run directly: `node apps/api/scripts/b681-correct-ledger.self-test.mjs`.
import assert from "node:assert/strict";
import {
  STATEMENT_TIMEOUT_SQL,
  sha256,
  buildPlan,
  refuseIfExistingCorrections,
  refuseIfExistingParkedReversals,
  verifyGuardSha,
  verifyLiveDeployedSha,
} from "./b681-correct-ledger.mjs";

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

async function at(name, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function refuses(fn) {
  try {
    fn();
    return { threw: false };
  } catch (e) {
    return { threw: true, refuse: !!e.refuse, message: e.message };
  }
}

async function refusesAsync(fn) {
  try {
    await fn();
    return { threw: false };
  } catch (e) {
    return { threw: true, refuse: !!e.refuse, message: e.message };
  }
}

// --- item 5: the 120s statement timeout is a single shared constant --------------------------

t("STATEMENT_TIMEOUT_SQL is exactly the ruled 120s value", () => {
  assert.equal(STATEMENT_TIMEOUT_SQL, "SET LOCAL statement_timeout = '120s'");
});

// --- item 2: the pricing-dist freshness stamp is recorded in the plan --------------------------

t("buildPlan records pricingStamp.srcHash as the plan's pricingDistStamp", () => {
  const plan = buildPlan({
    fp: { database: "db1", tenantIds: ["t1"] },
    pricingStamp: { srcHash: "deadbeef" },
    corrections: [],
    parkedReversals: [],
    generatedAt: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(plan.pricingDistStamp, "deadbeef");
});

t("buildPlan's planHash is sha256 of every OTHER field, and never includes itself", () => {
  const plan = buildPlan({
    fp: { database: "db1", tenantIds: ["t1"] },
    pricingStamp: { srcHash: "deadbeef" },
    corrections: [{ rowId: "r1" }],
    parkedReversals: [],
    generatedAt: "2026-09-22T00:00:00.000Z",
  });
  const { planHash, ...unstamped } = plan;
  assert.equal(sha256(unstamped), planHash);
  // Exactly what apply()'s own --confirm-plan check does (b681-correct-ledger.mjs's `apply`):
  // `sha256(unstamped) !== confirmPlan || planHash !== confirmPlan` must both pass together.
  assert.equal(planHash, plan.planHash);
});

t("buildPlan: two calls with the same inputs (incl. generatedAt) hash identically", () => {
  const args = {
    fp: { database: "db1", tenantIds: ["t1"] },
    pricingStamp: { srcHash: "deadbeef" },
    corrections: [{ rowId: "r1" }],
    parkedReversals: [],
    generatedAt: "2026-09-22T00:00:00.000Z",
  };
  assert.equal(buildPlan(args).planHash, buildPlan({ ...args }).planHash);
});

t("buildPlan: a different pricingStamp changes the plan hash (drift is detectable)", () => {
  const base = {
    fp: { database: "db1", tenantIds: ["t1"] },
    corrections: [],
    parkedReversals: [],
    generatedAt: "2026-09-22T00:00:00.000Z",
  };
  const a = buildPlan({ ...base, pricingStamp: { srcHash: "aaaa" } });
  const b = buildPlan({ ...base, pricingStamp: { srcHash: "bbbb" } });
  assert.notEqual(a.planHash, b.planHash);
  assert.notEqual(a.pricingDistStamp, b.pricingDistStamp);
});

// --- item 4: explicit refusal when a correction (or parked reversal) row already exists --------

t("refuseIfExistingCorrections: no existing rows -> does not throw", () => {
  refuseIfExistingCorrections([]);
});

t("refuseIfExistingCorrections: any existing row -> throws refuse:true, names the count", () => {
  const r = refuses(() => refuseIfExistingCorrections([{ correctsEntryId: "e1" }]));
  assert.equal(r.threw, true);
  assert.equal(r.refuse, true);
  assert.match(r.message, /1 row\(s\) in this plan already have a correction/);
  assert.match(r.message, /refusing/);
});

t("refuseIfExistingParkedReversals: no existing rows -> does not throw", () => {
  refuseIfExistingParkedReversals([]);
});

t("refuseIfExistingParkedReversals: any existing row -> throws refuse:true", () => {
  const r = refuses(() =>
    refuseIfExistingParkedReversals([{ returnId: "ret1", saleEntryId: "sale1" }]),
  );
  assert.equal(r.threw, true);
  assert.equal(r.refuse, true);
  assert.match(r.message, /1 parked-reversal row\(s\) in this plan already exist/);
});

// --- item 1: the live-deployed-sha check REFUSES on a proven mismatch, WARNS only on an --------
// --- undetermined network/git stage. All git/network calls below are injected fakes. -----------

t("verifyGuardSha: guard sha IS an ancestor of HEAD -> does not throw", () => {
  const exec = () => "headsha123\n"; // rev-parse and merge-base both "succeed" (no throw)
  verifyGuardSha("guardsha", { exec, repoRoot: "/fake/repo" });
});

t("verifyGuardSha: guard sha is NOT an ancestor of HEAD -> throws refuse:true", () => {
  const exec = (_cmd, args) => {
    if (args.includes("rev-parse")) return "headsha123\n";
    throw new Error("git merge-base exited 1"); // --is-ancestor: provably false
  };
  const r = refuses(() => verifyGuardSha("guardsha", { exec, repoRoot: "/fake/repo" }));
  assert.equal(r.threw, true);
  assert.equal(r.refuse, true);
  assert.match(r.message, /is not an ancestor of this checkout's HEAD/);
});

await at(
  "verifyLiveDeployedSha: health endpoint unreachable -> WARNS, does not throw",
  async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    // Must resolve cleanly (undefined), never throw, on a genuinely undetermined network stage.
    const result = await verifyLiveDeployedSha("guardsha", { fetchImpl });
    assert.equal(result, undefined);
  },
);

await at(
  "verifyLiveDeployedSha: health endpoint returns no commit -> WARNS, does not throw",
  async () => {
    const fetchImpl = async () => ({ json: async () => ({}) });
    const result = await verifyLiveDeployedSha("guardsha", { fetchImpl });
    assert.equal(result, undefined);
  },
);

await at(
  "verifyLiveDeployedSha: live commit unresolvable locally AND git fetch origin fails -> WARNS, does not throw",
  async () => {
    const fetchImpl = async () => ({ json: async () => ({ commit: "livesha456" }) });
    const exec = () => {
      throw new Error("unknown revision"); // both cat-file -e and fetch origin fail
    };
    const result = await verifyLiveDeployedSha("guardsha", { fetchImpl, exec });
    assert.equal(result, undefined);
  },
);

await at(
  "verifyLiveDeployedSha: live commit resolved, ancestry PROVEN FALSE -> REFUSES (throws refuse:true), never just warns",
  async () => {
    const fetchImpl = async () => ({ json: async () => ({ commit: "livesha456" }) });
    const exec = (_cmd, args) => {
      if (args.includes("cat-file")) return ""; // commit already present locally
      if (args.includes("merge-base")) throw Object.assign(new Error("exit 1"), { status: 1 });
      return "";
    };
    const r = await refusesAsync(() => verifyLiveDeployedSha("guardsha", { fetchImpl, exec }));
    assert.equal(r.threw, true);
    assert.equal(
      r.refuse,
      true,
      "a proven non-ancestor deploy must REFUSE, not just log and continue",
    );
    assert.match(r.message, /is not provably at or before the live deployed commit livesha456/);
  },
);

await at(
  "verifyLiveDeployedSha: live commit resolved via git fetch origin, ancestry proven TRUE -> resolves cleanly",
  async () => {
    const fetchImpl = async () => ({ json: async () => ({ commit: "livesha456" }) });
    let fetchedOrigin = false;
    const exec = (_cmd, args) => {
      if (args.includes("cat-file")) throw new Error("not found locally yet");
      if (args.includes("fetch")) {
        fetchedOrigin = true;
        return "";
      }
      if (args.includes("merge-base")) return ""; // exit 0 -- guard sha IS an ancestor
      return "";
    };
    const result = await verifyLiveDeployedSha("guardsha", { fetchImpl, exec });
    assert.equal(result, undefined);
    assert.equal(fetchedOrigin, true, "should have fallen through to `git fetch origin` first");
  },
);

console.log(`b681-correct-ledger self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
