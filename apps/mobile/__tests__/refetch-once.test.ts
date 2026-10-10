import { refetchOnce } from "../lib/refetch-once";

/**
 * #2091: a burst of failed product images on one query refetches it ONCE; a new burst after it
 * settles refetches again; different keys never share a refetch.
 */
function client() {
  let release!: () => void;
  const settled = new Promise<void>((r) => (release = r));
  const invalidateQueries = jest.fn(() => settled);
  return { qc: { invalidateQueries }, invalidateQueries, release, settled };
}

describe("refetchOnce (#2091)", () => {
  it("20 simultaneous failures on one query key refetch it ONCE, and all 20 wait on it", async () => {
    const { qc, invalidateQueries, release } = client();
    const waits = Array.from({ length: 20 }, () => refetchOnce(qc, ["buyer-products"]));
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["buyer-products"] });
    release();
    await expect(Promise.all(waits)).resolves.toHaveLength(20);
  });

  it("after a refetch settles, the next failure starts a new one", async () => {
    const { qc, invalidateQueries, release } = client();
    const first = refetchOnce(qc, ["buyer-shelf"]);
    release();
    await first;
    await refetchOnce(qc, ["buyer-shelf"]);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("different keys are separate refetches", () => {
    const { qc, invalidateQueries } = client();
    refetchOnce(qc, ["buyer-products"]);
    refetchOnce(qc, ["buyer-shelf"]);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("a failing refetch still settles (the image retries against whatever is cached)", async () => {
    const qc = { invalidateQueries: jest.fn(() => Promise.reject(new Error("offline"))) };
    await expect(refetchOnce(qc, ["buyer-products"])).resolves.toBeUndefined();
  });
});
