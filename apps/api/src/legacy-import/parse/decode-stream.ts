import { LegacyParseError, type LegacyIssue } from "./legacy-issue";

/** Anything the decoder can read: one buffer, a Node stream, or any async iterable of chunks. */
export type LegacySource =
  | Buffer
  | Uint8Array
  | AsyncIterable<Buffer | Uint8Array | string>
  | Iterable<Buffer | Uint8Array | string>;

export interface DecodeOptions {
  /** UTF-8 is strict. Windows-1252 only when the caller asks (it re-reads the stored file). */
  encoding?: "utf-8" | "windows-1252";
  onIssue?: (issue: LegacyIssue) => void;
}

function toBuffer(chunk: Buffer | Uint8Array | string): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

async function* chunksOf(source: LegacySource): AsyncGenerator<Buffer> {
  if (source instanceof Uint8Array) {
    yield toBuffer(source);
    return;
  }
  for await (const chunk of source as AsyncIterable<Buffer | Uint8Array | string>) {
    yield toBuffer(chunk);
  }
}

/**
 * Streamed byte decoder. Strips a UTF-8 BOM silently and a lone leading 0xA0 (a stray Windows-1252
 * no-break space glued to the first header cell) with one WARNING issue. Everything else is decoded
 * strictly, so a bad byte fails loud instead of garbling text. Multi-byte characters split across
 * chunks decode intact.
 */
export async function* decodeLegacyBytes(
  source: LegacySource,
  opts: DecodeOptions = {},
): AsyncGenerator<string> {
  const encoding = opts.encoding ?? "utf-8";
  const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
  const decode = (chunk: Buffer | undefined, stream: boolean): string => {
    try {
      return chunk ? decoder.decode(chunk, { stream }) : decoder.decode();
    } catch {
      throw new LegacyParseError("INVALID_UTF8", `The file is not valid ${encoding} text.`);
    }
  };

  let head: Buffer = Buffer.alloc(0);
  let headDone = false;
  for await (const chunk of chunksOf(source)) {
    if (headDone) {
      const text = decode(chunk, true);
      if (text) yield text;
      continue;
    }
    head = Buffer.concat([head, chunk]);
    if (head.length < 3) continue; // need up to 3 bytes to tell a BOM from a stray byte
    headDone = true;
    const text = decode(stripHead(head, opts), true);
    if (text) yield text;
  }
  if (!headDone && head.length > 0) {
    const text = decode(stripHead(head, opts), true);
    if (text) yield text;
  }
  const tail = decode(undefined, false);
  if (tail) yield tail;
}

function stripHead(head: Buffer, opts: DecodeOptions): Buffer {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return head.subarray(3);
  if (head[0] === 0xa0) {
    opts.onIssue?.({
      severity: "WARNING",
      code: "LEADING_BYTE_STRIPPED",
      message: "A stray byte (0xA0) at the start of the file was removed from the first header.",
      recordNo: 1,
      physicalLine: 1,
    });
    return head.subarray(1);
  }
  return head;
}
