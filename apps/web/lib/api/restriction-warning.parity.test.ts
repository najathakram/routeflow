import * as fs from "fs";
import * as path from "path";

/**
 * Row 510: the client logic (parse the 409, validate the ONE reason, build the per-line ack, the fixed dialog copy) exists
 * once per app because a mobile screen cannot import the web app and this row adds no shared-package file. The two files
 * must stay the SAME text below their header comment, so the web dialog and the mobile modal can never disagree.
 */
const body = (file: string) => {
  const src = fs.readFileSync(file, "utf8");
  return src.slice(src.indexOf("import {"));
};

/**
 * KNOWN DIVERGENCE (SA-961, SA-968): W-806 removed the "Legal ban" badge copy and the client-built `ruleText` fallback
 * sentence from the WEB helper only, and reworded the `lineRuleRows` doc comment. The mobile helper keeps all three,
 * unchanged: native is frozen (owner, 10-24). Delete the whole pin when the native app is retired.
 *
 * Each mask is COUNTED (OP-7), so it can neither go stale nor silently widen: the badge line is on mobile once and
 * on web never; the doc block and the `ruleText` block are on each side once. Every other byte must still match, and
 * a mask that stops matching leaves the bytes different, so the pin goes red.
 */
const MASKS = {
  legalBadge: [/ {2}legalBadge: "Legal ban",\n/g, ""],
  lineRuleRowsDoc: [/\/\*\*\n \* The rule lines to DISPLAY[\s\S]*?\*\/\n/g, "<lineRuleRows doc>\n"],
  ruleText: [
    /\/\*\* One rule's sentence[\s\S]*?\nexport function ruleText[\s\S]*?\n}\n/g,
    "<ruleText>\n",
  ],
} as const;
const hits = (text: string) =>
  Object.fromEntries(Object.entries(MASKS).map(([k, [re]]) => [k, (text.match(re) ?? []).length]));
const withoutKnownDivergence = (text: string) =>
  Object.values(MASKS).reduce((t, [re, to]) => t.replace(re, to), text);

describe("web and mobile restriction-warning helpers are the same code", () => {
  const web = body(path.resolve(__dirname, "restriction-warning.ts"));
  const mobile = body(path.resolve(__dirname, "../../../mobile/lib/restriction-warning.ts"));

  it("apps/web/lib/api/restriction-warning.ts === apps/mobile/lib/restriction-warning.ts below the header, past the masks", () => {
    expect(web.length).toBeGreaterThan(1500);
    expect(withoutKnownDivergence(mobile)).toBe(withoutKnownDivergence(web));
  });

  it("each mask hits exactly where it is meant to (a drift is caught)", () => {
    expect(hits(mobile)).toEqual({ legalBadge: 1, lineRuleRowsDoc: 1, ruleText: 1 });
    expect(hits(web)).toEqual({ legalBadge: 0, lineRuleRowsDoc: 1, ruleText: 1 });
  });
});
