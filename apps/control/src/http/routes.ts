/**
 * Request plumbing: exact-match routing on the raw pathname (no decoding, no parameters, no
 * regex), a fixed asset allow-list, a capped body reader, and the JSON / text senders. Nothing
 * from a request ever becomes a filesystem path or a git argument.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface Target {
  /** The raw path, untouched (`//x`, `%2e%2e` and `%00` stay as sent, so they match nothing). */
  pathname: string;
  query: URLSearchParams;
}

/** Origin-form targets only; anything else (absolute-form, `*`, no leading slash) is refused. */
export function parseTarget(rawUrl: string | undefined): Target | null {
  const raw = rawUrl ?? "";
  if (raw.length === 0 || raw.length > 2048 || !raw.startsWith("/")) return null;
  const q = raw.indexOf("?");
  const pathname = q < 0 ? raw : raw.slice(0, q);
  const hash = pathname.indexOf("#");
  return {
    pathname: hash < 0 ? pathname : pathname.slice(0, hash),
    query: new URLSearchParams(q < 0 ? "" : raw.slice(q + 1)),
  };
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  target: Target,
) => void | Promise<void>;
export type RouteTable = Record<string, Record<string, Handler>>;

export const newTable = (): RouteTable => Object.create(null) as RouteTable;

export function route(table: RouteTable, method: string, pathname: string, h: Handler): void {
  (table[pathname] ??= Object.create(null) as Record<string, Handler>)[method] = h;
}

export type Match =
  { kind: "ok"; handler: Handler } | { kind: "notFound" } | { kind: "method"; allow: string };

export function match(table: RouteTable, method: string, pathname: string): Match {
  if (!Object.hasOwn(table, pathname)) return { kind: "notFound" };
  const byMethod = table[pathname];
  if (Object.hasOwn(byMethod, method)) return { kind: "ok", handler: byMethod[method] };
  return { kind: "method", allow: Object.keys(byMethod).sort().join(", ") };
}

/* ------------------------------------------------------------------ assets */
export const ASSET_PATHS: Record<string, { file: string; type: string }> = Object.assign(
  Object.create(null) as Record<string, { file: string; type: string }>,
  {
    "/assets/client.js": { file: "client.js", type: "text/javascript; charset=utf-8" },
    "/assets/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  },
);

/** The directory holding the two allow-listed files: `dist/render/assets` or `src/render/assets`. */
function assetDir(): string | null {
  for (const rel of [
    path.join("..", "render", "assets"),
    path.join("..", "..", "src", "render", "assets"),
  ]) {
    const dir = path.join(__dirname, rel);
    if (fs.existsSync(path.join(dir, "client.js"))) return dir;
  }
  return null;
}

/** Read each allow-listed asset once; the file names come from the table, never from the URL. */
export function loadAssets(): Record<string, { body: Buffer; type: string }> {
  const out: Record<string, { body: Buffer; type: string }> = Object.create(null) as Record<
    string,
    { body: Buffer; type: string }
  >;
  const dir = assetDir();
  if (dir === null) return out;
  for (const [url, a] of Object.entries(ASSET_PATHS)) {
    try {
      out[url] = { body: fs.readFileSync(path.join(dir, a.file)), type: a.type };
    } catch {
      /* missing asset: that URL 404s */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ body + senders */
export type Body = { ok: true; buf: Buffer } | { ok: false };

/**
 * Read at most `limit` bytes. Past the limit the rest is drained (and discarded, up to a hard
 * ceiling) so the 413 reaches the client intact, then `{ok:false}` is returned.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    let done = false;
    const finish = (b: Body): void => {
      if (done) return;
      done = true;
      resolve(b);
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) over = true;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      if (!over) chunks.push(c);
      if (size > limit * 64 + 1_048_576) {
        finish({ ok: false });
        req.destroy();
      }
    });
    req.on("end", () => finish(over ? { ok: false } : { ok: true, buf: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false }));
    req.on("close", () => finish({ ok: false })); // closed before `end`: an aborted upload
  });
}

export function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  extra: Record<string, string | string[]> = {},
): void {
  if (res.headersSent) return;
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { "Content-Type": type, "Content-Length": buf.length, ...extra });
  res.end(buf);
}

export const sendJson = (
  res: ServerResponse,
  status: number,
  obj: unknown,
  extra: Record<string, string | string[]> = {},
): void => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);

export const redirect = (
  res: ServerResponse,
  to: string,
  extra: Record<string, string | string[]> = {},
  status = 302,
): void => {
  if (res.headersSent) return;
  res.writeHead(status, { Location: to, "Content-Length": 0, ...extra });
  res.end();
};

/**
 * Stream a body into `sink` chunk by chunk, keeping nothing. Past `limit` the rest is dropped
 * unhashed. Resolves `{ok:false}` when over the limit or aborted.
 */
export function streamBody(
  req: IncomingMessage,
  limit: number,
  sink: (chunk: Buffer) => void,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      resolve({ ok });
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) over = true;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) over = true;
      if (!over) sink(c);
      if (size > limit * 64 + 1_048_576) {
        finish(false);
        req.destroy();
      }
    });
    req.on("end", () => finish(!over));
    req.on("error", () => finish(false));
    req.on("close", () => finish(false));
  });
}
