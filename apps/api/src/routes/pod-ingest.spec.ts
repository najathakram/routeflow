import { ingestPodCapture, type PodIngestDeps } from "./pod-ingest";

jest.mock("../storage/compress.util", () => ({
  compressImage: jest.fn(async (buffer: Buffer, mimeType: string) => ({
    buffer,
    mimeType,
    ext: "png",
  })),
}));

/**
 * Row 108 (#3723 review): a stop completion ingests its POD BEFORE it takes the stop's lock, so a 503 LOCK_UNAVAILABLE
 * retry (the driver app retries with the SAME idempotency key, SA-706h) uploaded the signature again under a new random
 * name and orphaned the first copy. With an idempotency key the stored name is derived from it, so the retry overwrites
 * the same object. Without one nothing changes (a fresh name per call).
 */
const PNG = `data:image/png;base64,${Buffer.from("x").toString("base64")}`;

function deps(): PodIngestDeps & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    uploads,
    prisma: { getTenantId: () => "t1" },
    storage: { upload: async (key: string) => void uploads.push(key) },
    logger: { warn: jest.fn() },
  };
}

describe("ingestPodCapture: a retry under the same idempotency key", () => {
  it("writes the signature and photos to the SAME keys on every attempt", async () => {
    const d = deps();
    const a = { signatureUrl: PNG, podPhotoUrls: [PNG, PNG] };
    const b = { signatureUrl: PNG, podPhotoUrls: [PNG, PNG] };
    await ingestPodCapture(d, a, "stop-1", { idempotencyKey: "stop-stop-1-abc" });
    await ingestPodCapture(d, b, "stop-1", { idempotencyKey: "stop-stop-1-abc" });
    expect(b).toEqual(a);
    expect(new Set(d.uploads).size).toBe(3); // signature + two photos, each overwritten, never a 4th..6th object
    expect(a.podPhotoUrls[0]).not.toBe(a.podPhotoUrls[1]); // two photos are still two objects
    expect(a.signatureUrl).toMatch(/^tenants\/t1\/pod\/stop-1\/signature-[A-Za-z0-9_-]+\.png$/);
  });

  it("a different key (a new attempt) writes new objects", async () => {
    const d = deps();
    const a = { signatureUrl: PNG };
    const b = { signatureUrl: PNG };
    await ingestPodCapture(d, a, "stop-1", { idempotencyKey: "k1" });
    await ingestPodCapture(d, b, "stop-1", { idempotencyKey: "k2" });
    expect(a.signatureUrl).not.toBe(b.signatureUrl);
  });

  it("no key: a fresh name per call, as before", async () => {
    const d = deps();
    const a = { signatureUrl: PNG };
    const b = { signatureUrl: PNG };
    await ingestPodCapture(d, a, "stop-1");
    await ingestPodCapture(d, b, "stop-1");
    expect(a.signatureUrl).not.toBe(b.signatureUrl);
  });
});
