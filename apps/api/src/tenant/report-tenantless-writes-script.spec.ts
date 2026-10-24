import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * W-767 (SA-908): the census script reads exported deploy logs (read-only) and lists each route the DARK
 * TenantRequiredInterceptor logged, writes and reads apart. It is driven as a real child process (the -script lane).
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-tenantless-writes.mjs");
const run = (args: string[], input?: string) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", input, timeout: 30_000 });

describe("report-tenantless-writes.mjs (W-767 census)", () => {
  const LOG = [
    "2026-10-24T01:00:00Z [Nest] 1 WARN [TenantRequiredInterceptor] [tenant-required] would-deny POST /api/v1/orders (role SUPER_ADMIN, no tenant)",
    "2026-10-24T01:00:01Z [Nest] 2 WARN [TenantRequiredInterceptor] [tenant-required] would-deny POST /api/v1/orders (role SUPER_ADMIN, no tenant)",
    "2026-10-24T01:00:02Z [Nest] 1 WARN [TenantRequiredInterceptor] [tenant-required] would-deny PATCH /api/v1/products/:id (role SUPER_ADMIN, no tenant)",
    "2026-10-24T01:00:03Z [Nest] 1 LOG [TenantRequiredInterceptor] [tenant-required] tenantless-read GET /api/v1/orders (role SUPER_ADMIN)",
    "2026-10-24T01:00:04Z [Nest] 1 LOG [OrdersService] an unrelated line about POST /api/v1/orders",
  ].join("\n");

  it("tallies writes and reads apart, one row per route, counted by the processes that logged it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w767-"));
    const file = path.join(dir, "api.log");
    fs.writeFileSync(file, LOG);
    const r = run([file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("## Writes the enforced rule would refuse (2)");
    expect(r.stdout).toContain("| `POST /api/v1/orders` | 2 |");
    expect(r.stdout).toContain("| `PATCH /api/v1/products/:id` | 1 |");
    expect(r.stdout).toContain("## Reads (listed only; SA-908 item 4) (1)");
    expect(r.stdout).toContain("| `GET /api/v1/orders` | 1 |");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads stdin with '-', and says (none) when nothing was logged", () => {
    const r = run(["-"], "no census lines here\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("## Writes the enforced rule would refuse (0)");
    expect(r.stdout).toContain("| (none) | - |");
  });

  it("exits 2 with a usage line when given no input, and on an unreadable file", () => {
    expect(run([]).status).toBe(2);
    const missing = run([path.join(os.tmpdir(), "w767-no-such-file.log")]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("cannot read logs");
  });
});
