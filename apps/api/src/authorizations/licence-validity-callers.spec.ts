// The `@LeaderCron` advisory lock is a pass-through here (no database), as in licence-validity-day.spec.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import * as fs from "fs";
import * as path from "path";
import {
  displayLicenceStatus,
  isLicenceExpired,
  isLicenceLive,
  licenceExpiryCutoff,
} from "@routeflow/types";
import { overdueCutoff } from "../common/calendar-date";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B330 (class fix, #3842 review): ONE licence-validity rule (`packages/types/licence-validity.ts`),
 * used by every caller. A licence is good through the END of its printed day in the tenant's zone.
 * Chicago, CDT (UTC-5): the printed day 2026-03-09 ends at 2026-03-10T05:00Z, so 03:00Z on the 10th is
 * still the evening of the printed day - the instant a by-instant compare calls the licence expired.
 */
const CHI = "America/Chicago";
const PRINTED = new Date("2026-03-09T00:00:00.000Z");
const EVENING = new Date("2026-03-10T03:00:00.000Z");
const NEXT_DAY = new Date("2026-03-10T05:00:00.000Z");

describe("REG-B330 the shared licence rule", () => {
  it("REG-B330 valid through the printed day in the zone, expired from the next local day", () => {
    expect(isLicenceExpired(PRINTED, EVENING, CHI)).toBe(false);
    expect(isLicenceExpired(PRINTED, NEXT_DAY, CHI)).toBe(true);
  });

  it("REG-B330 an unknown or empty zone reads the day in UTC: never valid-forever (M4)", () => {
    // 2026-03-10T03:00Z is already the 10th in UTC, so a licence printed the 9th is expired there.
    for (const zone of ["Not/AZone", "", "EST5EDTX", "utc+5", null, undefined]) {
      expect(isLicenceExpired(PRINTED, EVENING, zone)).toBe(true);
      expect(isLicenceExpired(PRINTED, new Date("2026-03-09T23:59:59.999Z"), zone)).toBe(false);
      expect(licenceExpiryCutoff(EVENING, zone).toISOString()).toBe("2026-03-10T00:00:00.000Z");
    }
  });

  it("REG-B330 an expiry that does not parse is expired (fails closed); no expiry is permanent", () => {
    expect(isLicenceExpired("not-a-date", EVENING, CHI)).toBe(true);
    expect(isLicenceExpired(new Date(NaN), EVENING, CHI)).toBe(true);
    expect(isLicenceExpired(null, EVENING, CHI)).toBe(false);
    expect(isLicenceExpired(undefined, EVENING, CHI)).toBe(false);
  });

  it("REG-B330 isLicenceLive and displayLicenceStatus follow the same day rule", () => {
    expect(isLicenceLive({ status: "VERIFIED", expiresAt: PRINTED }, EVENING, CHI)).toBe(true);
    expect(isLicenceLive({ status: "VERIFIED", expiresAt: PRINTED }, NEXT_DAY, CHI)).toBe(false);
    expect(isLicenceLive({ status: "PENDING_REVIEW", expiresAt: null }, EVENING, CHI)).toBe(false);
    expect(displayLicenceStatus({ status: "VERIFIED", expiresAt: PRINTED }, EVENING, CHI)).toBe(
      "VERIFIED",
    );
    expect(displayLicenceStatus({ status: "VERIFIED", expiresAt: PRINTED }, NEXT_DAY, CHI)).toBe(
      "EXPIRED",
    );
    expect(displayLicenceStatus({ status: "REJECTED", expiresAt: PRINTED }, NEXT_DAY, CHI)).toBe(
      "REJECTED",
    );
  });

  it("REG-B330 the shared cutoff equals the api's calendar-date overdue cutoff in every zone", () => {
    const zones = [
      CHI,
      "UTC",
      "Pacific/Honolulu",
      "Asia/Kolkata",
      "Pacific/Auckland",
      "Pacific/Kiritimati",
      null,
    ];
    const instants = [
      "2026-03-08T07:59:59.999Z", // Chicago the instant before spring-forward
      "2026-03-08T08:00:00.000Z",
      "2026-03-10T03:00:00.000Z",
      "2026-04-04T13:00:00.000Z", // Auckland DST end
      "2026-11-01T06:30:00.000Z", // Chicago fall-back
      "2028-02-29T23:30:00.000Z",
    ];
    for (const z of zones) {
      for (const i of instants) {
        const now = new Date(i);
        expect(licenceExpiryCutoff(now, z).toISOString()).toBe(overdueCutoff(now, z).toISOString());
      }
    }
  });
});

describe("REG-B330 M1: the buyer regulated-visibility gate agrees with the sale guard", () => {
  it("REG-B330 a licence valid through today is not hidden; the next local day hides it", async () => {
    const run = async (now: Date) => {
      const prisma = createMockPrisma();
      (prisma.tenantConfig.findUnique as jest.Mock).mockResolvedValue({ timezone: CHI });
      prisma.trackedCategory.findMany.mockResolvedValue([{ id: "c1", name: "Tobacco" }] as never);
      prisma.customerAuthorization.findMany.mockResolvedValue([
        { trackedCategoryId: "c1", status: "VERIFIED", expiresAt: PRINTED },
      ] as never);
      return new RegulatedVisibilityService(prisma as never).computeGate("cust", now);
    };
    expect([...(await run(EVENING)).hiddenIds]).toEqual([]);
    const after = await run(NEXT_DAY);
    expect([...after.hiddenIds]).toEqual(["c1"]);
    expect(after.locked).toEqual([{ id: "c1", name: "Tobacco", status: "EXPIRED" }]);
  });
});

describe("REG-B330 M3: customer merge ranks a licence by the same rule", () => {
  const svc = Object.create(CustomersService.prototype) as {
    authSecondaryWins(
      sec: { status: string; expiresAt: Date | null },
      pri: { status: string; expiresAt: Date | null },
      now: Date,
      zone: string | null,
    ): boolean;
  };
  const pending = { status: "PENDING_REVIEW", expiresAt: null };
  const live = { status: "VERIFIED", expiresAt: PRINTED };

  it("REG-B330 a VERIFIED licence valid today beats a PENDING_REVIEW one; once expired it does not", () => {
    expect(svc.authSecondaryWins(live, pending, EVENING, CHI)).toBe(true);
    expect(svc.authSecondaryWins(live, pending, NEXT_DAY, CHI)).toBe(false);
  });
});

/**
 * The census: every file that decides "is this licence still good?" goes through the shared rule, and
 * nothing else compares a licence's `expiresAt` to the clock. A new caller that does the compare inline
 * fails here; a new helper caller must be added to the list on purpose.
 */
describe("REG-B330 caller census", () => {
  const ROOT = path.join(__dirname, "..", "..", "..", "..");
  const CALLERS: Array<[file: string, sites: number]> = [
    ["apps/api/src/authorizations/authorization-expiry.service.ts", 1], // the sweep flip
    ["apps/api/src/authorizations/authorization-guard.service.ts", 1], // the sale guard
    ["apps/api/src/authorizations/authorizations.service.ts", 3], // buyer list, bells, assertNotLiveVerified
    ["apps/api/src/buyer/regulated-visibility.service.ts", 1], // buyer catalog/dashboard gate
    ["apps/api/src/customers/customers.service.ts", 1], // merge rank
    ["apps/mobile/lib/customer-authorizations-logic.ts", 1], // operator Licenses badge
    ["apps/web/lib/api/authorizations.ts", 1], // customer-file Licenses badge
  ];
  const HELPER = /\b(?:isLicenceExpired|isLicenceLive|licenceExpiryCutoff|displayLicenceStatus)\(/g;
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("REG-B330 the helper call sites are exactly the listed callers", () => {
    const found: Array<[string, number]> = [];
    for (const [file] of CALLERS)
      found.push([file, (strip(read(file)).match(HELPER) ?? []).length]);
    expect(found).toEqual(CALLERS);
  });

  it("REG-B330 no other source file compares a licence expiry to the clock inline", () => {
    const dirs = [
      "apps/api/src",
      "apps/web/app",
      "apps/web/lib",
      "apps/web/components",
      "apps/mobile/app",
      "apps/mobile/lib",
      "apps/mobile/components",
    ];
    // A licence row's expiry is read off a record (`a.expiresAt`); a bare `expiresAt` is a form field the
    // user is typing, and its "not in the past" check is input validation, not a validity decision.
    const CLOCK = String.raw`(?:\bnow\b|new Date\(\)|Date\.now\(\))`;
    const INLINE = [
      new RegExp(String.raw`\.expiresAt\b[^\n;]*?(?:<=?|>=?)\s*${CLOCK}`),
      new RegExp(String.raw`${CLOCK}\s*(?:<=?|>=?)[^\n;]*\.expiresAt\b`),
      new RegExp(String.raw`new Date\([^)\n]*\.expiresAt[^)\n]*\)(?:\.getTime\(\))?\s*(?:<=?|>=?)`),
    ];
    const LICENCE_FILE = /CustomerAuthorization|licen[cs]e/i;
    // Not a licence-validity decision: form-input validation ("the date you typed is not in the past") and
    // an onboarding invite token's own lifetime.
    const NOT_LICENCE_VALIDITY = [
      "apps/web/app/(dashboard)/orders/_components/LicenseGuardModal.tsx",
      "apps/api/src/onboarding/onboarding-intake.service.ts",
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(rel);
        } else if (/\.tsx?$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)) {
          const code = strip(read(rel));
          if (
            !NOT_LICENCE_VALIDITY.includes(rel) &&
            LICENCE_FILE.test(code) &&
            INLINE.some((re) => re.test(code))
          )
            offenders.push(rel);
        }
      }
    };
    dirs.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
