// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp: any = require("sharp");

import { compressDocument, compressImage } from "./compress.util";

/**
 * Real sharp (no mock) — fixtures are generated in-memory so the suite needs
 * no binary test assets and stays deterministic.
 */
describe("compress.util", () => {
  describe("compressImage", () => {
    it("compresses an image with an alpha channel to WebP, preserving alpha", async () => {
      const alphaPng = await sharp({
        create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .toBuffer();

      const result = await compressImage(alphaPng, "image/png");

      expect(result.mimeType).toBe("image/webp");
      expect(result.ext).toBe("webp");
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it("compresses an opaque image to JPEG", async () => {
      const opaqueImage = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .jpeg()
        .toBuffer();

      const result = await compressImage(opaqueImage, "image/jpeg");

      expect(result.mimeType).toBe("image/jpeg");
      expect(result.ext).toBe("jpg");
      expect(result.buffer.length).toBeGreaterThan(0);
    });

    it("resizes an oversized image down to maxWidth", async () => {
      const oversized = await sharp({
        create: { width: 3000, height: 2000, channels: 3, background: { r: 5, g: 5, b: 5 } },
      })
        .jpeg()
        .toBuffer();

      const result = await compressImage(oversized, "image/jpeg", 512);
      const meta = await sharp(result.buffer).metadata();

      expect(meta.width).toBeLessThanOrEqual(512);
    });

    it("throws on a non-image mime type", async () => {
      await expect(compressImage(Buffer.from("hello"), "text/plain")).rejects.toThrow(
        /Unsupported mime type/,
      );
    });

    // Durable POD signatures arrive as stroke-built SVG data URLs and are
    // rasterized here — this pins libvips' SVG (librsvg) support so a sharp
    // upgrade that drops it fails the suite instead of production ingest.
    it("rasterizes an SVG (POD signature) to a real raster image", async () => {
      const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="140" viewBox="0 0 300 140">` +
          `<rect width="300" height="140" fill="#ffffff"/>` +
          `<path d="M10 70 L80 40 L150 90 L290 30" fill="none" stroke="#1e293b" stroke-width="2.5"/>` +
          `</svg>`,
      );

      const result = await compressImage(svg, "image/svg+xml");
      const meta = await sharp(result.buffer).metadata();

      expect(["image/jpeg", "image/webp"]).toContain(result.mimeType);
      expect(meta.width).toBe(300);
      expect(meta.height).toBe(140);
    });
  });

  describe("compressDocument", () => {
    it("passes PDFs through unchanged", async () => {
      const pdfBuffer = Buffer.from("%PDF-1.4 fake pdf content");

      const result = await compressDocument(pdfBuffer, "application/pdf");

      expect(result.mimeType).toBe("application/pdf");
      expect(result.ext).toBe("pdf");
      expect(result.buffer).toBe(pdfBuffer);
    });

    it("compresses an image to JPEG", async () => {
      const image = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .png()
        .toBuffer();

      const result = await compressDocument(image, "image/png");

      expect(result.mimeType).toBe("image/jpeg");
      expect(result.ext).toBe("jpg");
      expect(result.buffer.length).toBeGreaterThan(0);
    });
  });
});
