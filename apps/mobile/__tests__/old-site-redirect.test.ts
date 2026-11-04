/**
 * The old Expo mobile-web address (routeflowmobile) only redirects to the current website.
 * 302 on purpose (undoable); path + query kept where www has the same page, else /login.
 */
import { readFileSync } from "fs";
import { join } from "path";
import * as http from "http";
import type { AddressInfo } from "net";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { redirectTarget, createServer } = require("../redirect/server.js");

const WWW = "https://www.routeflow.info";

describe("old mobile site redirect mapping", () => {
  it("keeps /reset-password and its token query", () => {
    expect(redirectTarget("/reset-password?token=abc123", {})).toBe(
      `${WWW}/reset-password?token=abc123`,
    );
  });
  it("keeps /login and its query", () => {
    expect(redirectTarget("/login?next=%2Fdashboard", {})).toBe(`${WWW}/login?next=%2Fdashboard`);
  });
  it("tolerates a trailing slash", () => {
    expect(redirectTarget("/reset-password/?token=t", {})).toBe(`${WWW}/reset-password?token=t`);
  });
  it.each(["/", "/driver", "/routes/my-runs", "/manifest.json", "/sw.js", "/(driver)/route"])(
    "sends %s to /login",
    (p) => {
      expect(redirectTarget(`${p}?x=1`, {})).toBe(`${WWW}/login`);
    },
  );
  it("takes the www base from WWW_BASE_URL, trimming trailing slashes", () => {
    expect(redirectTarget("/login", { WWW_BASE_URL: "https://staging.example.test/" })).toBe(
      "https://staging.example.test/login",
    );
  });
  it("answers a real request with a 302 and no cache", async () => {
    const server = createServer({});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/reset-password?token=zz" }, resolve)
          .on("error", reject);
      });
      res.resume();
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${WWW}/reset-password?token=zz`);
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("mobile Dockerfile serves only the redirect", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "Dockerfile"), "utf8");
  it("does not build or serve the Expo web export", () => {
    expect(dockerfile).not.toMatch(/expo export/);
    expect(dockerfile).not.toMatch(/nginx/);
  });
  it("runs the redirect server as a non-root user", () => {
    expect(dockerfile).toMatch(/redirect\/server\.js/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });
});
