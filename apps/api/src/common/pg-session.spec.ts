import * as fs from "fs";
import * as path from "path";

/**
 * Row 361: the app pins the session TIME ZONE of EVERY Postgres connection it opens to UTC, in one place
 * (`utcPoolConfig`, pg-pool's awaited `onConnect`). Pinned here: the hook runs `SET TIME ZONE 'UTC'`, chains a
 * caller's own hook and FAILS CLOSED; the advisory-lock pool is built from it (the mocked `pg`); and,
 * structurally, every Postgres connection opened in production source is built through it, so a new pool or
 * client cannot be added unpinned.
 */
const mockPoolCtor = jest.fn().mockImplementation(() => ({
  connect: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
}));
jest.mock("pg", () => ({ Pool: mockPoolCtor }));

import { APP_SESSION_TIME_ZONE_SQL, utcPoolConfig } from "./pg-session";

describe("utcPoolConfig", () => {
  it("keeps the caller's config and adds an onConnect that runs SET TIME ZONE 'UTC'", async () => {
    const cfg = utcPoolConfig({ connectionString: "postgres://x", max: 3 });
    expect(cfg).toMatchObject({ connectionString: "postgres://x", max: 3 });
    const client = { query: jest.fn().mockResolvedValue(undefined) };
    await cfg.onConnect(client as never);
    expect(APP_SESSION_TIME_ZONE_SQL).toBe("SET TIME ZONE 'UTC'");
    expect(client.query).toHaveBeenCalledWith("SET TIME ZONE 'UTC'");
  });

  it("runs a caller's own onConnect after the pin", async () => {
    const order: string[] = [];
    const cfg = utcPoolConfig({
      onConnect: async () => {
        order.push("prior");
      },
    });
    const client = {
      query: jest.fn(async () => {
        order.push("pin");
      }),
    };
    await cfg.onConnect(client as never);
    expect(order).toEqual(["pin", "prior"]);
  });

  it("fails CLOSED: a rejected SET rejects the hook, so pg-pool ends the client and the acquire fails", async () => {
    const cfg = utcPoolConfig({});
    const client = { query: jest.fn().mockRejectedValue(new Error("boom")) };
    await expect(cfg.onConnect(client as never)).rejects.toThrow("boom");
  });
});

describe("the advisory-lock pool is pinned", () => {
  beforeEach(() => {
    jest.resetModules();
    mockPoolCtor.mockClear();
  });

  it("db-locks builds its pool from utcPoolConfig (its onConnect issues the pin)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const locks = require("./db-locks");
    await locks
      .withAdvisoryLock({ family: "order-merge", key: "k", mode: "try" }, async () => 1)
      .catch(() => undefined);
    expect(mockPoolCtor).toHaveBeenCalled();
    const cfg = mockPoolCtor.mock.calls[0][0];
    expect(typeof cfg.onConnect).toBe("function");
    const client = { query: jest.fn().mockResolvedValue(undefined) };
    await cfg.onConnect(client);
    expect(client.query).toHaveBeenCalledWith("SET TIME ZONE 'UTC'");
  });
});

describe("every Postgres connection in production source goes through utcPoolConfig", () => {
  const SRC = path.resolve(__dirname, "..");
  /** The only production files allowed to import `pg`: the helper's own types, the two pool owners. */
  const PG_IMPORTERS = ["common/pg-session.ts", "common/db-locks.ts", "prisma/prisma.service.ts"];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) files(p, out);
      else if (
        /\.tsx?$/.test(name) &&
        !/\.(spec|test)\.tsx?$/.test(name) &&
        !p.split(path.sep).join("/").includes("/testing/")
      )
        out.push(p);
    }
    return out;
  };
  const prod = files(SRC).map((f) => ({
    rel: path.relative(SRC, f).split(path.sep).join("/"),
    code: strip(fs.readFileSync(f, "utf8")),
  }));

  it("only the registered files import pg (a new connection must be added HERE, on purpose)", () => {
    const importers = prod
      .filter((f) =>
        /from\s+["']pg["']|require\(\s*["']pg["']\s*\)|import\(\s*["']pg["']\s*\)/.test(f.code),
      )
      .map((f) => f.rel)
      .sort();
    expect(importers).toEqual([...PG_IMPORTERS].sort());
  });

  it("each `new Pool(` takes utcPoolConfig(...), exactly two sites, and no bare Client / PrismaPg(url)", () => {
    let wrapped = 0;
    const offenders: string[] = [];
    for (const f of prod) {
      const pools = [...f.code.matchAll(/new\s+(?:pg\.)?Pool\s*\(/g)];
      const pins = [...f.code.matchAll(/new\s+(?:pg\.)?Pool\s*\(\s*utcPoolConfig\s*\(/g)];
      wrapped += pins.length;
      if (pools.length !== pins.length) offenders.push(`${f.rel}: unwrapped Pool`);
      if (/new\s+(?:pg\.)?Client\s*\(/.test(f.code)) offenders.push(`${f.rel}: new Client(`);
      // The adapter given a config or URL builds its OWN pool (unpinned): it must be handed a Pool variable.
      for (const m of f.code.matchAll(/new\s+PrismaPg\s*\(\s*([^)]*)\)/g)) {
        if (!/^[A-Za-z_$][\w$]*$/.test(m[1].trim()))
          offenders.push(`${f.rel}: new PrismaPg(${m[1].trim()})`);
      }
    }
    expect(offenders).toEqual([]);
    expect(wrapped).toBe(2); // PrismaService and db-locks
  });
});
