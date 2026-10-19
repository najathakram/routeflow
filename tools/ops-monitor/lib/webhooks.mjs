// GitHub webhook helpers: signature check, event → collector-source routing, and a per-source
// debounce so a burst of events costs one refresh.
import { createHmac, timingSafeEqual } from "node:crypto";

const SOURCES = new Set(["specs", "github", "branches", "bugs", "areas", "railway"]);
const PR_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "check_suite",
  "check_run",
  "status",
]);

/** `sha256=<hex>` HMAC of the raw body, constant-time. Missing secret/header → false. */
export function verifyGithubSignature(rawBody, header, secret) {
  if (typeof secret !== "string" || secret === "") return false;
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const repoName = (payload) => {
  const r = payload?.repository;
  if (typeof r?.name === "string") return r.name;
  if (typeof r?.full_name === "string") return r.full_name.split("/").pop();
  return null;
};

/** Event + payload → collector sources to refresh now (see build-plan-m3 table). */
export function routeWebhook(eventName, payload) {
  const repo = repoName(payload);
  if (eventName === "push") {
    if (repo === "routeflow-specs") return ["specs"];
    if (repo !== "routeflow") return [];
    return payload.ref === "refs/heads/master"
      ? ["github", "branches", "bugs", "areas"]
      : ["branches"];
  }
  if (repo !== null && repo !== "routeflow") return [];
  if (PR_EVENTS.has(eventName)) return ["github"];
  // Deploy status arrives via GitHub deployments (github source) with Railway adding detail.
  if (eventName === "deployment_status") return ["railway", "github"];
  return [];
}

/** dispatch(sources) schedules runOnce(name) after debounceMs; a pending source is not re-queued. */
export function createWebhookDispatcher({
  runOnce,
  debounceMs = 2000,
  setTimer = (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
} = {}) {
  const pending = new Set();
  return {
    dispatch(names) {
      for (const name of names ?? []) {
        if (!SOURCES.has(name) || pending.has(name)) continue;
        pending.add(name);
        setTimer(() => {
          pending.delete(name);
          Promise.resolve()
            .then(() => runOnce(name))
            .catch(() => {});
        }, debounceMs);
      }
    },
  };
}
