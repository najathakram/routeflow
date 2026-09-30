import type { Response } from "express";

/** Resolves when the socket can take more, or when it closed (a `drain` that never comes). */
function drainedOrClosed(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/**
 * Sets the CSV response headers and pipes `csv` to `res` with backpressure. The iterable owns
 * its own failure row (the file itself says "incomplete"); a dropped client stops the reads.
 */
export async function streamCsv(
  res: Response,
  filename: string,
  csv: AsyncIterable<string>,
): Promise<void> {
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  for await (const chunk of csv) {
    if (res.destroyed) return;
    if (!res.write(chunk)) await drainedOrClosed(res);
  }
  res.end();
}
