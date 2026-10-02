/**
 * B986 scan helper (pure, no fs): finds the reads that put a server/axios message into the UI.
 * Used by the static pin `raw-message-scan.test.ts` and by `toast-no-raw-message.test.ts`.
 */
const RAW_READ =
  /(response\??\.data\??\.(?:message|error|detail)|\bdata\??\.message|\b(?:err|error|e|ex)\??\.message)\b/g;

/** `src` with block and line comments removed (a `//` inside a URL like `https://` is kept). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every raw message read in `src`, in order (comments excluded). */
export function rawMessageReads(src: string): string[] {
  return [...stripComments(src).matchAll(RAW_READ)].map((m) => m[0]);
}
