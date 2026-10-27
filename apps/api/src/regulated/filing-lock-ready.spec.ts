import * as fs from "fs";
import * as path from "path";
import { RegulatedFilingService } from "./regulated-filing.service";
import { FILING_LOCK_READY, FILING_LOCK_NOT_READY_MESSAGE } from "./filing-lock-ready";

/**
 * SA-997 (A): locking a filing is switched off. `lockFiling` refuses with 409 FILING_LOCK_NOT_READY before any read
 * or write, `claimFilingLock` has that one caller, and the API's literal copy equals the shared one the web reads.
 */
const SRC = path.join(__dirname, "..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
};

function shared(): { ready?: boolean; copy?: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const t = require("@routeflow/types") as {
      FILING_LOCK_READY?: boolean;
      FILING_LOCK_NOT_READY_COPY?: string;
    };
    return { ready: t.FILING_LOCK_READY, copy: t.FILING_LOCK_NOT_READY_COPY };
  } catch {
    return {};
  }
}

describe("filing lock is switched off (SA-997)", () => {
  it("the switch is false and equals the shared one; the sentence is byte-equal", () => {
    const s = shared();
    expect(FILING_LOCK_READY).toBe(false);
    expect(s.ready).toBe(false);
    expect(FILING_LOCK_NOT_READY_MESSAGE).toBe(s.copy);
  });

  it("lockFiling refuses with 409 FILING_LOCK_NOT_READY and touches nothing", async () => {
    const touched: string[] = [];
    const prisma = new Proxy(
      {},
      {
        get: (_t, key) => {
          touched.push(String(key));
          throw new Error(`prisma.${String(key)} was read`);
        },
      },
    );
    const svc = new (RegulatedFilingService as any)(prisma, {}, {}, {}, {});
    await expect(
      svc.lockFiling("f-1", { userId: "u1", reason: "Filed with the state" }),
    ).rejects.toMatchObject({ status: 409, response: { code: "FILING_LOCK_NOT_READY" } });
    expect(touched).toEqual([]);
  });

  it("claimFilingLock has exactly one caller, and lockFiling asserts the switch as its first statement", () => {
    const callers = walk(SRC).filter(
      (f) =>
        !f.endsWith(`${path.sep}filed-periods.ts`) &&
        /\bclaimFilingLock\(/.test(fs.readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => path.relative(SRC, f).split(path.sep).join("/"))).toEqual([
      "regulated/regulated-filing.service.ts",
    ]);
    const src = fs.readFileSync(path.join(SRC, "regulated/regulated-filing.service.ts"), "utf8");
    const body = src.slice(src.indexOf("async lockFiling("));
    const first = body.slice(body.indexOf("{\n", body.indexOf("impersonatedBy")) + 2).trimStart();
    expect(first.startsWith("assertFilingLockReady();")).toBe(true);
  });
});
