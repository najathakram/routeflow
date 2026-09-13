/**
 * B389/F12-003 (#712) — the mobile web-export runner used to be plain
 * `nginx:alpine` with no `USER` directive, which serves as root inside the
 * container. The fix swaps the runner stage to `nginxinc/nginx-unprivileged:alpine`
 * (nginx's own hardened, already-non-root image), ends on `USER nginx`, and
 * moves the listen port from the image's old default of 80 to 8080 (a
 * non-root process can't bind :80). See `apps/mobile/Dockerfile`'s runner
 * stage comment for the full rationale.
 *
 * This is a tripwire, not a Docker build: it asserts on the TEXT of the
 * Dockerfile so a future edit can't silently regress the runner back to a
 * root user or the old port without failing a fast, daemon-free Jest run.
 */

import { readFileSync } from "fs";
import { join } from "path";

describe("REG-B389 mobile Dockerfile runner drops root", () => {
  const dockerfile = readFileSync(join(__dirname, "..", "Dockerfile"), "utf8");

  it("the runner stage is nginxinc/nginx-unprivileged:alpine", () => {
    expect(dockerfile).toMatch(/^FROM nginxinc\/nginx-unprivileged:alpine AS runner$/m);
  });

  it("the LAST USER directive in the file is USER nginx", () => {
    const userLines = dockerfile.match(/^USER .+$/gm) ?? [];
    expect(userLines.length).toBeGreaterThan(0);
    expect(userLines[userLines.length - 1]).toBe("USER nginx");
  });

  it("exposes 8080", () => {
    expect(dockerfile).toMatch(/^EXPOSE 8080$/m);
  });

  it("defaults PORT to 8080", () => {
    expect(dockerfile).toContain("${PORT:-8080}");
  });

  it("does not expose port 80 as a whole token", () => {
    expect(dockerfile).not.toMatch(/^EXPOSE 80$/m);
  });
});
