import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createWebhookDispatcher, routeWebhook, verifyGithubSignature } from "../lib/webhooks.mjs";

const SECRET = "whsec-test";
const body = Buffer.from('{"zen":"hi"}');
const sig = (b, s = SECRET) => `sha256=${createHmac("sha256", s).update(b).digest("hex")}`;

test("verifyGithubSignature: valid, invalid, missing, malformed", () => {
  assert.equal(verifyGithubSignature(body, sig(body), SECRET), true);
  assert.equal(verifyGithubSignature(body.toString(), sig(body), SECRET), true);
  assert.equal(verifyGithubSignature(body, sig(body, "other"), SECRET), false);
  assert.equal(verifyGithubSignature(Buffer.from("{}"), sig(body), SECRET), false);
  assert.equal(verifyGithubSignature(body, undefined, SECRET), false);
  assert.equal(verifyGithubSignature(body, "", SECRET), false);
  assert.equal(verifyGithubSignature(body, "sha1=abc", SECRET), false);
  assert.equal(verifyGithubSignature(body, "sha256=zz", SECRET), false);
  assert.equal(verifyGithubSignature(body, sig(body), ""), false, "no secret never verifies");
  assert.equal(verifyGithubSignature(body, sig(body), undefined), false);
});

const rf = { repository: { name: "routeflow", full_name: "acme/routeflow" } };
const specs = { repository: { name: "routeflow-specs", full_name: "acme/routeflow-specs" } };

test("routeWebhook table", () => {
  for (const ev of ["pull_request", "pull_request_review", "check_suite", "check_run", "status"]) {
    assert.deepEqual(routeWebhook(ev, rf), ["github"], ev);
  }
  assert.deepEqual(routeWebhook("push", { ...specs, ref: "refs/heads/main" }), ["specs"]);
  assert.deepEqual(routeWebhook("push", { ...rf, ref: "refs/heads/master" }), [
    "github",
    "branches",
    "bugs",
    "areas",
  ]);
  assert.deepEqual(routeWebhook("push", { ...rf, ref: "refs/heads/feat/x" }), ["branches"]);
  assert.deepEqual(routeWebhook("deployment_status", rf), ["railway", "github"]);
  assert.deepEqual(routeWebhook("ping", rf), []);
  assert.deepEqual(routeWebhook("issues", rf), []);
  assert.deepEqual(
    routeWebhook("push", { repository: { name: "elsewhere" }, ref: "refs/heads/master" }),
    [],
  );
  assert.deepEqual(routeWebhook("push", null), []);
  assert.deepEqual(routeWebhook(undefined, rf), []);
});

test("dispatcher debounces per source (2 s) and ignores unknown sources", async () => {
  const timers = [];
  const calls = [];
  const d = createWebhookDispatcher({
    runOnce: (n) => {
      calls.push(n);
      return Promise.resolve();
    },
    debounceMs: 2000,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
  });
  d.dispatch(["github", "branches"]);
  d.dispatch(["github", "nope"]);
  assert.equal(timers.length, 2, "one timer per distinct known source");
  assert.ok(timers.every((t) => t.ms === 2000));
  assert.deepEqual(calls, []);
  timers.forEach((t) => t.fn());
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls.sort(), ["branches", "github"]);
  d.dispatch(["github"]);
  assert.equal(timers.length, 3, "a new timer after the previous fired");
});

test("dispatcher swallows runOnce failures", async () => {
  const d = createWebhookDispatcher({
    runOnce: () => Promise.reject(new Error("boom")),
    setTimer: (fn) => (fn(), {}),
  });
  d.dispatch(["github"]);
  await new Promise((r) => setTimeout(r, 10));
});
