/** B941: pins which upload failures are retried (client-side transient) vs failures (server refusal). */
import { classifyUploadFailure as c } from "./helpers/upload-retry";

describe("classifyUploadFailure", () => {
  it.each([
    ["EMFILE", "connect"],
    ["EADDRINUSE", "connect"],
    ["ETIMEDOUT", "connect"],
    ["ECONNRESET", "connect"],
    ["ECONNRESET", "pre-write"],
  ] as const)("%s (%s) before any byte was written is retried", (code, phase) => {
    expect(c(code, phase)).toBe("retried-client-transient");
  });

  it.each([
    ["ECONNREFUSED", "connect"],
    ["ECONNREFUSED", "pre-write"],
    ["HTTP_4XX_5XX", "mid-upload"],
    ["HTTP_4XX_5XX", "connect"],
    ["ECONNRESET", "mid-upload"],
    ["EPIPE", "mid-upload"],
    ["ETIMEDOUT", "mid-upload"],
    ["EMFILE", "mid-upload"],
  ] as const)("%s (%s) is a server refusal and is never retried", (code, phase) => {
    expect(c(code, phase)).toBe("server-refusal");
  });

  it.each([
    ["EPIPE", "pre-write"],
    ["ENOBUFS", "connect"],
    ["TIMEOUT", "pre-write"],
    ["ETIMEDOUT", "pre-write"],
  ] as const)("%s (%s) stays `other` and fails", (code, phase) => {
    expect(c(code, phase)).toBe("other");
  });
});
