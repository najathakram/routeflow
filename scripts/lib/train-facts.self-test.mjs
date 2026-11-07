#!/usr/bin/env node
// Self-test for scripts/lib/train-facts.mjs. Plain node: `node scripts/lib/train-facts.self-test.mjs`.
// No git or gh: both are fakes keyed by their args.
import {
  factsEnforced,
  latestReplay,
  mergeBaseCount,
  parseMembers,
  trainFacts,
} from "./train-facts.mjs";

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

const replayRow = (conclusion, completedAt, name = "Replay migrations on a fresh database") => ({
  workflowName: "Migration replay",
  name,
  status: completedAt ? "COMPLETED" : "IN_PROGRESS",
  conclusion: completedAt ? conclusion : "",
  completedAt,
});
const other = {
  workflowName: "CI",
  name: "Verify",
  status: "COMPLETED",
  conclusion: "FAILURE",
  completedAt: "2026-11-07T10:00:00Z",
};
const git = (bases) => (args) => {
  if (args[0] !== "merge-base" || args[1] !== "--all")
    throw new Error(`unexpected git ${args.join(" ")}`);
  return bases.map((b) => `${b}\n`).join("");
};
const gh = (byPr) => (args) => {
  const n = Number(args[2]);
  if (!(n in byPr)) throw new Error(`gh: no PR #${n}`);
  return JSON.stringify({ statusCheckRollup: byPr[n] });
};

// mergeBaseCount
check("B1 one merge base counts 1", mergeBaseCount(git(["aaa"])), 1);
check("B2 a criss-cross (two bases) counts 2", mergeBaseCount(git(["aaa", "bbb"])), 2);

// latestReplay
check("R1 no Migration replay row (paths filter skipped it) is null", latestReplay([other]), null);
check(
  "R2 the newest completed run wins over an older red one",
  latestReplay([
    replayRow("FAILURE", "2026-11-06T10:00:00Z"),
    replayRow("SUCCESS", "2026-11-07T10:00:00Z"),
  ])?.conclusion,
  "SUCCESS",
);
check(
  "R3 a newer red run wins over an older green one (#3977: the member's LATEST conclusion)",
  latestReplay([
    replayRow("SUCCESS", "2026-11-06T10:00:00Z"),
    replayRow("FAILURE", "2026-11-07T10:00:00Z"),
  ])?.conclusion,
  "FAILURE",
);
check(
  "R4 a run still going reads PENDING",
  latestReplay([replayRow("SUCCESS", "2026-11-06T10:00:00Z"), replayRow("", null)])?.conclusion,
  "PENDING",
);
check(
  "R5 another workflow's red check is never read as the replay",
  latestReplay([other, replayRow("SUCCESS", "2026-11-07T10:00:00Z")])?.conclusion,
  "SUCCESS",
);

// parseMembers
check("P1 commas, spaces and # all parse", parseMembers("4101,#4102 4103"), [4101, 4102, 4103]);
check("P2 empty is no members", parseMembers(""), []);
check(
  "P3 a token that is not a PR number throws",
  /not a PR number/.test(throws(() => parseMembers("4101,abc")) ?? ""),
  true,
);

// trainFacts
{
  const f = trainFacts({
    runGit: git(["aaa"]),
    runGh: gh({ 1: [replayRow("SUCCESS", "2026-11-07T10:00:00Z")], 2: [other] }),
    repo: "a/b",
    members: [1, 2],
  });
  check("T1 one base, a green member and a skipped member: not red", f.red, false);
  check("T1 every member gets a line", f.lines.length, 3);
  check(
    "T1 a skipped replay says it did not run",
    /#2 Migration replay: did not run/.test(f.lines[2]),
    true,
  );
}
{
  const f = trainFacts({ runGit: git(["aaa", "bbb"]), runGh: gh({}), repo: "a/b", members: [] });
  check(
    "T2 two merge bases is red and says to merge master up (#3999)",
    [f.red, /merge origin\/master up/.test(f.lines[0])],
    [true, true],
  );
}
{
  const f = trainFacts({
    runGit: git(["aaa"]),
    runGh: gh({ 7: [replayRow("FAILURE", "2026-11-07T10:00:00Z")] }),
    repo: "a/b",
    members: [7],
  });
  check(
    "T3 a member whose latest replay is red is red and names #3977",
    [f.red, /#7 .*FAILURE.*#3977/.test(f.lines[1])],
    [true, true],
  );
}
{
  const f = trainFacts({ runGit: git(["aaa"]), runGh: gh({}), repo: "a/b", members: [9] });
  check(
    "T4 a member gh cannot read is red (unknown), never a pass",
    [f.red, /#9 .*unknown/.test(f.lines[1])],
    [true, true],
  );
}
{
  const f = trainFacts({
    runGit: () => {
      throw new Error("fatal: Not a valid object name origin/master");
    },
    runGh: gh({}),
    repo: "a/b",
  });
  check(
    "T5 git failing is red (unknown), never a count of 0",
    [f.red, /merge bases: unknown/.test(f.lines[0])],
    [true, true],
  );
}
{
  const f = trainFacts({
    runGit: git(["aaa"]),
    runGh: gh({ 3: [replayRow("", null)] }),
    repo: "a/b",
    members: [3],
  });
  check("T6 a replay still running is red until it finishes", f.red, true);
}

// factsEnforced: dark unless TRAIN_FACTS=enforce
check("E1 unset is dark", factsEnforced({}), false);
check("E2 TRAIN_FACTS=enforce enforces", factsEnforced({ TRAIN_FACTS: "enforce" }), true);
check("E3 any other value stays dark", factsEnforced({ TRAIN_FACTS: "1" }), false);

console.log(`train-facts self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
