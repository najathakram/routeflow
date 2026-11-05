"use strict";
// The old Expo mobile-web build is retired. This dependency-free server answers every request
// with a 302 (not 301, so it can be undone without browsers caching it) to the current website.
// Pinned by __tests__/old-site-redirect.test.ts.
const http = require("http");

const DEFAULT_WWW_BASE = "https://www.routeflow.info";
// Paths that exist on www with the same meaning; the query string travels with them.
const KEPT_PATHS = new Set(["/login", "/reset-password"]);

function wwwBase(env) {
  const raw = (env && env.WWW_BASE_URL) || DEFAULT_WWW_BASE;
  return raw.replace(/\/+$/, "");
}

// Returns the absolute redirect target for a request URL (path + optional query).
function redirectTarget(requestUrl, env) {
  const base = wwwBase(env);
  let url;
  try {
    url = new URL(requestUrl || "/", "http://old.invalid");
  } catch {
    return base + "/login";
  }
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (KEPT_PATHS.has(path)) return base + path + url.search;
  return base + "/login";
}

function createServer(env) {
  return http.createServer((req, res) => {
    // Railway healthcheck: must answer 2xx, so it is never redirected.
    if ((req.url || "").split("?")[0] === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("ok");
      return;
    }
    res.writeHead(302, {
      Location: redirectTarget(req.url, env),
      "Cache-Control": "no-store",
      "Content-Length": "0",
    });
    res.end();
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  createServer(process.env).listen(port, "0.0.0.0", () => {
    console.log("old mobile site redirect listening on " + port);
  });
}

module.exports = { redirectTarget, createServer, wwwBase, DEFAULT_WWW_BASE };
