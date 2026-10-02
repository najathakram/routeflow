import * as fs from "fs";
import * as path from "path";
import { drainQueue } from "../lib/queue-drain";

/**
 * B923 ruling 5: queue entries that were PERSISTED under the old default (users were told "queued") still
 * replay after the allow-list ships. The drain must not consult the allow-list: only NEW enqueues are
 * restricted.
 */
describe("drainQueue does not consult the offline allow-list", () => {
  const legacy = {
    id: "l1",
    endpoint: "/customers/c-1/comments",
    method: "POST" as const,
    body: { content: "hi" },
    timestamp: 1,
    retries: 0,
  };
  const allowed = {
    id: "a1",
    endpoint: "/returns",
    method: "POST" as const,
    body: {},
    headers: { "idempotency-key": "k1" },
    timestamp: 2,
    retries: 0,
  };

  it("replays a legacy non-allow-listed entry and an allow-listed one alike", async () => {
    const request = jest.fn().mockResolvedValue({ status: 200 });
    const res = await drainQueue(
      [legacy, allowed] as never,
      {
        request,
        notifyFailed: jest.fn(),
      } as never,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(res.delivered).toEqual(expect.arrayContaining(["l1", "a1"]));
  });
});

describe("the one-time legacy replay count is wired into the drain (ruling 5)", () => {
  const hook = fs.readFileSync(path.resolve(__dirname, "../hooks/useNetworkSync.ts"), "utf8");

  it("useNetworkSync counts the non-allow-listed entries once per session, BEFORE drainQueue runs", () => {
    expect(hook).toMatch(/countLegacyNonAllowlisted\(/);
    expect(hook.indexOf("countLegacyNonAllowlisted(")).toBeLessThan(
      hook.indexOf("await drainQueue("),
    );
    expect(hook).toMatch(/legacyReplayLogged/);
  });

  it("the drain itself never imports the allow-list (replay is unrestricted)", () => {
    const drain = fs.readFileSync(path.resolve(__dirname, "../lib/queue-drain.ts"), "utf8");
    expect(drain).not.toMatch(/offline-allowlist/);
  });
});
