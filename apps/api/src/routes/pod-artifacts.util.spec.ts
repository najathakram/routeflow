import {
  isPodStorageKey,
  isRenderableDataUrl,
  parseImageDataUrl,
  podArtifactKey,
  podKeyPrefix,
  POD_ARTIFACT_ID_RE,
} from "./pod-artifacts.util";

describe("pod-artifacts.util", () => {
  describe("parseImageDataUrl", () => {
    it("decodes a base64 image data URL", () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const value = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

      const parsed = parseImageDataUrl(value);

      expect(parsed).not.toBeNull();
      expect(parsed!.mimeType).toBe("image/svg+xml");
      expect(parsed!.buffer.toString("utf8")).toBe(svg);
    });

    it("decodes a percent-encoded (non-base64) image data URL", () => {
      const svg = '<svg><path d="M0 0 L1 1"/></svg>';
      const value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

      const parsed = parseImageDataUrl(value);

      expect(parsed).not.toBeNull();
      expect(parsed!.buffer.toString("utf8")).toBe(svg);
    });

    it("rejects non-image and non-data values", () => {
      expect(parseImageDataUrl("data:text/html;base64,PGI+")).toBeNull();
      expect(parseImageDataUrl("file:///device/photo.jpg")).toBeNull();
      expect(parseImageDataUrl("native-captured")).toBeNull();
      expect(parseImageDataUrl("tenants/t1/pod/s1/photo-a.jpg")).toBeNull();
      expect(parseImageDataUrl("data:image/jpeg;base64,")).toBeNull(); // empty payload
      expect(parseImageDataUrl("data:image/jpeg")).toBeNull(); // no comma
    });
  });

  describe("keys", () => {
    it("builds tenant-scoped stop-prefixed keys", () => {
      expect(podKeyPrefix("t1", "s1")).toBe("tenants/t1/pod/s1/");
      expect(podArtifactKey("t1", "s1", "photo", "abc123", "jpg")).toBe(
        "tenants/t1/pod/s1/photo-abc123.jpg",
      );
    });

    it("isPodStorageKey pins the tenant", () => {
      expect(isPodStorageKey("tenants/t1/pod/s1/photo-a.jpg", "t1")).toBe(true);
      expect(isPodStorageKey("tenants/t2/pod/s1/photo-a.jpg", "t1")).toBe(false);
      expect(isPodStorageKey("products/p1/img.jpg", "t1")).toBe(false);
      expect(isPodStorageKey("file:///x.jpg", "t1")).toBe(false);
    });
  });

  describe("isRenderableDataUrl", () => {
    it("accepts image data URLs only", () => {
      expect(isRenderableDataUrl("data:image/png;base64,AAAA")).toBe(true);
      expect(isRenderableDataUrl("data:text/html,<b>x</b>")).toBe(false);
      expect(isRenderableDataUrl("native-captured")).toBe(false);
    });
  });

  describe("POD_ARTIFACT_ID_RE", () => {
    it("accepts uuid-ish and hash-ish ids, rejects key-unsafe input", () => {
      expect(POD_ARTIFACT_ID_RE.test("2f1c9c1e-9a1b-4c00-8e11-aaaabbbbcccc")).toBe(true);
      expect(POD_ARTIFACT_ID_RE.test("a1b2c3d4")).toBe(true);
      expect(POD_ARTIFACT_ID_RE.test("../escape")).toBe(false);
      expect(POD_ARTIFACT_ID_RE.test("has space")).toBe(false);
      expect(POD_ARTIFACT_ID_RE.test("abc")).toBe(false); // too short
    });
  });
});
