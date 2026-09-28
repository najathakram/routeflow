// #2491 (SA-473 (d)) — the proof-stack guard: a local proof may only run against compose images
// built from (a descendant of) the commit it claims to prove.
//
// Twice in one month a proof went red against an image built BEFORE the fix it was proving had
// merged (B690/#1710: the image predated #1199), and nothing recorded which commit the image came
// from. Now:
//   - `local:up` / `local:build` stamp every image with `org.routeflow.sha` (the checkout's HEAD at
//     build time) and `org.routeflow.dirty` ("true" when the tree had uncommitted changes), through
//     `local-env.mjs --build-sha` → ROUTEFLOW_BUILD_SHA / ROUTEFLOW_BUILD_DIRTY → docker-compose.yml
//     `build.labels`;
//   - every stack-backed lane (`local-env.mjs --proof-stack`) reads both images' labels, prints and
//     records them, and asserts `git merge-base --is-ancestor <required> <image sha>` for each. The
//     required commit is PROOF_STACK_REQUIRE (a PR's merge or head commit) or the checkout's HEAD.
//     Anything else, including an unlabelled image, is a "stale image" failure before the lane runs.
//     A dirty-tree image fails too when PROOF_STACK_REQUIRE is set (a PR proof); in the HEAD dev
//     loop it is only a warning.
//
// Pure planning plus an injected `run(cmd, args) → { status, stdout, stderr }`, so the spec drives
// it with fakes and no docker.

export const STACK_IMAGES = ["routeflow-api:local", "routeflow-web:local"];
export const SHA_LABEL = "org.routeflow.sha";
export const DIRTY_LABEL = "org.routeflow.dirty";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The checkout's HEAD sha and whether its tree is dirty, for the build labels. */
export function buildStamp(run) {
  const head = run("git", ["rev-parse", "HEAD"]);
  const sha = head.status === 0 ? head.stdout.trim() : "";
  const status = run("git", ["status", "--porcelain", "--untracked-files=no"]);
  return {
    sha: FULL_SHA.test(sha) ? sha : "unknown",
    dirty: status.status === 0 ? String(status.stdout.trim() !== "") : "unknown",
  };
}

/** One image's labels: { image, sha, dirty } or { image, error } when it cannot be read. */
export function readImage(image, run) {
  const res = run("docker", ["image", "inspect", "--format", "{{json .Config.Labels}}", image]);
  if (res.status !== 0)
    return { image, error: `cannot inspect ${image} (not built? run npm run local:up)` };
  let labels;
  try {
    labels = JSON.parse(res.stdout.trim() || "null") ?? {};
  } catch {
    return { image, error: `unreadable labels on ${image}` };
  }
  return { image, sha: labels[SHA_LABEL] ?? null, dirty: labels[DIRTY_LABEL] ?? null };
}

/** `git merge-base --is-ancestor a b` → true / false / null (git could not answer). */
export function isAncestor(a, b, run) {
  const res = run("git", ["merge-base", "--is-ancestor", a, b]);
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return null;
}

/** The commit a proof must include: PROOF_STACK_REQUIRE, else the checkout's HEAD. */
export function requiredCommit(env, run) {
  const want = String(env.PROOF_STACK_REQUIRE ?? "").trim() || "HEAD";
  const res = run("git", ["rev-parse", "--verify", "--quiet", `${want}^{commit}`]);
  const sha = res.status === 0 ? res.stdout.trim() : "";
  return FULL_SHA.test(sha)
    ? { sha, from: want === "HEAD" ? "HEAD" : "PROOF_STACK_REQUIRE" }
    : { error: `required commit ${want} is not in this clone (git fetch it first)` };
}

/**
 * Judge every stack image against the required commit.
 * @returns {{ ok: boolean, failures: string[], warnings: string[], record: object }}
 */
export function checkProofStack({ required, images, ancestor }) {
  const failures = [];
  const warnings = [];
  if (required.error) failures.push(required.error);
  for (const img of images) {
    if (img.error) {
      failures.push(img.error);
      continue;
    }
    if (!img.sha || !FULL_SHA.test(img.sha)) {
      failures.push(
        `stale image: ${img.image} carries no ${SHA_LABEL} build sha (built outside npm run local:up?) — rebuild with npm run local:up`,
      );
      continue;
    }
    if (img.dirty === "true") {
      // SA-473a: a PR proof (PROOF_STACK_REQUIRE) must run on committed code only; an image built
      // from a dirty tree may hold changes no commit carries. The HEAD dev loop only warns.
      if (required.from === "PROOF_STACK_REQUIRE") {
        failures.push(
          `stale image: ${img.image} was built from a dirty tree at ${img.sha.slice(0, 12)} — a PR proof needs an image built from a clean checkout (commit or discard, then npm run local:up)`,
        );
        continue;
      }
      warnings.push(
        `${img.image} was built from a DIRTY tree at ${img.sha.slice(0, 12)}: it may hold uncommitted changes`,
      );
    }
    if (required.error) continue;
    const verdict = ancestor(required.sha, img.sha);
    if (verdict === null)
      failures.push(
        `stale image: cannot relate ${img.image} (${img.sha.slice(0, 12)}) to ${required.sha.slice(0, 12)} — is its commit in this clone?`,
      );
    else if (!verdict)
      failures.push(
        `stale image: ${img.image} was built from ${img.sha.slice(0, 12)}, which does not contain ` +
          `${required.sha.slice(0, 12)} (${required.from}) — rebuild with npm run local:up`,
      );
  }
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    record: {
      checkedAt: new Date().toISOString(),
      required: required.sha ?? null,
      requiredFrom: required.from ?? null,
      images: images.map((i) => ({
        image: i.image,
        sha: i.sha ?? null,
        dirty: i.dirty ?? null,
        error: i.error ?? null,
      })),
      ok: failures.length === 0,
    },
  };
}

/** The one-line stamp every proof log carries. */
export function stampLine(result) {
  const r = result.record;
  const imgs = r.images
    .map(
      (i) => `${i.image} ${i.sha ? i.sha.slice(0, 12) : "?"}${i.dirty === "true" ? "+dirty" : ""}`,
    )
    .join(" · ");
  return `proof-stack: ${imgs} · required ${r.required ? r.required.slice(0, 12) : "?"} (${r.requiredFrom ?? "?"}) · ${result.ok ? "OK" : "STALE"}`;
}
