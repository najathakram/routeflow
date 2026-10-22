import * as fs from "fs";
import * as path from "path";

/**
 * SA-824 race ruling 2: EVERY reader and writer of the PaymentIdempotencyKey table handles the row's state
 * explicitly (CLAIMED / COMPLETED / TOMBSTONED). A tombstone is not a payment: a replay refuses it
 * (409 PAYMENT_KEY_RESOLVED), the by-key read answers { state: "tombstoned" }, and any report or count must
 * exclude it. The table has no TTL and no cleanup job (as OrderIdempotencyKey), so "cleanup same TTL" holds
 * trivially; a cleanup added later is a new site here and must state its rule.
 *
 * The inventory must EQUAL this table both ways: a NEW site (a report, a count, a cleanup, a script) fails
 * until it is classified here with the state rule it applies, and a classified site that stops naming the
 * states goes red.
 */
const TABLE: Record<string, string> = {
  // The claim (INSERT ... 'CLAIMED'), the settle (UPDATE ... 'COMPLETED') and the replay read
  // (TOMBSTONED -> 409 PAYMENT_KEY_RESOLVED; CLAIMED -> 409 PAYMENT_KEY_IN_FLIGHT; COMPLETED -> replay).
  "src/invoices/payment-idempotency.ts": "writer + replay reader: every state explicit",
  // GET by-key (TOMBSTONED -> { state: "tombstoned" }) and POST resolve (INSERT ... 'TOMBSTONED').
  "src/invoices/payment-key-status.service.ts": "by-key read + resolve: every state explicit",
};

const ROOT = path.resolve(__dirname, "../.."); // apps/api
const REPO = path.resolve(ROOT, "../..");
const SITE = /paymentIdempotencyKey\b|"PaymentIdempotencyKey"/;

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory())
      return ["node_modules", "dist", "generated"].includes(e.name) ? [] : files(p);
    if (!/\.(ts|js|mjs|cjs)$/.test(e.name) || /\.d\.ts$/.test(e.name)) return [];
    return /\.spec\.ts$/.test(e.name) ? [] : [p];
  });
}

function inventory(): string[] {
  const roots = [path.join(ROOT, "src"), path.join(ROOT, "scripts"), path.join(REPO, "scripts")];
  return roots
    .flatMap(files)
    .filter((f) => SITE.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .sort();
}

describe("SA-824 race ruling 2: every PaymentIdempotencyKey site handles the state explicitly", () => {
  it("the sites in production source EQUAL the classified table (a new reader fails until classified)", () => {
    expect(inventory()).toEqual(Object.keys(TABLE).sort());
  });

  it("each classified site names every state it can meet, TOMBSTONED included", () => {
    for (const rel of Object.keys(TABLE)) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect({ rel, TOMBSTONED: /TOMBSTONED/.test(text) }).toEqual({ rel, TOMBSTONED: true });
      expect({ rel, COMPLETED: /COMPLETED/.test(text) }).toEqual({ rel, COMPLETED: true });
    }
  });

  it("no count, aggregate or groupBy reads the table without a state filter (tombstones are not payments)", () => {
    const AGG = /paymentIdempotencyKey\s*\.\s*(count|aggregate|groupBy|findMany)\s*\(([^)]*)\)/g;
    for (const rel of inventory()) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      for (const m of text.matchAll(AGG)) {
        expect({ rel, call: m[0], filtersState: /state/.test(m[2]) }).toMatchObject({
          filtersState: true,
        });
      }
    }
  });
});
