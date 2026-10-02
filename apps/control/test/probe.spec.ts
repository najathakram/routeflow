/**
 * Server-token PR, write probe: GET info/refs?service=git-receive-pack against a fake HTTP server on
 * 127.0.0.1 only. 200 = write, 401/403/404 = none, everything else (and every failure) = unknown.
 */
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";

/* eslint-disable @typescript-eslint/no-explicit-any */
const P = (): any => require("../src/sources/probe");

const TOKEN = "tok-FAKE-0123456789-abcdef";
const BASIC = "Basic " + Buffer.from("x-access-token:" + TOKEN).toString("base64");

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
}
let server: http.Server | undefined;
let seen: Seen[] = [];

async function fake(handler: (res: http.ServerResponse) => void): Promise<string> {
  seen = [];
  server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    handler(res);
  });
  await new Promise<void>((ok) => server?.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}
const status =
  (code: number, headers: Record<string, string> = {}) =>
  (res: http.ServerResponse) => {
    res.writeHead(code, headers);
    res.end(code === 200 ? "001e# service=git-receive-pack\n0000" : "no");
  };

afterEach(async () => {
  await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  server = undefined;
});

describe("probeWriteAccess result mapping", () => {
  it.each([[200, "write"]])("HTTP %i -> %s", async (code, want) => {
    const base = await fake(status(code));
    expect(await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base })).toBe(want);
  });
  it.each([401, 403, 404])("HTTP %i -> none", async (code) => {
    const base = await fake(status(code));
    expect(await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base })).toBe("none");
  });
  it.each([201, 204, 400, 429, 500, 502, 503])("HTTP %i -> unknown", async (code) => {
    const base = await fake(status(code));
    expect(await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base })).toBe("unknown");
  });
  it.each([301, 302, 307, 308])("a %i redirect is not followed and is unknown", async (code) => {
    const base = await fake(status(code, { location: "http://127.0.0.1:1/elsewhere" }));
    expect(await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base })).toBe("unknown");
    expect(seen).toHaveLength(1);
  });
  it("a hanging server times out into unknown (and does not hang the caller)", async () => {
    const base = await fake(() => undefined);
    const t0 = Date.now();
    const r = await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base, timeoutMs: 150 });
    expect(r).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("a refused connection is unknown", async () => {
    const free = await new Promise<number>((ok) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => ok(p));
      });
    });
    const r = await P().probeWriteAccess({
      token: TOKEN,
      repo: "acme/acme",
      base: `http://127.0.0.1:${free}`,
    });
    expect(r).toBe("unknown");
  });
  it("a throwing fetch is unknown (fail closed)", async () => {
    const fetchImpl = () => {
      throw new Error("boom " + TOKEN);
    };
    const r = await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", fetchImpl });
    expect(r).toBe("unknown");
  });
  it("a rejecting fetch is unknown", async () => {
    const fetchImpl = () => Promise.reject(new Error("nope"));
    expect(await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", fetchImpl })).toBe(
      "unknown",
    );
  });
  it("a malformed repo is unknown and nothing is requested", async () => {
    const base = await fake(status(200));
    for (const repo of ["", "acme", "a/b/c", "../x/y", "acme/a?x=1", "acme/a b"]) {
      expect(await P().probeWriteAccess({ token: TOKEN, repo, base })).toBe("unknown");
    }
    expect(seen).toEqual([]);
  });
});

describe("probeWriteAccess request shape", () => {
  it("is exactly one GET with the Basic header, the .git/info/refs path and the receive-pack query", async () => {
    const base = await fake(status(403));
    await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme-control-state", base });
    expect(seen).toEqual([
      {
        method: "GET",
        url: "/acme/acme-control-state.git/info/refs?service=git-receive-pack",
        auth: BASIC,
      },
    ]);
  });
  it("a trailing slash on the base does not double the slash", async () => {
    const base = await fake(status(403));
    await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base: base + "/" });
    expect(seen[0].url).toBe("/acme/acme.git/info/refs?service=git-receive-pack");
  });
  it("the token is not in the URL", async () => {
    const base = await fake(status(403));
    await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", base });
    expect(seen[0].url).not.toContain(TOKEN);
  });
  it("uses redirect: manual and an abort signal on the fetch call", async () => {
    let init: any;
    const fetchImpl = async (_u: string, i: any) => {
      init = i;
      return new Response("", { status: 403 });
    };
    await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", fetchImpl });
    expect(init.redirect).toBe("manual");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal).toBeDefined();
    expect(init.body).toBeUndefined();
  });
  it("defaults to https://github.com as the base", async () => {
    let url = "";
    const fetchImpl = async (u: string) => {
      url = String(u);
      return new Response("", { status: 403 });
    };
    await P().probeWriteAccess({ token: TOKEN, repo: "acme/acme", fetchImpl });
    expect(url).toBe("https://github.com/acme/acme.git/info/refs?service=git-receive-pack");
  });
});

describe("probeWriteAccess never leaks the token", () => {
  it("not in any result of the detailed probe, for every outcome", async () => {
    const outcomes: any[] = [];
    for (const code of [200, 403, 500, 302]) {
      const base = await fake(status(code, code === 302 ? { location: "/x" } : {}));
      outcomes.push(await P().probeWriteAccessDetailed({ token: TOKEN, repo: "acme/acme", base }));
      await new Promise<void>((ok) => server?.close(() => ok()));
      server = undefined;
    }
    outcomes.push(
      await P().probeWriteAccessDetailed({
        token: TOKEN,
        repo: "acme/acme",
        fetchImpl: () => Promise.reject(new Error("failed with " + TOKEN + " in it")),
      }),
    );
    const text = JSON.stringify(outcomes);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(Buffer.from("x-access-token:" + TOKEN).toString("base64"));
    expect(outcomes.map((o) => o.result)).toEqual([
      "write",
      "none",
      "unknown",
      "unknown",
      "unknown",
    ]);
  });
  it("the detail is the status code or a fixed reason", async () => {
    const base = await fake(status(403));
    const o = await P().probeWriteAccessDetailed({ token: TOKEN, repo: "acme/acme", base });
    expect(o).toEqual({ result: "none", detail: "403" });
    const t = await P().probeWriteAccessDetailed({
      token: TOKEN,
      repo: "acme/acme",
      fetchImpl: () => Promise.reject(new Error("x")),
    });
    expect(t.detail).toBe("network error");
  });
});
