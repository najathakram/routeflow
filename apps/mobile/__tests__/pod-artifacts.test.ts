import {
  asciiToBase64,
  podPhotoArtifactId,
  strokesToSvgDataUrl,
  type SignatureStroke,
} from "../lib/pod-artifacts";

// Mirrors the server's AttachPodArtifactDto.artifactId validation
// (apps/api/src/routes/pod-artifacts.util.ts POD_ARTIFACT_ID_RE).
const SERVER_ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

describe("asciiToBase64", () => {
  it("matches Node's base64 for every padding case", () => {
    for (const input of ["", "a", "ab", "abc", "abcd", '<svg viewBox="0 0 1 1"/>']) {
      expect(asciiToBase64(input)).toBe(Buffer.from(input, "ascii").toString("base64"));
    }
  });
});

describe("strokesToSvgDataUrl", () => {
  const decode = (dataUrl: string) =>
    Buffer.from(dataUrl.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf8");

  it("returns null when nothing drawable was captured", () => {
    expect(strokesToSvgDataUrl([], 300, 140)).toBeNull();
    // a lone tap (single-point stroke) is not a signature
    expect(strokesToSvgDataUrl([[{ x: 10, y: 10 }]], 300, 140)).toBeNull();
  });

  it("renders strokes as SVG paths over a white background", () => {
    const strokes: SignatureStroke[] = [
      [
        { x: 10.04, y: 20 },
        { x: 30, y: 40.06 },
      ],
      [
        { x: 50, y: 60 },
        { x: 70, y: 80 },
        { x: 90, y: 100 },
      ],
    ];

    const dataUrl = strokesToSvgDataUrl(strokes, 300.4, 140);
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);

    const svg = decode(dataUrl!);
    expect(svg).toContain(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="140"`);
    expect(svg).toContain(`viewBox="0 0 300 140"`);
    expect(svg).toContain(`<rect width="300" height="140" fill="#ffffff"/>`);
    // one path per stroke, coords rounded to 1 decimal
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain(`d="M10 20 L30 40.1"`);
    expect(svg).toContain(`d="M50 60 L70 80 L90 100"`);
    expect(svg).toContain(`stroke="#1e293b"`);
  });

  it("drops undrawable strokes but keeps the drawable ones", () => {
    const dataUrl = strokesToSvgDataUrl(
      [
        [{ x: 1, y: 1 }],
        [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
      ],
      100,
      50,
    );
    expect(dataUrl).not.toBeNull();
    expect(decode(dataUrl!).match(/<path /g)).toHaveLength(1);
  });
});

describe("podPhotoArtifactId", () => {
  const A = "data:image/jpeg;base64,/9j/AAAA";
  const B = "data:image/jpeg;base64,/9j/BBBB";

  it("is stable for identical input and distinct for different photos", () => {
    expect(podPhotoArtifactId(A)).toBe(podPhotoArtifactId(A));
    expect(podPhotoArtifactId(A)).not.toBe(podPhotoArtifactId(B));
  });

  it("always satisfies the server's artifact-id validation", () => {
    for (const input of [A, B, "data:", "d", "x".repeat(500_000)]) {
      expect(podPhotoArtifactId(input)).toMatch(SERVER_ARTIFACT_ID_RE);
    }
  });
});
