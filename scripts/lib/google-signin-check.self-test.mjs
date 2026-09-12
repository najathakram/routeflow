#!/usr/bin/env node
/**
 * Self-test for scripts/lib/google-signin-check.mjs (dev-pipeline TP1,
 * .claude/pipeline/2026-09-11-google-signin-monitor).
 *
 * Fakes the network entirely: two `node:http` servers on 127.0.0.1 — fakeApi
 * (stands in for the RouteFlow API's two OAuth "doors") and fakeGoogle (stands
 * in for Google's consent/error pages) — plus an injected `lookupImpl` for the
 * apex-DNS check. Nothing here ever reaches the real network.
 *
 * T1–T6 (R1–R5, R10): behavioral, against the fakes.
 * T7–T8 (R6 R7): structural — read the source files the build plan says must
 * change/exist and assert the exact strings, never merely "not empty".
 *
 * Run directly: `node scripts/lib/google-signin-check.self-test.mjs`
 * Exits 0 when every check passes, 1 otherwise (wired into `npm run verify` by WP2).
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  checkGoogleSignIn,
  checkApexDns,
  decodeAuthError,
  resolveRequired,
  resolveApexRequired,
} from "./google-signin-check.mjs";

/**
 * Google's real error page names its cause ONLY in the base64url `authError` query
 * parameter (a protobuf-ish blob: field 1 = the error name). Verified against production
 * 2026-09-11: the document itself is ~773 KB and the literal marker sits far beyond the
 * module's 64 KB body cap, so a body-only classifier reports oauth_error instead of the
 * real reason. PROD_AUTH_ERROR_DELETED_CLIENT is that production value verbatim (it
 * carries no secret - just the error name and Google's own message).
 */
const PROD_AUTH_ERROR_DELETED_CLIENT =
  "Cg5kZWxldGVkX2NsaWVudBIdVGhlIE9BdXRoIGNsaWVudCB3YXMgZGVsZXRlZC4gkQM";

/** Encodes a marker the way Google does: field-1 tag + length, then the error name. */
const encodeAuthError = (marker) =>
  Buffer.from(String.fromCharCode(10, marker.length) + marker).toString("base64url");

/** A >70 KB error document that never contains any ERROR_MARKER literal. */
const BIG_MARKERLESS_BODY = "<html><body>" + "x".repeat(72 * 1024) + "</body></html>";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};

// ── fake server helpers ─────────────────────────────────────────────────────

/**
 * Starts an http server on 127.0.0.1 with an ephemeral port. `handler(req, res)`
 * gets called per request; every request's method+url is pushed to `.requests`
 * before the handler runs, so a case can assert exact call counts/paths.
 */
const startFake = (handler) =>
  new Promise((resolve) => {
    const requests = [];
    const sockets = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      handler(req, res);
    });
    server.on("connection", (socket) => sockets.push(socket));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      });
    });
  });

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const html = (res, status, body) => {
  res.writeHead(status, { "content-type": "text/html" });
  res.end(body);
};

// ── T1 (R1 R2 R10): both doors succeed, exact request counts + tenant URL ──

const runT1 = async () => {
  const google = await startFake((req, res) => {
    // D2: "ok" needs a POSITIVE signal - a known sign-in pathname or chooser text. This
    // fake serves both (a /o/oauth2/ path AND the chooser string).
    if (req.url.startsWith("/o/oauth2/v2/auth")) return html(res, 200, "Choose an account");
    html(res, 404, "not found");
  });

  const api = await startFake((req, res) => {
    if (req.url === "/api/v1/platform-admin/auth/google") {
      return json(res, 200, { url: `${google.url}/o/oauth2/v2/auth?door=platform-admin` });
    }
    if (req.url.startsWith("/api/v1/auth/google")) {
      return json(res, 200, {
        url: `${google.url}/o/oauth2/v2/auth?door=tenant&tenant=e2e-routeflow`,
      });
    }
    json(res, 404, { message: "not found" });
  });

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
    });

    check("T1/R1/R10: ok === true", result?.ok, true);
    check("T1/R1: two doors probed", result?.doors?.length, 2);
    check(
      "T1/R2: both doors report status ok",
      result?.doors?.map((d) => d.status),
      ["ok", "ok"],
    );
    check(
      "T1/R2: both finalUrl start with fakeGoogle's origin",
      result?.doors?.every(
        (d) => typeof d.finalUrl === "string" && d.finalUrl.startsWith(google.url),
      ),
      true,
    );
    // D4: callers may log only finalPage (origin + pathname) - the query string carries
    // the OAuth client id and state, which must never reach a CI log.
    check(
      "T1/D4: every door carries a finalPage with no query string",
      result?.doors?.every(
        (d) =>
          typeof d.finalPage === "string" && d.finalPage.length > 0 && !d.finalPage.includes("?"),
      ),
      true,
    );
    check("T1/R10: fakeApi saw exactly 2 requests", api.requests.length, 2);
    check(
      "T1/R1: tenant door request carries tenant=e2e-routeflow",
      api.requests.some((r) => r.url.includes("tenant=e2e-routeflow")),
      true,
    );
    check("T1/R2: fakeGoogle saw exactly 2 requests", google.requests.length, 2);
  } finally {
    await api.close();
    await google.close();
  }
};

// ── T2 (R2): Google's own error page — 4 marker variants ───────────────────

const runT2Case = async (label, errorBody, expectedReason) => {
  const google = await startFake((req, res) => {
    if (req.url.startsWith("/consent")) {
      res.writeHead(302, { location: "/signin/oauth/error?authError=x&client_id=x" });
      return res.end();
    }
    if (req.url.startsWith("/signin/oauth/error")) return html(res, 200, errorBody);
    html(res, 404, "not found");
  });

  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/consent?door=probe` }),
  );

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
    });

    check(`T2/R2 ${label}: ok === false`, result?.ok, false);
    const platform = result?.doors?.find((d) => d.name === "platform-admin");
    check(`T2/R2 ${label}: platform door reason`, platform?.reason, expectedReason);
    // Both doors go through the same consent probe — assert the tenant door's reason too,
    // so a per-door discrimination bug cannot hide behind the platform door alone.
    check(
      `T2/R2 ${label}: tenant door reason`,
      result?.doors?.find((d) => d.name === "tenant")?.reason,
      expectedReason,
    );
    check(
      `T2/R2 ${label}: finalUrl contains /signin/oauth/error`,
      platform?.finalUrl?.includes("/signin/oauth/error"),
      true,
    );
  } finally {
    await api.close();
    await google.close();
  }
};

/**
 * A 200 consent page (no /signin/oauth/error redirect) whose BODY carries a marker —
 * proves the body-marker check independently of the pathname check.
 */
const runT2BodyMarkerCase = async (label, body, expectedReason) => {
  const google = await startFake((req, res) => html(res, 200, body));
  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/consent?door=probe` }),
  );

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
    });

    check(`T2/R2 body marker ${label}: ok === false`, result?.ok, false);
    check(
      `T2/R2 body marker ${label}: both doors report ${expectedReason}`,
      result?.doors?.map((d) => d.reason),
      [expectedReason, expectedReason],
    );
  } finally {
    await api.close();
    await google.close();
  }
};

/** A door (API) failure rather than a Google failure: exercises door_http_* and network. */
const runT2DoorCase = async (label, apiHandler, expectedReason, timeoutMs) => {
  const api = await startFake(apiHandler);

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
      timeoutMs,
    });

    check(`T2/R2 ${label}: ok === false`, result?.ok, false);
    check(
      `T2/R2 ${label}: both doors report ${expectedReason}`,
      result?.doors?.map((d) => d.reason),
      [expectedReason, expectedReason],
    );
  } finally {
    await api.close();
  }
};

/**
 * D1 (the real-world case): Google 302s the consent URL to /signin/oauth/error whose
 * `authError` parameter is a base64url blob naming the cause, and serves a >70 KB document
 * that does NOT contain the literal marker. Only a URL-first classifier can name the
 * reason here; a body-only one reports oauth_error.
 */
const runT2UrlMarkerCase = async (label, authError, expectedReason) => {
  const google = await startFake((req, res) => {
    if (req.url.startsWith("/o/oauth2/")) {
      res.writeHead(302, {
        location: `/signin/oauth/error?authError=${authError}&flowName=GeneralOAuthLite&client_id=x`,
      });
      return res.end();
    }
    if (req.url.startsWith("/signin/oauth/error")) return html(res, 200, BIG_MARKERLESS_BODY);
    html(res, 404, "not found");
  });

  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/o/oauth2/v2/auth?door=probe` }),
  );

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
    });

    check(`T2/D1 ${label}: ok === false`, result?.ok, false);
    check(
      `T2/D1 ${label}: both doors report ${expectedReason} from the URL alone`,
      result?.doors?.map((d) => d.reason),
      [expectedReason, expectedReason],
    );
    check(
      `T2/D1 ${label}: body really does NOT carry the literal`,
      BIG_MARKERLESS_BODY.includes(expectedReason),
      false,
    );
    check(
      `T2/D1 ${label}: logged finalPage carries no query string`,
      result?.doors?.every((d) => !d.finalPage.includes("?")),
      true,
    );
  } finally {
    await api.close();
    await google.close();
  }
};

const runT2 = async () => {
  // D1: the production shape - decoded authError, marker-free (within the cap) body.
  await runT2UrlMarkerCase("prod authError blob", PROD_AUTH_ERROR_DELETED_CLIENT, "deleted_client");
  await runT2UrlMarkerCase(
    "encoded invalid_client",
    encodeAuthError("invalid_client"),
    "invalid_client",
  );
  await runT2UrlMarkerCase(
    "encoded redirect_uri_mismatch",
    encodeAuthError("redirect_uri_mismatch"),
    "redirect_uri_mismatch",
  );
  // A plain (unencoded) error=... parameter, the other shape Google uses.
  await runT2UrlMarkerCase("plain error param", "access_denied", "access_denied");

  check(
    "T2/D1: decodeAuthError names the marker in the prod blob",
    decodeAuthError(
      `https://accounts.google.com/signin/oauth/error?authError=${PROD_AUTH_ERROR_DELETED_CLIENT}`,
    ).includes("deleted_client"),
    true,
  );
  check("T2/D1: decodeAuthError returns empty for an unparseable URL", decodeAuthError("nope"), "");
  check(
    "T2/D1: decodeAuthError returns empty when no error parameter is present",
    decodeAuthError("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"),
    "",
  );

  await runT2Case("deleted_client", "…deleted_client…", "deleted_client");
  await runT2Case("invalid_client", "…invalid_client…", "invalid_client");
  await runT2Case("redirect_uri_mismatch", "…redirect_uri_mismatch…", "redirect_uri_mismatch");
  await runT2Case("no marker", "generic Google error page, no known marker", "oauth_error");

  // "Access blocked" is an ERROR_MARKER with no reason name of its own in R2's enum,
  // so it lands on the catch-all oauth_error.
  await runT2BodyMarkerCase("Access blocked", "Access blocked: authorisation error", "oauth_error");

  // Door-side failures (R2's door_http_<status> / network reasons).
  await runT2DoorCase(
    "door 500",
    (req, res) => json(res, 500, { message: "boom" }),
    "door_http_500",
  );
  await runT2DoorCase("door 200 without url", (req, res) => json(res, 200, {}), "door_http_200");

  // door_http_<status> means "the API answered with a COMPLETE but unusable response".
  // A 2xx whose body never finishes is a timeout — the two reasons send the on-call down
  // different triage branches, so they must not collapse into one.
  await runT2DoorCase(
    "door body hangs after 200 headers",
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
      res.write('{"ur');
    },
    "timeout",
    400,
  );
  await runT2DoorCase(
    "door 200 with complete malformed JSON",
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not-json");
    },
    "door_http_200",
  );

  // A consent URL whose port is closed: the consent fetch rejects at the transport layer.
  const dead = await startFake((req, res) => html(res, 200, "never reached"));
  const deadUrl = dead.url;
  await dead.close();
  await runT2DoorCase(
    "unreachable consent host",
    (req, res) => json(res, 200, { url: `${deadUrl}/consent?door=probe` }),
    "network",
  );
};

// ── T3 (R3): not_configured — required vs skipped, plus resolveRequired ────

const runT3 = async () => {
  const google = await startFake((req, res) => html(res, 200, "Choose an account"));
  const api = await startFake((req, res) => {
    if (req.url === "/api/v1/platform-admin/auth/google") {
      return json(res, 200, { url: `${google.url}/consent` });
    }
    if (req.url.startsWith("/api/v1/auth/google")) {
      return json(res, 503, { message: "Google OAuth is not configured" });
    }
    json(res, 404, { message: "not found" });
  });

  try {
    const required = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
      required: true,
    });
    check("T3/R3: required=true -> ok === false", required?.ok, false);
    check(
      "T3/R3: tenant door reason === not_configured (required)",
      required?.doors?.find((d) => d.name === "tenant")?.reason,
      "not_configured",
    );
    check(
      "T3/R3: platform door still probed and ok (required)",
      required?.doors?.find((d) => d.name === "platform-admin")?.status,
      "ok",
    );

    const skipped = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
      required: false,
    });
    check("T3/R3: required=false -> ok === true", skipped?.ok, true);
    check(
      "T3/R3: tenant door status === skipped (not required)",
      skipped?.doors?.find((d) => d.name === "tenant")?.status,
      "skipped",
    );
  } finally {
    await api.close();
    await google.close();
  }

  check(
    "T3/R3: resolveRequired defaults false for localhost",
    resolveRequired("http://localhost:3000", undefined),
    false,
  );
  check(
    "T3/R3: resolveRequired defaults true for a non-local host",
    resolveRequired("https://x.up.railway.app", undefined),
    true,
  );
  check(
    "T3/R3: SMOKE_GOOGLE_REQUIRED=1 overrides localhost to required",
    resolveRequired("http://localhost:3000", "1"),
    true,
  );
  check(
    "T3/R3: SMOKE_GOOGLE_REQUIRED=0 silences a non-local host",
    resolveRequired("https://x.up.railway.app", "0"),
    false,
  );
  check("T3/R3: resolveApexRequired('0') === false", resolveApexRequired("0"), false);
};

// ── T4 (R2): host mismatch -> wrong_host for both doors ────────────────────

const runT4 = async () => {
  const google = await startFake((req, res) => html(res, 200, "Choose an account"));
  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/consent?door=probe` }),
  );

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "accounts.google.com",
    });

    check("T4/R2: ok === false on host mismatch", result?.ok, false);
    check(
      "T4/R2: both doors report wrong_host",
      result?.doors?.map((d) => d.reason),
      ["wrong_host", "wrong_host"],
    );
    check(
      "T4/R2: finalUrl is recorded on the mismatched doors",
      result?.doors?.every(
        (d) => typeof d.finalUrl === "string" && d.finalUrl.startsWith(google.url),
      ),
      true,
    );
  } finally {
    await api.close();
    await google.close();
  }
};

// ── T4b (D2): a 200 page with no positive signal -> unexpected_page ────────

const runT4b = async () => {
  const google = await startFake((req, res) => html(res, 200, "Something went wrong"));
  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/some/interstitial` }),
  );

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
    });

    check(
      "T4b/D2: ok === false when nothing positively identifies a sign-in page",
      result?.ok,
      false,
    );
    check(
      "T4b/D2: both doors report unexpected_page",
      result?.doors?.map((d) => d.reason),
      ["unexpected_page", "unexpected_page"],
    );
  } finally {
    await api.close();
    await google.close();
  }
};

// ── T5 (R4): a hanging consent page must still time out and resolve ────────

const runT5 = async () => {
  // Deliberately never responds to /consent — holds the socket open.
  const google = await startFake(() => {});
  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/consent?door=probe` }),
  );

  try {
    const started = Date.now();
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
      timeoutMs: 400,
    });
    const elapsedMs = Date.now() - started;

    // Bounded on BOTH sides: a fail-fast implementation that never honours timeoutMs
    // (or a stub returning instantly) fails the lower bound; a missing shared
    // AbortController budget (R4) fails the upper one. The ceiling is deliberately
    // generous (5s against a 400ms budget) — L-066: a tight wall-clock bound is green on
    // CI and red on a loaded host, where bare node work has measured seconds.
    check(
      "T5/R4: waits out its own 400ms budget, then resolves under 5000ms",
      elapsedMs >= 300 && elapsedMs < 5000,
      true,
    );
    check("T5/R4: ok === false", result?.ok, false);
    check(
      "T5/R4: at least one door times out",
      result?.doors?.some((d) => d.reason === "timeout"),
      true,
    );
  } finally {
    // L-066/L-077: never leave a hanging socket/handle behind a fake test server.
    await api.close();
    await google.close();
  }
};

/**
 * Mid-BODY consent failure (the real consent page is a streamed document): fakeGoogle
 * writes 200 headers plus one partial chunk, then either holds the stream open until the
 * shared abort fires, or destroys the socket. checkGoogleSignIn must still RESOLVE (never
 * reject), keep the door's finalUrl, and keep BOTH doors' results — one door throwing out
 * of Promise.all would discard the other door's diagnostics entirely.
 */
const runT5MidBodyCase = async (label, { destroySocket }, timeoutMs, expectedReason) => {
  const google = await startFake((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" });
    res.write("<html>partial consent page");
    if (destroySocket) setTimeout(() => res.socket?.destroy(), 50);
  });
  const api = await startFake((req, res) =>
    json(res, 200, { url: `${google.url}/consent?door=probe` }),
  );

  try {
    const result = await checkGoogleSignIn({
      baseUrl: api.url,
      tenant: "e2e-routeflow",
      fetchImpl: fetch,
      expectedHost: "127.0.0.1",
      timeoutMs,
    }).catch((err) => ({ rejected: `${err?.name}: ${err?.message}` }));

    check(`T5/R4 ${label}: never rejects`, result?.rejected ?? null, null);
    check(`T5/R4 ${label}: ok === false`, result?.ok, false);
    check(`T5/R4 ${label}: both doors still reported`, result?.doors?.length, 2);
    check(
      `T5/R4 ${label}: both doors report ${expectedReason}`,
      result?.doors?.map((d) => d.reason),
      [expectedReason, expectedReason],
    );
    check(
      `T5/R4 ${label}: finalUrl kept on the failed doors`,
      result?.doors?.every(
        (d) => typeof d.finalUrl === "string" && d.finalUrl.startsWith(google.url),
      ),
      true,
    );
  } finally {
    await api.close();
    await google.close();
  }
};

const runT5MidBody = async () => {
  await runT5MidBodyCase(
    "consent body hangs after headers",
    { destroySocket: false },
    400,
    "timeout",
  );
  await runT5MidBodyCase(
    "consent socket destroyed mid-body",
    { destroySocket: true },
    5000,
    "network",
  );
};

// ── T6 (R5): apex DNS via injected lookupImpl ───────────────────────────────

const runT6 = async () => {
  const notFound = () => Promise.reject({ code: "ENOTFOUND" });
  const found = () => Promise.resolve({ address: "1.2.3.4" });

  const warn = await checkApexDns({
    hostname: "routeflow.info",
    lookupImpl: notFound,
    required: false,
  });
  check("T6/R5: ENOTFOUND + not required -> ok true", warn?.ok, true);
  check("T6/R5: ENOTFOUND + not required -> status warn", warn?.status, "warn");
  check("T6/R5: ENOTFOUND + not required -> reason ENOTFOUND", warn?.reason, "ENOTFOUND");

  const fail = await checkApexDns({
    hostname: "routeflow.info",
    lookupImpl: notFound,
    required: true,
  });
  check("T6/R5: ENOTFOUND + required -> ok false", fail?.ok, false);

  const ok = await checkApexDns({
    hostname: "routeflow.info",
    lookupImpl: found,
    required: false,
  });
  check("T6/R5: resolving lookup -> ok true", ok?.ok, true);
  check("T6/R5: resolving lookup -> status ok", ok?.status, "ok");
  check("T6/R5: resolving lookup -> address recorded", ok?.address, "1.2.3.4");

  check("T6/R5: resolveApexRequired(undefined) === false", resolveApexRequired(undefined), false);
  check("T6/R5: resolveApexRequired('1') === true", resolveApexRequired("1"), true);
};

// ── T7 (R6): post-deploy-check.mjs and smoke.mjs source, structural ────────

const runT7 = () => {
  const postDeployPath = join(REPO_ROOT, "scripts/post-deploy-check.mjs");
  const smokePath = join(REPO_ROOT, "scripts/smoke.mjs");

  const postDeploy = existsSync(postDeployPath) ? readFileSync(postDeployPath, "utf8") : null;
  const smoke = existsSync(smokePath) ? readFileSync(smokePath, "utf8") : null;

  // One clause per check, never a compound boolean: a compound assertion cannot say which
  // clause broke. The "no hard-coded accounts.google.com" clause was already true before
  // this change (the host lives in the module), so it is a standing guard rather than a
  // red-gate oracle — and an implementation that legitimately passes expectedHost
  // explicitly now fails only that one check, with its own name.
  check(
    "T7/R6: post-deploy-check.mjs imports lib/google-signin-check.mjs",
    postDeploy !== null && postDeploy.includes("lib/google-signin-check.mjs"),
    true,
  );
  check(
    "T7/R6: post-deploy-check.mjs hard-codes no accounts.google.com",
    postDeploy !== null && !postDeploy.includes("accounts.google.com"),
    true,
  );
  check(
    "T7/R6: post-deploy-check.mjs has section '2. Google sign-in doors'",
    postDeploy?.includes("2. Google sign-in doors"),
    true,
  );
  check(
    "T7/R6: post-deploy-check.mjs has section '3. Apex DNS'",
    postDeploy?.includes("3. Apex DNS"),
    true,
  );
  // D3: both unauthenticated sections must run BEFORE the login gate, which process.exit(1)s
  // on a missing token - otherwise a broken test-tenant password hides a dead Google door.
  check(
    "T7/D3: 'Google sign-in doors' appears before the auth-token abort",
    (postDeploy?.indexOf("Google sign-in doors") ?? -1) > 0 &&
      postDeploy.indexOf("Google sign-in doors") <
        postDeploy.indexOf("Cannot continue without auth token"),
    true,
  );
  check(
    "T7/D3: 'Apex DNS' appears before the auth-token abort",
    (postDeploy?.indexOf("Apex DNS") ?? -1) > 0 &&
      postDeploy.indexOf("Apex DNS") < postDeploy.indexOf("Cannot continue without auth token"),
    true,
  );
  // D4: no entry point may log a full consent URL (it carries the client id + OAuth state).
  check(
    "T7/D4: post-deploy-check.mjs logs finalPage, never finalUrl",
    postDeploy !== null &&
      postDeploy.includes("door.finalPage") &&
      !postDeploy.includes("door.finalUrl"),
    true,
  );
  check(
    "T7/D4: smoke.mjs logs finalPage, never finalUrl",
    smoke !== null && smoke.includes("door.finalPage") && !smoke.includes("door.finalUrl"),
    true,
  );
  check(
    "T7/R6: smoke.mjs imports lib/google-signin-check.mjs",
    smoke !== null && smoke.includes("lib/google-signin-check.mjs"),
    true,
  );
  check(
    "T7/R6: smoke.mjs hard-codes no accounts.google.com",
    smoke !== null && !smoke.includes("accounts.google.com"),
    true,
  );
  check("T7/R6: smoke.mjs has a 'google-signin:' line", smoke?.includes("google-signin:"), true);
  // Separate pin (not folded into the import assertion): smoke.mjs became tenant-scoped
  // with the Google door, so it must guard SMOKE_TENANT_SLUG like its sibling entry points.
  check(
    "T7/R6: smoke.mjs guards SMOKE_TENANT_SLUG with assertTestTenant",
    smoke?.includes("assertTestTenant"),
    true,
  );
};

// ── T8 (R7): monitor workflow + script + package.json wiring, structural ──

const runT8 = () => {
  const workflowPath = join(REPO_ROOT, ".github/workflows/google-signin-monitor.yml");
  const monitorPath = join(REPO_ROOT, "scripts/google-signin-monitor.mjs");
  const pkgPath = join(REPO_ROOT, "package.json");

  // Read with a null fallback instead of guarding the assertions behind existsSync:
  // a missing file must make every content oracle FAIL, never silently skip.
  const monitor = existsSync(monitorPath) ? readFileSync(monitorPath, "utf8") : null;
  const workflow = existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : null;

  check("T8/R7: google-signin-monitor.mjs exists", existsSync(monitorPath), true);
  check(
    "T8/R7: monitor script calls assertTestTenant",
    monitor?.includes("assertTestTenant") ?? false,
    true,
  );
  check(
    "T8/R7: monitor script exits 1 on failure",
    monitor?.includes("process.exit(1)") ?? false,
    true,
  );

  check(
    "T8/D4: monitor logs finalPage, never finalUrl",
    (monitor?.includes("door.finalPage") && !monitor?.includes("door.finalUrl")) ?? false,
    true,
  );

  check("T8/R7: google-signin-monitor.yml exists", existsSync(workflowPath), true);
  check(
    "T8/D5: workflow relies on the runner's bundled Node (no setup-node step)",
    workflow !== null && !workflow.includes("actions/setup-node"),
    true,
  );
  check(
    "T8/R7: workflow declares a schedule trigger",
    workflow?.includes("schedule:") ?? false,
    true,
  );
  check(
    "T8/R7: workflow pins the plan's cron 17 */6 * * *",
    workflow?.includes("17 */6 * * *") ?? false,
    true,
  );
  check(
    "T8/R7: workflow declares workflow_dispatch",
    workflow?.includes("workflow_dispatch:") ?? false,
    true,
  );
  check(
    "T8/R7: workflow serializes runs in one concurrency group",
    (workflow?.includes("concurrency:") && workflow?.includes("group: google-signin-monitor")) ??
      false,
    true,
  );
  check(
    "T8/R7: workflow runs scripts/google-signin-monitor.mjs",
    workflow?.includes("node scripts/google-signin-monitor.mjs") ?? false,
    true,
  );

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  check(
    "T8/R7: package.json has a smoke:google script",
    typeof pkg.scripts?.["smoke:google"] === "string",
    true,
  );
  check(
    "T8/R7: verify chain runs the google-signin-check self-test",
    pkg.scripts?.verify?.includes("google-signin-check.self-test") ?? false,
    true,
  );
};

// ── run everything ───────────────────────────────────────────────────────

const main = async () => {
  await runT1();
  await runT2();
  await runT3();
  await runT4();
  await runT4b();
  await runT5();
  await runT5MidBody();
  await runT6();
  runT7();
  runT8();

  console.log(
    failures
      ? `\ngoogle-signin-check.self-test: ${failures} FAILURE(S)`
      : "\ngoogle-signin-check.self-test: all checks passed",
  );
  if (failures) process.exit(1);
};

main();
