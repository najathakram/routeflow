/**
 * Locks the product-image multipart file builder — the API's strict JPEG/PNG/WEBP
 * fileFilter rejects anything else, so a bad mime/name inference would 400 uploads.
 */
import { mimeFromUri, productImageFile } from "../lib/product-image";

describe("mimeFromUri", () => {
  it("maps known extensions (case/query-insensitive)", () => {
    expect(mimeFromUri("file:///x/a.JPG")).toBe("image/jpeg");
    expect(mimeFromUri("file:///x/a.jpeg")).toBe("image/jpeg");
    expect(mimeFromUri("file:///x/b.png")).toBe("image/png");
    expect(mimeFromUri("https://h/c.webp?sig=abc")).toBe("image/webp");
  });
  it("returns undefined for unknown/absent extensions", () => {
    expect(mimeFromUri("file:///x/a.gif")).toBeUndefined();
    expect(mimeFromUri("file:///x/noext")).toBeUndefined();
  });
});

describe("productImageFile", () => {
  it("prefers the asset's allowed mimeType", () => {
    expect(productImageFile({ uri: "file:///x/a.bin", mimeType: "image/png" })).toEqual({
      uri: "file:///x/a.bin",
      name: "photo.png",
      type: "image/png",
    });
  });
  it("ignores a disallowed mimeType and falls back to the uri extension", () => {
    // HEIC isn't accepted by the API; the .jpg extension wins.
    expect(productImageFile({ uri: "file:///x/a.jpg", mimeType: "image/heic" }).type).toBe(
      "image/jpeg",
    );
  });
  it("defaults to JPEG when neither mime nor extension resolves", () => {
    expect(productImageFile({ uri: "file:///x/capture" }).type).toBe("image/jpeg");
  });
  it("keeps a fileName whose extension matches the resolved type, else synthesizes one", () => {
    expect(
      productImageFile({ uri: "u", mimeType: "image/webp", fileName: "front.webp" }).name,
    ).toBe("front.webp");
    expect(productImageFile({ uri: "file:///x/a.png" }).name).toBe("photo.png");
  });
  it("never reuses a .heic name once the mime is coerced to JPEG (real iOS library case)", () => {
    // Both uri and fileName carry .heic (the actual failure mode); type coerces
    // to jpeg and the name must NOT stay .heic (that mislabels the file).
    expect(
      productImageFile({
        uri: "file:///x/IMG_1234.heic",
        mimeType: "image/heic",
        fileName: "IMG_1234.heic",
      }),
    ).toEqual({ uri: "file:///x/IMG_1234.heic", name: "photo.jpg", type: "image/jpeg" });
  });
});
