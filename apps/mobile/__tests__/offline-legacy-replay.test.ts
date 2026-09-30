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
