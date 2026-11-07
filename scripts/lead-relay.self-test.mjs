#!/usr/bin/env node
// Self-test for scripts/lead-relay.mjs. Plain node: `node scripts/lead-relay.self-test.mjs`. rf is a fake.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TURN_CAP, decisionArgs, main, orderTurn, validatePlan } from "./lead-relay.mjs";

let failures = 0;
let passed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const route = (n) => ({ to: `lane-${n}`, text: `route ${n}` });
const decision = (n) => ({
  to: `lane-d${n}`,
  text: `owner decided ${n}`,
  kind: "owner-decision",
  item: `W-${n}`,
  question: `q${n}?`,
  answer: `a${n}`,
});

// orderTurn
{
  const plan = [route(1), route(2), decision(7), route(3)];
  const { now, later } = orderTurn(plan);
  check(
    "O1 the owner decision goes first even when the plan lists it third (W-1096)",
    now.map((m) => m.to),
    ["lane-d7", "lane-1", "lane-2", "lane-3"],
  );
  check("O1 nothing deferred under the cap", later, []);
}
{
  const plan = [...Array.from({ length: 10 }, (_, i) => route(i + 1)), decision(5)];
  const { now, later } = orderTurn(plan);
  check(
    "O2 ten routes and a decision: the decision is first and this turn holds the cap",
    [now[0].to, now.length],
    ["lane-d5", TURN_CAP],
  );
  check(
    "O2 the routes over the cap wait for the next turn, in plan order",
    later.map((m) => m.to),
    ["lane-9", "lane-10"],
  );
}
{
  const plan = Array.from({ length: TURN_CAP + 2 }, (_, i) => decision(i + 1));
  const { now, later } = orderTurn(plan);
  check(
    "O3 decisions are never deferred, even past the cap",
    [now.length, later.length],
    [TURN_CAP + 2, 0],
  );
}

// validatePlan
check(
  "V1 a decision without its item is refused",
  /needs "item"/.test(throws(() => validatePlan([{ ...decision(1), item: "" }])) ?? ""),
  true,
);
check(
  "V2 a message without text is refused",
  /"text" is required/.test(throws(() => validatePlan([{ to: "x" }])) ?? ""),
  true,
);
check(
  "V3 a non-array plan is refused",
  /JSON array/.test(throws(() => validatePlan({})) ?? ""),
  true,
);

// decisionArgs
check(
  "A1 the rf argv records question, answer, recommendation and item",
  decisionArgs({ ...decision(3), recommended: "a3" }),
  ["event", "owner-decision", "--question", "q3?", "--answer", "a3", "--recommended", "a3", "W-3"],
);

// main
const dir = mkdtempSync(path.join(os.tmpdir(), "lead-relay-"));
const planFile = path.join(dir, "plan.json");
writeFileSync(planFile, JSON.stringify([route(1), decision(4)]));
{
  const calls = [];
  const lines = [];
  const code = main([planFile], {
    runRf: (a) => (calls.push(a), { status: 0 }),
    out: (l) => lines.push(l),
  });
  check("M1 a dry run records nothing and exits 0", [code, calls.length], [0, 0]);
  check(
    "M1 it prints the rf command it would run",
    lines.some((l) => l.startsWith("would record:") && l.includes("W-4")),
    true,
  );
  check(
    "M1 the decision is send #1",
    lines.find((l) => /^\s+1\./.test(l))?.includes("[decision] lane-d4"),
    true,
  );
}
{
  const calls = [];
  const code = main([planFile, "--apply"], {
    runRf: (a) => (calls.push(a), { status: 0 }),
    out: () => {},
  });
  check(
    "M2 --apply records each decision through rf, before any send is printed",
    [code, calls.map((a) => a.at(-1))],
    [0, ["W-4"]],
  );
}
{
  const lines = [];
  const code = main([planFile, "--apply"], {
    runRf: () => ({ status: 1, stderr: "store busy" }),
    out: (l) => lines.push(l),
  });
  check(
    "M3 a decision rf cannot record exits 1 and prints no send list",
    [code, lines.some((l) => /send this turn/.test(l))],
    [1, false],
  );
}
{
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, "not json");
  check("M4 a plan that is not JSON exits 2", main([bad], { out: () => {} }), 2);
  check("M5 no plan file exits 2", main([], { out: () => {} }), 2);
}
rmSync(dir, { recursive: true, force: true });

console.log(`lead-relay self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
