#!/usr/bin/env node
// Self-test for scripts/lib/lane-idle.mjs + scripts/lane-idle.mjs: pure, no network, no clock (fake gh, fixed now).
import { main } from "./lane-idle.mjs";
import { idleLanes } from "./lib/lane-idle.mjs";

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

const NOW = Date.parse("2026-11-25T22:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const c = (body, min, id = 1) => ({ id, body, created_at: ago(min) });
const LANES = [
  { id: "mac", machine: "mac", kind: "reader" },
  { id: "mac-3", machine: "mac", kind: "reader" },
];
const row = (comments, id = "mac") => idleLanes(comments, LANES, NOW).find((r) => r.id === id);

check(
  "L1 a VERDICT 16 minutes ago with no newer CLAIM is idle",
  [
    row([c("CLAIM R-1 · mac", 40), c("VERDICT R-1 · mac\n# PASS", 16)]).idle,
    row([c("CLAIM R-1 · mac", 40), c("VERDICT R-1 · mac\n# PASS", 16)]).busy,
  ],
  [true, false],
);
check(
  "L2 a CLAIM held for 3 hours is busy, never idle",
  [
    row([c("CLAIM R-2 · mac · long read", 180)]).busy,
    row([c("CLAIM R-2 · mac · long read", 180)]).idle,
  ],
  [true, false],
);
check(
  "L3 a VERDICT 14 minutes ago is not idle yet",
  [row([c("VERDICT R-3 · mac", 14)]).idle, row([c("VERDICT R-3 · mac", 14)]).busy],
  [false, false],
);
check(
  "L4 lane A's CLAIM followed by lane B's VERDICT does not release A",
  [
    row([c("CLAIM R-4 · mac", 60), c("VERDICT R-4 · mac-3\n# PASS", 30)]).busy,
    row([c("CLAIM R-4 · mac", 60), c("VERDICT R-4 · mac-3\n# PASS", 30)]).idle,
  ],
  [true, false],
);
check(
  "L4b a newer CLAIM after a VERDICT makes the lane busy again; PUSHED, DONE and IDLE also release",
  [
    row([c("VERDICT R-1 · mac", 90), c("CLAIM R-5 · mac", 80)]).busy,
    ...["PUSHED", "DONE", "IDLE"].map(
      (k) => row([c("CLAIM R-6 · mac", 60), c(`${k} R-6 · mac`, 30)]).idle,
    ),
  ],
  [true, true, true, true],
);

// Fake gh: one page of comments, records every write.
const fakeGh = (comments, writes) => (args) => {
  const url = args.find((a) => a.startsWith("repos/")) ?? "";
  if (args.includes("--jq")) return String(comments.length);
  if (args.includes("-X")) {
    writes.push([args[args.indexOf("-X") + 1], url]);
    return "{}";
  }
  return JSON.stringify(comments);
};
const cfg = { board: { repo: "o/r", issue: 1 }, lanes: LANES };
const quiet = () => {};
{
  const sticky = c("LANE IDLE (auto) · updated 2026-11-25T21:55Z", 5, 99);
  const writes = [];
  const code = main([], {
    gh: fakeGh([c("CLAIM R-1 · mac", 30), sticky], writes),
    leakCheck: () => true,
    now: () => NOW,
    log: quiet,
    config: cfg,
  });
  check(
    "L5 with a sticky comment present: exactly one PATCH of that comment and zero POSTs",
    [
      code,
      writes.filter((w) => w[0] === "PATCH").length,
      writes.filter((w) => w[0] === "POST").length,
      writes[0]?.[1],
    ],
    [0, 1, 0, "repos/o/r/issues/comments/99"],
  );
  const writes2 = [];
  main(["--dry-run"], {
    gh: fakeGh([sticky], writes2),
    leakCheck: () => true,
    now: () => NOW,
    log: quiet,
    config: cfg,
  });
  check("L5b --dry-run writes nothing", writes2.length, 0);
}
{
  const writes = [];
  const code = main([], {
    gh: fakeGh([c("LANE IDLE (auto) · updated x", 5, 99)], writes),
    leakCheck: () => false,
    now: () => NOW,
    log: quiet,
    config: cfg,
  });
  check(
    "L6 a body that fails the leak check is not written (exit 1, no PATCH, no POST)",
    [code, writes.length],
    [1, 0],
  );
}

console.log(`lane-idle self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
