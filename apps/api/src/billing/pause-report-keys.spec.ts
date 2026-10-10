/**
 * SA-733r7 PR-B3: the blast-radius report builds each tenant's notice key (`<invoiceId>:<pastDueSince ISO>`) from a
 * raw pg row. `pastDueSince` is TIMESTAMP(3) WITHOUT a zone and node-postgres parses such a value as LOCAL time, so
 * on a machine that is not on UTC the key (and hoursOverdue) shifted and every tenant showed "no reminders sent".
 * The helper reads the column as UTC; these tests run it in child processes under non-UTC TZ values.
 */
import { spawnSync } from "child_process";
import * as path from "path";
import { pathToFileURL } from "url";

const LIB = pathToFileURL(
  path.resolve(__dirname, "..", "..", "scripts", "lib", "pause-report-keys.mjs"),
).href;

function run(tz: string, body: string): string {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRequire } from "module";
       import { episodeKey, utcTimestampTypes } from ${JSON.stringify(LIB)};
       const pg = createRequire(import.meta.url)("pg");
       ${body}`,
    ],
    { env: { ...process.env, TZ: tz }, encoding: "utf8", cwd: path.resolve(__dirname, "..", "..") },
  );
  if (res.status !== 0) throw new Error(`child failed (TZ=${tz}): ${res.stderr}`);
  return res.stdout.trim();
}

// the stored value: 2026-11-01 00:00:00.123 UTC, in the text form Postgres sends for TIMESTAMP(3)
const WIRE = "2026-11-01 00:00:00.123";
const EXPECTED = "2026-11-01T00:00:00.123Z";

describe("report-billing-pause-blast-radius: the episode key is zone-proof", () => {
  it("control: stock node-postgres reads the zoneless column as LOCAL time (this is the bug)", () => {
    const out = run(
      "America/Chicago",
      `console.log(pg.types.getTypeParser(1114, "text")(${JSON.stringify(WIRE)}).toISOString());`,
    );
    expect(out).not.toBe(EXPECTED);
  });

  it.each(["America/Chicago", "Asia/Karachi", "Pacific/Auckland", "UTC"])(
    "the client's type map reads the TIMESTAMP(3) column as UTC under TZ=%s",
    (tz) => {
      const out = run(
        tz,
        `const t = utcTimestampTypes(pg.types);
         console.log(t.getTypeParser(1114, "text")(${JSON.stringify(WIRE)}).toISOString());`,
      );
      expect(out).toBe(EXPECTED);
    },
  );

  it("leaves every other type to node-postgres (timestamptz, int, text)", () => {
    const out = run(
      "America/Chicago",
      `const t = utcTimestampTypes(pg.types);
       const same = [1184, 23, 25].every((oid) => t.getTypeParser(oid, "text") === pg.types.getTypeParser(oid, "text"));
       console.log(String(same));`,
    );
    expect(out).toBe("true");
  });

  it.each(["America/Chicago", "Asia/Karachi"])(
    "episodeKey of a parsed row equals the key the service wrote, under TZ=%s",
    (tz) => {
      const out = run(
        tz,
        `const t = utcTimestampTypes(pg.types);
         const since = t.getTypeParser(1114, "text")(${JSON.stringify(WIRE)});
         console.log(episodeKey("in_1", since));`,
      );
      expect(out).toBe(`in_1:${EXPECTED}`);
    },
  );

  it("accepts a Date or an ISO string (the --json path and tests)", () => {
    const out = run(
      "America/Chicago",
      `console.log(episodeKey("in_1", new Date(${JSON.stringify(EXPECTED)})) + "|" + episodeKey("in_1", ${JSON.stringify(EXPECTED)}));`,
    );
    expect(out).toBe(`in_1:${EXPECTED}|in_1:${EXPECTED}`);
  });
});
