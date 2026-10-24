/* Child process for helpers/smart-http.ts: a git smart-HTTP server (via `git http-backend`) on
 * 127.0.0.1. argv: <root dir holding repo.git> <seen-log path> [redirectTo | @localhost].
 * Prints the port on stdout once listening; appends one JSON line per request to the log.
 * It is a separate process because the specs drive git with spawnSync, which blocks the parent's
 * event loop. */
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const [root, logPath, redirect] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      method: req.method,
      url: req.url,
      host: String(req.headers.host || ""),
      authorization: req.headers.authorization,
    }) + "\n",
  );
  if (redirect && u.pathname.endsWith("/info/refs")) {
    const to = redirect === "@localhost" ? `http://localhost:${server.address().port}` : redirect;
    res.writeHead(302, { location: `${to}${u.pathname}${u.search}` });
    res.end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH || "",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method || "GET",
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.replace(/^\?/, ""),
        CONTENT_TYPE: String(req.headers["content-type"] || ""),
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] || ""),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] || ""),
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const out = [];
    child.stdout.on("data", (c) => out.push(c));
    child.on("close", () => {
      const raw = Buffer.concat(out);
      const sep = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, Math.max(sep, 0)).toString("latin1").split("\r\n");
      const headers = {};
      let status = 200;
      for (const line of head) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const k = line.slice(0, i).toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") status = Number(v.split(" ")[0]);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(sep < 0 ? raw : raw.subarray(sep + 4));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(body);
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${server.address().port}\n`);
});
process.on("SIGTERM", () => process.exit(0));
