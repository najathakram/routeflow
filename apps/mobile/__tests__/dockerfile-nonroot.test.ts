/**
 * B389/F12-003 (#712) — the mobile image used to run as root (plain `nginx:alpine`
 * with no `USER` directive). The old Expo mobile-web build is now retired: the
 * runner is a tiny dependency-free node redirect server (`redirect/server.js`)
 * that runs as the unprivileged `node` user from `node:24-alpine` and listens on
 * 8080 (a non-root process can't bind :80). See `apps/mobile/Dockerfile`.
 *
 * This is a tripwire, not a Docker build: it asserts on the TEXT of the
 * Dockerfile so a future edit can't silently regress the runner back to a
 * root user or the old port without failing a fast, daemon-free Jest run.
 */

import { readFileSync } from "fs";
import { join } from "path";

describe("REG-B389 mobile Dockerfile runner drops root", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "Dockerfile"), "utf8");

  it("the runtime image is node:24-alpine", () => {
    const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];
    expect(fromLines.length).toBeGreaterThan(0);
    expect(fromLines[fromLines.length - 1]).toMatch(/^FROM node:24-alpine(\s+AS \S+)?$/);
  });

  it("the LAST USER directive in the file is USER node", () => {
    const userLines = dockerfile.match(/^USER .+$/gm) ?? [];
    expect(userLines.length).toBeGreaterThan(0);
    expect(userLines[userLines.length - 1].trim()).toBe("USER node");
  });

  it("never runs as root (USER root / USER 0)", () => {
    expect(dockerfile).not.toMatch(/^USER\s+(root|0)(:\S+)?\s*$/m);
  });

  it("exposes 8080", () => {
    expect(dockerfile).toMatch(/^EXPOSE 8080$/m);
  });

  it("does not expose port 80 as a whole token", () => {
    expect(dockerfile).not.toMatch(/^EXPOSE\s+(.*\s)?80(\s.*)?$/m);
  });
});
