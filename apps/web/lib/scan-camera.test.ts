import { CAMERA_ATTEMPTS, hasTorch, nudgeFocus, openCamera, setTorch } from "./scan-camera";

function stubGetUserMedia(impl: jest.Mock) {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: impl },
    configurable: true,
  });
}

describe("openCamera", () => {
  afterEach(() => {
    // @ts-expect-error — test-only cleanup of a stubbed browser property
    delete navigator.mediaDevices;
  });

  it("asks for the rear camera at 1080p with a continuous-focus hint first", async () => {
    const stream = {} as MediaStream;
    const gum = jest.fn().mockResolvedValue(stream);
    stubGetUserMedia(gum);

    await expect(openCamera()).resolves.toBe(stream);

    expect(gum).toHaveBeenCalledTimes(1);
    const video = gum.mock.calls[0][0].video;
    expect(video.facingMode).toEqual({ ideal: "environment" });
    expect(video.width).toEqual({ ideal: 1920 });
    expect(video.height).toEqual({ ideal: 1080 });
    expect(video.advanced).toEqual([{ focusMode: "continuous" }]);
  });

  it("never names a deviceId or `exact` — the old enumeration-order guess is gone", () => {
    for (const attempt of CAMERA_ATTEMPTS) {
      const json = JSON.stringify(attempt);
      expect(json).not.toContain("deviceId");
      expect(json).not.toContain("exact");
    }
  });

  it("degrades one rung at a time when the UA rejects the richer constraints", async () => {
    const stream = {} as MediaStream;
    const gum = jest
      .fn()
      .mockRejectedValueOnce(new Error("OverconstrainedError"))
      .mockRejectedValueOnce(new Error("OverconstrainedError"))
      .mockResolvedValueOnce(stream);
    stubGetUserMedia(gum);

    await expect(openCamera()).resolves.toBe(stream);

    expect(gum).toHaveBeenCalledTimes(3);
    // Last rung is the bare rear-camera request — never worse than the pre-fix behaviour.
    expect(gum.mock.calls[2][0]).toEqual({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  });

  it("rethrows the LAST error when every rung fails, so the caller can classify it", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    stubGetUserMedia(jest.fn().mockRejectedValue(denied));

    await expect(openCamera()).rejects.toBe(denied);
  });
});

describe("torch + focus helpers", () => {
  const trackWith = (caps: unknown, applyConstraints = jest.fn().mockResolvedValue(undefined)) =>
    ({ getCapabilities: () => caps, applyConstraints }) as unknown as MediaStreamTrack;

  it("hasTorch is true only when the track reports a torch capability (never on iOS Safari)", () => {
    expect(hasTorch(trackWith({ torch: true }))).toBe(true);
    expect(hasTorch(trackWith({ width: {} }))).toBe(false);
    expect(hasTorch(null)).toBe(false);
    expect(hasTorch({} as MediaStreamTrack)).toBe(false); // no getCapabilities at all
  });

  it("setTorch applies the constraint and reports success", async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    await expect(setTorch(trackWith({ torch: true }, apply), true)).resolves.toBe(true);
    // The base constraints ride along: applyConstraints replaces the set, so dropping them would
    // let the UA fall back to 640x480 the moment the torch turns on.
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ width: { ideal: 1920 }, advanced: [{ torch: true }] }),
    );
  });

  it("setTorch resolves false instead of throwing when the capability lied", async () => {
    const apply = jest.fn().mockRejectedValue(new Error("nope"));
    await expect(setTorch(trackWith({ torch: true }, apply), true)).resolves.toBe(false);
  });

  it("nudgeFocus re-sends the continuous-focus hint and swallows a rejection", async () => {
    const apply = jest.fn().mockRejectedValue(new Error("no focus control"));
    await expect(nudgeFocus(trackWith({}, apply))).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ width: { ideal: 1920 }, advanced: [{ focusMode: "continuous" }] }),
    );
    await expect(nudgeFocus(null)).resolves.toBeUndefined();
  });
});
