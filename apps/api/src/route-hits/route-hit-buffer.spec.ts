import { RouteHitBuffer } from "./route-hit-buffer";

describe("RouteHitBuffer (W3: bounded, synchronous)", () => {
  it("counts per key and drains + resets", () => {
    const b = new RouteHitBuffer();
    b.record("GET /a");
    b.record("GET /a");
    b.record("POST /b");
    const out = b.drain();
    expect(Object.fromEntries(out.counts)).toEqual({ "GET /a": 2, "POST /b": 1 });
    expect(out.dropped).toBe(0);
    expect(b.size).toBe(0);
    expect(b.drain().counts.size).toBe(0);
  });

  it("is BOUNDED: past the cap a NEW key is dropped and counted, an existing key still increments", () => {
    const b = new RouteHitBuffer(3);
    for (const k of ["a", "b", "c"]) b.record(k);
    b.record("d");
    b.record("e");
    b.record("a");
    expect(b.size).toBe(3);
    const out = b.drain();
    expect(Object.fromEntries(out.counts)).toEqual({ a: 2, b: 1, c: 1 });
    expect(out.dropped).toBe(2);
  });

  it("the default cap is 2,000 distinct keys", () => {
    const b = new RouteHitBuffer();
    for (let i = 0; i < 2500; i++) b.record(`GET /k${i}`);
    expect(b.size).toBe(2000);
    expect(b.drain().dropped).toBe(500);
  });
});
