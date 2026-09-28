import * as fs from "fs";
import * as path from "path";
import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { listenOnLoopback } from "./testing/listen-loopback";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * #2267: supertest pointed at a Nest server that is NOT listening calls `listen(0)` per request,
 * which binds `[::]:X` while it connects to `127.0.0.1:X`. Under a parallel pre-push another
 * process can hold `127.0.0.1:X`, and the request reaches that server instead ("Parse Error:
 * Expected HTTP/", socket hang-up). Every spec that drives an app through
 * `request(<app>.getHttpServer())` must bind it first with `listenOnLoopback` (or listen on
 * 127.0.0.1 itself).
 */

const SRC = path.resolve(__dirname, "..");
const SUPERTEST_ON_APP = /request\(\s*[\w.]+\.getHttpServer\(\)\s*\)/;
const BOUND = /listenOnLoopback\(|\.listen\(\s*0\s*,\s*["']127\.0\.0\.1["']/;

function specFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(full, out);
    else if (/\.spec\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("#2267 supertest specs bind to loopback first", () => {
  const drivers = specFiles(SRC).filter((f) => SUPERTEST_ON_APP.test(fs.readFileSync(f, "utf8")));

  it("the scan finds the supertest-driven specs (guards a vacuous pass)", () => {
    expect(drivers.length).toBeGreaterThanOrEqual(11);
  });

  it("every spec that calls request(<app>.getHttpServer()) binds the app to 127.0.0.1 first", () => {
    const unbound = drivers
      .filter((f) => !BOUND.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(unbound).toEqual([]);
  });
});

@Controller("ping")
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}
@Module({ controllers: [PingController] })
class PingModule {}

describe("#2267 listenOnLoopback", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PingModule] }).compile();
    app = mod.createNestApplication();
    await listenOnLoopback(app);
  });
  afterAll(async () => await app.close());

  it("binds the IPv4 loopback address on an OS-chosen port, before any request", () => {
    const addr = app.getHttpServer().address();
    expect(addr).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    expect(addr.port).toBeGreaterThan(0);
  });

  it("supertest reuses that listener instead of listening again per request", async () => {
    const server = app.getHttpServer();
    const before = server.address().port;
    const listen = jest.spyOn(server, "listen");
    await request(server).get("/ping").expect(200, { ok: true });
    await request(server).get("/ping").expect(200, { ok: true });
    expect(listen).not.toHaveBeenCalled();
    expect(server.address().port).toBe(before);
  });
});
