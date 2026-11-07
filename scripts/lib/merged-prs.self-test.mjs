#!/usr/bin/env node
// Self-test for scripts/lib/merged-prs.mjs. Plain node: `node scripts/lib/merged-prs.self-test.mjs`.
// No gh, git or network: pages come from an in-memory list, gh from a fake that records its args.
import {
  ghMergedPrPages,
  listMergedPrsSince,
  mergedPrsQuery,
  pagesFromList,
} from "./merged-prs.mjs";

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

const day = (d) => `2026-11-${String(d).padStart(2, "0")}T12:00:00Z`;
const pr = (number, merged, updated = merged) => ({
  number,
  title: `pr ${number}`,
  mergedAt: day(merged),
  updatedAt: day(updated),
});
// 12 PRs merged 11-01..11-12, plus #50 merged on 10-31-ish (day 0 is invalid, so use an explicit date)
const list = [
  ...Array.from({ length: 12 }, (_, i) => pr(101 + i, i + 1)),
  { number: 50, title: "old", mergedAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-20T12:00:00Z" },
];
const counting = (fetchPage) => {
  const calls = [];
  return {
    calls,
    fetchPage: (args) => {
      calls.push(args);
      return fetchPage(args);
    },
  };
};

// 1. pages until a page ends below the floor, then stops: never fetches pages it does not need
{
  const c = counting(pagesFromList(list));
  const got = listMergedPrsSince(Date.parse(day(9)), c.fetchPage, { pageSize: 3 });
  check(
    "M1 only PRs merged at or after the floor, newest first",
    got.map((p) => p.number),
    [112, 111, 110, 109],
  );
  check("M2 stops on the page whose last row is below the floor (2 of 5 pages)", c.calls.length, 2);
}

// 2. a PR merged before the floor but updated after it is skipped; one merged in range but updated later is kept
{
  const l = [pr(201, 2, 12), pr(202, 10, 11), pr(203, 9, 9), pr(204, 3, 3)];
  const got = listMergedPrsSince(Date.parse(day(9)), pagesFromList(l), { pageSize: 2 });
  check(
    "M3 filtering is on mergedAt; paging stops on updatedAt",
    got.map((p) => p.number),
    [202, 203],
  );
}

// 3. no truncation: the page cap throws instead of under-counting
{
  const msg = throws(() =>
    listMergedPrsSince(Date.parse("2026-10-01T00:00:00Z"), pagesFromList(list), {
      pageSize: 3,
      maxPages: 4,
    }),
  );
  check("M4 hitting maxPages before the floor fails loudly", /truncated/.test(msg ?? ""), true);
  const ok = listMergedPrsSince(Date.parse("2026-10-01T00:00:00Z"), pagesFromList(list), {
    pageSize: 3,
    maxPages: 5,
  });
  check("M5 the last page (no next page) ends the walk without throwing", ok.length, 13);
}

// 4. a PR that moves between pages while paging is counted once
{
  let served = 0;
  const pages = [
    { nodes: [pr(301, 12), pr(302, 11)], pageInfo: { hasNextPage: true, endCursor: "a" } },
    { nodes: [pr(302, 11), pr(303, 10)], pageInfo: { hasNextPage: false, endCursor: "b" } },
  ];
  const got = listMergedPrsSince(Date.parse(day(1)), () => pages[served++], {});
  check(
    "M6 duplicates across pages are folded by number",
    got.map((p) => p.number),
    [301, 302, 303],
  );
}

// 5. malformed pages throw, never read as "zero PRs"
check(
  "M7 a page without nodes throws",
  /no nodes/.test(throws(() => listMergedPrsSince(0, () => ({ pageInfo: {} }), {})) ?? ""),
  true,
);

// 6. the gh call: GraphQL, MERGED, UPDATED_AT DESC, no --search anywhere; cursor only after page 1
{
  const seen = [];
  const reply = (after) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: after ? [pr(2, 1, 1)] : [pr(1, 12)],
            pageInfo: { hasNextPage: !after, endCursor: after ? null : "CUR1" },
          },
        },
      },
    });
  const runGh = (args) => {
    seen.push(args);
    const i = args.indexOf("after=CUR1");
    return reply(i >= 0 ? "CUR1" : null);
  };
  const fetchPage = ghMergedPrPages(runGh, "acme/repo", "number title mergedAt updatedAt");
  const got = listMergedPrsSince(Date.parse(day(5)), fetchPage, { pageSize: 50 });
  check("G1 two pages fetched, second with the first page's cursor", seen.length, 2);
  check(
    "G2 no search query is ever used",
    seen.flat().some((a) => /--search|merged:/.test(a)),
    false,
  );
  check(
    "G3 GraphQL query asks for MERGED ordered by UPDATED_AT DESC",
    [
      seen[0][0] === "api" && seen[0][1] === "graphql",
      /states:\s*MERGED/.test(mergedPrsQuery("number")),
      /field:\s*UPDATED_AT,\s*direction:\s*DESC/.test(mergedPrsQuery("number")),
    ],
    [true, true, true],
  );
  check(
    "G4 owner/name/first passed as variables; page 1 has no cursor",
    [
      seen[0].includes("owner=acme"),
      seen[0].includes("name=repo"),
      seen[0].includes("first=50"),
      seen[0].some((a) => a.startsWith("after=")),
    ],
    [true, true, true, false],
  );
  check(
    "G5 only the in-range PR is returned",
    got.map((p) => p.number),
    [1],
  );
  const errs = ghMergedPrPages(
    () => JSON.stringify({ errors: [{ message: "rate limited" }] }),
    "a/b",
    "number",
  );
  check(
    "G6 a GraphQL error throws with its message",
    /rate limited/.test(throws(() => errs({ after: null, first: 1 })) ?? ""),
    true,
  );
  const missing = ghMergedPrPages(
    () => JSON.stringify({ data: { repository: null } }),
    "a/b",
    "number",
  );
  check(
    "G7 a missing repository (no access) throws, never returns an empty page",
    /no pullRequests/.test(throws(() => missing({ after: null, first: 1 })) ?? ""),
    true,
  );
}

console.log(`merged-prs self-test: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
