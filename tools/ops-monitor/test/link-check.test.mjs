import test from "node:test";
import assert from "node:assert/strict";
import { linkMatches, readPrTitle } from "../lib/link-check.mjs";

test("a shared word matches, ignoring case, plurals and commit words", () => {
  assert.equal(
    linkMatches({ id: "W-1", title: "Hide barcodes on invoices" }, "fix(web): hide it"),
    true,
  );
  assert.equal(linkMatches({ id: "W-1", title: "Barcode on the invoice" }, "feat: Barcodes"), true);
  assert.equal(
    linkMatches({ id: "W-1", title: "Counter returns" }, "fix(counter): rounding"),
    true,
  );
});

test("words every title carries do not match", () => {
  assert.equal(
    linkMatches({ id: "W-1", title: "Fix the web tests" }, "fix(web): add tests"),
    false,
  );
  assert.equal(
    linkMatches({ id: "W-1", title: "Go to it" }, "feat(api): go to it"),
    false,
    "short",
  );
  assert.equal(linkMatches({ id: "W-1", title: "Order emails" }, "fix(web): drop overlap"), false);
});

test("the item's own id in the PR title matches", () => {
  assert.equal(linkMatches({ id: "W-853", title: "Order emails" }, "fix: W-853 overlap"), true);
  assert.equal(linkMatches({ id: "W-853", title: "Order emails" }, "fix: W-8530 overlap"), false);
});

test("readPrTitle asks gh for this repo's PR and returns null when it cannot", () => {
  const seen = [];
  const run = (cmd, args) => {
    seen.push([cmd, ...args]);
    return { status: 0, stdout: "fix: a title\n" };
  };
  assert.equal(readPrTitle(12, { env: {}, run }), "fix: a title");
  assert.deepEqual(seen[0].slice(0, 4), ["gh", "pr", "view", "12"]);
  assert.ok(seen[0].includes("najathakram/routeflow"));
  assert.equal(readPrTitle(12, { env: {}, run: () => ({ status: 1, stdout: "" }) }), null);
  assert.equal(readPrTitle(12, { env: {}, run: () => ({ error: new Error("ENOENT") }) }), null);
  assert.equal(readPrTitle(12, { env: {}, run: () => ({ status: 0, stdout: " " }) }), null);
});

test("RF_GH_CMD replaces gh", () => {
  const seen = [];
  const run = (cmd, args) => {
    seen.push([cmd, ...args]);
    return { status: 0, stdout: "t" };
  };
  readPrTitle(3, { env: { RF_GH_CMD: JSON.stringify(["node", "fake.mjs"]) }, run });
  assert.deepEqual(seen[0].slice(0, 5), ["node", "fake.mjs", "pr", "view", "3"]);
});
